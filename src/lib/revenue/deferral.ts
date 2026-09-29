import type { Prisma } from "@prisma/client";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/chart";
import { firstOpenDate } from "@/lib/ledger/period";
import type { DraftLine } from "@/lib/ledger/posting";
import { moduleEntitled } from "@/lib/entitlements";
import { currentTenantOrNull } from "@/lib/tenancy/resolve";
import {
  dayDate,
  defers,
  lineRupees,
  monthDate,
  monthKeyAt,
  periodOf,
  replan,
  round2,
  spreadByDay,
  spreadEvenly,
  type DayKey,
  type DeferralKind,
} from "@/lib/revenue/periods";
import {
  NARRATION,
  dropUnposted,
  firstReplannableMonth,
  loadStates,
  lockSchedules,
  movedByHandOf,
  tagKey,
  unrecognisedOf,
  writeUnposted,
  type ScheduleState,
} from "@/lib/revenue/state";

/**
 * Where Revenue & Close meets the posting of a document: an invoice's deferral when it is issued, a
 * credit note's reduction of it, and what cancelling either does to the schedules.
 *
 * Called by src/lib/ledger/journal.ts inside the document's own transaction, so a document is never
 * issued or cancelled without its schedules following, and never the other way round. Nothing here
 * writes a journal entry: it plans, changes schedules, and hands journal.ts the lines to write — which
 * keeps this module free of journal.ts, and the ledger's write door the only one.
 */

type Tx = Prisma.TransactionClient;

export const REVENUE_MODULE = "revenue_close";

/** A posting engine line with the branch, GSTIN and customer it goes under. */
export type TaggedLine = DraftLine & { branchId: string | null; gstRegistrationId: string | null };

/** An entry for journal.ts to write under `source: REVENUE`. */
export type RevenueEntryDraft = { date: Date; narration: string; companyId: string | null; lines: TaggedLine[] };

/**
 * Whether new deferrals are made: `moduleAvailableForTenant("revenue_close")` — in the workspace's
 * plan, and not switched off — asked through the posting's own transaction.
 *
 * The same two questions as src/lib/modules-access.ts, not an import of it: that module reaches the
 * session and next-auth, which the ledger — posted from scripts, the demo seed and the repair — must
 * not load. check:revenue asserts the two agree. Work with no workspace at all (a script outside
 * `runAsTenant`) defers nothing and posts as it always has.
 *
 * Only *new* deferrals ask. A credit note, a cancellation and the run act on schedules that exist
 * whatever the plan says now, so deferred revenue is never stranded on the balance sheet.
 */
export async function revenueAddonOn(tx: Pick<Tx, "systemModule">): Promise<boolean> {
  const tenant = await currentTenantOrNull();
  if (!tenant || !moduleEntitled(tenant.entitlements, tenant.country, REVENUE_MODULE)) return false;
  const row = await tx.systemModule.findUnique({ where: { key: REVENUE_MODULE }, select: { enabled: true } });
  return row?.enabled ?? true;
}

// ─── Issuing an invoice ──────────────────────────────────────────────────────────────────────────

export type PlannedSchedule = {
  lineId: string;
  itemId: string | null;
  companyProductId: string | null;
  billingMilestoneId: string | null;
  kind: DeferralKind;
  /** Rupees, the line's share of the invoice's revenue at the invoice's rate. */
  amount: number;
  startDate: DayKey | null;
  endDate: DayKey | null;
};

export type DeferralPlan = { deferred: number; schedules: PlannedSchedule[] };

/**
 * Which of an invoice's lines defer, and by how much, in rupees — or null when none does, or the
 * add-on is off, and the invoice posts exactly as it always has.
 *
 * `revenueRupees` is the invoice's revenue as its entry books it (taxable value less freight, at the
 * invoice's rate); each line's share of it is in proportion to its taxable value (`lineRupees`), so a
 * foreign invoice defers at its own rate and an invoice whose every line defers leaves Sales at nil.
 */
export async function planInvoiceDeferral(
  tx: Tx,
  doc: { id: string; issueDate: Date },
  revenueRupees: number,
): Promise<DeferralPlan | null> {
  if (!(revenueRupees > 0)) return null;
  if (!(await revenueAddonOn(tx))) return null;

  const lines = await tx.tradeDocumentLine.findMany({
    where: { documentId: doc.id },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    select: {
      id: true,
      taxableValue: true,
      servicePeriodFrom: true,
      servicePeriodTo: true,
      billingMilestoneId: true,
      companyProductId: true,
      itemId: true,
      item: { select: { type: true, revenuePattern: true } },
      billingMilestone: { select: { deliveryMilestoneId: true, deliveryMilestone: { select: { completedAt: true } } } },
    },
  });
  if (lines.length === 0) return null;

  const shares = lineRupees(revenueRupees, lines.map((l) => Number(l.taxableValue)));
  const schedules: PlannedSchedule[] = [];
  lines.forEach((line, i) => {
    const milestone = line.billingMilestone
      ? { deliveryMilestoneId: line.billingMilestone.deliveryMilestoneId, deliveryCompletedAt: line.billingMilestone.deliveryMilestone?.completedAt ?? null }
      : null;
    const kind = defers(line, line.item, doc.issueDate, milestone);
    // A discount line, or one at nil, has nothing to defer.
    if (!kind || !(shares[i] > 0)) return;
    const period = kind === "RATABLE" ? periodOf(line) : null;
    schedules.push({
      lineId: line.id,
      itemId: line.itemId,
      companyProductId: line.companyProductId,
      billingMilestoneId: kind === "MILESTONE" ? line.billingMilestoneId : null,
      kind,
      amount: shares[i],
      startDate: period?.from ?? null,
      endDate: period?.to ?? null,
    });
  });
  if (schedules.length === 0) return null;
  return { deferred: round2(schedules.reduce((t, s) => t + s.amount, 0)), schedules };
}

/** Whether new schedules spread evenly by month (D3's setting) — off unless somebody turned it on. */
export async function spreadEvenlySetting(tx: Pick<Tx, "revenueCloseSettings">): Promise<boolean> {
  const settings = await tx.revenueCloseSettings.findUnique({ where: { id: "global" }, select: { spreadEvenly: true } });
  return settings?.spreadEvenly ?? false;
}

/**
 * One schedule per deferring line, ACTIVE at once — built from the document's own period, so nobody
 * needs to approve it (D2) — made by whoever issued the invoice, under the invoice's branch and GSTIN.
 * A RATABLE schedule gets its months now; a MILESTONE one gets its single month when it is earned.
 *
 * `lineId` is unique, so a line can never have two: a second attempt fails the whole issue rather
 * than deferring the same revenue twice. It never gets that far — posting an invoice that is already
 * posted returns before planning.
 */
export async function createInvoiceSchedules(
  tx: Tx,
  doc: { id: string; companyId: string },
  plan: DeferralPlan,
  by: { userId: string; branchId: string | null; gstRegistrationId: string | null },
): Promise<string[]> {
  const evenly = await spreadEvenlySetting(tx);
  const ids: string[] = [];
  for (const s of plan.schedules) {
    const months =
      s.kind === "RATABLE" ? (evenly ? spreadEvenly : spreadByDay)(s.amount, s.startDate!, s.endDate!).filter((m) => m.amount > 0) : [];
    const created = await tx.revenueSchedule.create({
      data: {
        documentId: doc.id,
        lineId: s.lineId,
        companyId: doc.companyId,
        itemId: s.itemId,
        companyProductId: s.companyProductId,
        billingMilestoneId: s.billingMilestoneId,
        kind: s.kind,
        status: "ACTIVE",
        amount: s.amount,
        startDate: s.startDate ? dayDate(s.startDate) : null,
        endDate: s.endDate ? dayDate(s.endDate) : null,
        spreadEvenly: evenly,
        branchId: by.branchId,
        gstRegistrationId: by.gstRegistrationId,
        createdById: by.userId,
        lines: { create: months.map((m) => ({ month: monthDate(m.month), amount: m.amount })) },
      },
      select: { id: true },
    });
    ids.push(created.id);
  }
  return ids;
}

// ─── Issuing a credit note ───────────────────────────────────────────────────────────────────────

export type CreditPlan = { total: number; reductions: { state: ScheduleState; amount: number }[] };

/**
 * What a credit note takes off its invoice's schedules, in rupees — or null when the invoice has none
 * with anything left, and the credit note posts as it always has.
 *
 * Its revenue (at its own rate) is shared across the invoice's lines in proportion to each line's
 * taxable value: credit-note lines don't point at invoice lines, so proportion is the only rule. A
 * deferring line's share comes off its schedule's unrecognised balance first, up to that balance; the
 * rest, and every other line's share, is a sales return as before.
 *
 * Not gated on the add-on: schedules that exist must follow their invoice whatever the plan says now.
 * The schedules are locked here, for the rest of the credit note's transaction.
 */
export async function planCreditReduction(
  tx: Tx,
  cn: { againstDocumentId: string | null },
  creditRupees: number,
): Promise<CreditPlan | null> {
  if (!cn.againstDocumentId || !(creditRupees > 0)) return null;
  const ids = (
    await tx.revenueSchedule.findMany({ where: { documentId: cn.againstDocumentId, lineId: { not: null } }, select: { id: true } })
  ).map((s) => s.id);
  if (ids.length === 0) return null;

  await lockSchedules(tx, ids);
  const states = await loadStates(tx, ids);
  const byLine = new Map([...states.values()].map((s) => [s.lineId, s]));
  const lines = await tx.tradeDocumentLine.findMany({
    where: { documentId: cn.againstDocumentId },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    select: { id: true, taxableValue: true },
  });
  const shares = lineRupees(creditRupees, lines.map((l) => Number(l.taxableValue)));

  const reductions: CreditPlan["reductions"] = [];
  lines.forEach((line, i) => {
    const state = byLine.get(line.id);
    if (!state) return;
    const amount = round2(Math.min(Math.max(shares[i], 0), unrecognisedOf(state)));
    if (amount > 0) reductions.push({ state, amount });
  });
  if (reductions.length === 0) return null;
  return { total: round2(reductions.reduce((t, r) => t + r.amount, 0)), reductions };
}

/**
 * Records what the credit note took off each schedule, and re-plans what is left: the unposted months
 * shrink in proportion. A schedule credited to nil is CANCELLED, its unposted months gone.
 */
export async function applyCreditReduction(tx: Tx, creditNoteId: string, plan: CreditPlan): Promise<void> {
  for (const { state, amount } of plan.reductions) {
    await tx.revenueScheduleAdjustment.create({ data: { scheduleId: state.id, documentId: creditNoteId, amount } });
    const remaining = round2(unrecognisedOf(state) - amount);
    if (remaining <= 0) {
      await dropUnposted(tx, [state.id]);
      await tx.revenueSchedule.update({ where: { id: state.id }, data: { status: "CANCELLED" } });
      continue;
    }
    const unposted = state.lines.filter((l) => !l.posted);
    // A MILESTONE schedule not yet earned has no month to re-plan: its month is made at amount less
    // what was credited, when it is.
    if (unposted.length === 0) continue;
    const from = unposted.map((l) => l.month).sort()[0];
    await writeUnposted(tx, state, replan(unposted, remaining, from));
  }
}

// ─── Cancelling ──────────────────────────────────────────────────────────────────────────────────

async function openDate(tx: Tx, now: Date): Promise<Date> {
  const lock = await tx.ledgerLock.findUnique({ where: { id: "global" }, select: { lockedUntil: true } });
  return firstOpenDate(now, lock?.lockedUntil);
}

/** A line on whichever side its sign says, tagged; nothing when it is nil. */
function signed(
  lines: TaggedLine[],
  account: TaggedLine["account"],
  amount: number,
  positiveSide: "debit" | "credit",
  tags: { branchId: string | null; gstRegistrationId: string | null; companyId: string | null },
  narration?: string,
) {
  const value = round2(amount);
  if (value === 0) return;
  const onDebit = positiveSide === "debit" ? value > 0 : value < 0;
  const magnitude = Math.abs(value);
  lines.push({
    account,
    debit: onDebit ? magnitude : 0,
    credit: onDebit ? 0 : magnitude,
    companyId: tags.companyId ?? undefined,
    branchId: tags.branchId,
    gstRegistrationId: tags.gstRegistrationId,
    narration,
  });
}

/**
 * An invoice with schedules is cancelled. `reverseDocumentPosting` has just reversed its entry — the
 * Deferred Revenue it credited included — so this undoes what the schedules did since, per branch,
 * GSTIN and customer:
 *
 *   · what they moved into Sales (months recognised, a hand cancellation, a re-measure) comes back
 *     out of Sales: Dr Sales, Cr Deferred Revenue;
 *   · what credit notes took off them becomes part of those credit notes' sales return — the invoice
 *     they reduced is gone: Dr Sales Returns, Cr Deferred Revenue.
 *
 * Measured, not re-traced: per group, the invoice's deferral (`originalLines`' Deferred Revenue credit)
 * less what the schedules still hold is exactly what went out of Deferred Revenue since, so the two
 * entries together leave it — and Sales — as though the invoice had never been issued.
 *
 * The schedules become CANCELLED and their unposted months are deleted. Returns the entry to write,
 * dated in the first open period, or null when nothing had moved.
 */
export async function onInvoiceCancelled(
  tx: Tx,
  doc: { id: string; docNumber: string; companyId: string | null },
  originalLines: { accountId: string; debit: number; credit: number; branchId: string | null; gstRegistrationId: string | null; companyId: string | null }[],
  now: Date = new Date(),
): Promise<RevenueEntryDraft | null> {
  const ids = (await tx.revenueSchedule.findMany({ where: { documentId: doc.id }, select: { id: true } })).map((s) => s.id);
  if (ids.length === 0) return null;
  await lockSchedules(tx, ids);
  const states = [...(await loadStates(tx, ids)).values()];

  type Group = { branchId: string | null; gstRegistrationId: string | null; companyId: string | null; deferred: number; held: number; credited: number };
  const groups = new Map<string, Group>();
  const group = (t: { branchId: string | null; gstRegistrationId: string | null; companyId: string | null }) => {
    const key = tagKey(t);
    let g = groups.get(key);
    if (!g) {
      g = { branchId: t.branchId, gstRegistrationId: t.gstRegistrationId, companyId: t.companyId, deferred: 0, held: 0, credited: 0 };
      groups.set(key, g);
    }
    return g;
  };

  const deferredAccount = await tx.ledgerAccount.findFirst({ where: { systemKey: SYSTEM_ACCOUNTS.DEFERRED_REVENUE }, select: { id: true } });
  for (const l of originalLines) {
    if (l.accountId !== deferredAccount?.id) continue;
    const g = group({ branchId: l.branchId, gstRegistrationId: l.gstRegistrationId, companyId: l.companyId ?? doc.companyId });
    g.deferred = round2(g.deferred + l.credit - l.debit);
  }
  for (const s of states) {
    const g = group(s);
    g.held = round2(g.held + unrecognisedOf(s));
    g.credited = round2(g.credited + s.credited);
  }

  await dropUnposted(tx, ids);
  await tx.revenueSchedule.updateMany({ where: { id: { in: ids }, status: { not: "CANCELLED" } }, data: { status: "CANCELLED" } });

  const lines: TaggedLine[] = [];
  for (const g of groups.values()) {
    const out = round2(g.deferred - g.held);
    signed(lines, SYSTEM_ACCOUNTS.DEFERRED_REVENUE, out, "credit", g);
    signed(lines, SYSTEM_ACCOUNTS.SALES_RETURNS, g.credited, "debit", g, "Credited before it was earned — now a return");
    signed(lines, SYSTEM_ACCOUNTS.SALES, round2(out - g.credited), "debit", g, "Recognised before the invoice was cancelled");
  }
  if (lines.length === 0) return null;
  return {
    date: await openDate(tx, now),
    narration: `${NARRATION.invoiceCancelled}invoice ${doc.docNumber} cancelled (${states.length} schedule${states.length === 1 ? "" : "s"})`,
    companyId: doc.companyId,
    lines,
  };
}

/**
 * A credit note that reduced schedules is cancelled. `reverseDocumentPosting` has just put back the
 * Deferred Revenue it took, so each schedule gets its share back:
 *
 *   · on a live, completed or credited-to-nil schedule, onto its unposted months (in proportion, or
 *     spread over what is left of its period when it has none), and a CANCELLED or COMPLETED one
 *     becomes ACTIVE again;
 *   · on a schedule whose invoice was cancelled since, there is nothing to put it back onto — the
 *     invoice's cancellation made that share a sales return, so it is taken back out of returns;
 *   · on a schedule cancelled by hand, whose rest was recognised at once, the share is recognised
 *     now too.
 *
 * Each adjustment gets `reversedAt`. Returns the entry the last two need, or null.
 */
export async function onCreditNoteCancelled(
  tx: Tx,
  creditNote: { id: string; docNumber: string },
  now: Date = new Date(),
): Promise<RevenueEntryDraft | null> {
  const adjustments = await tx.revenueScheduleAdjustment.findMany({
    where: { documentId: creditNote.id, reversedAt: null },
    select: { id: true, amount: true, scheduleId: true, schedule: { select: { document: { select: { status: true } } } } },
  });
  if (adjustments.length === 0) return null;
  const ids = adjustments.map((a) => a.scheduleId);
  await lockSchedules(tx, ids);
  const states = await loadStates(tx, ids);

  const lines: TaggedLine[] = [];
  let companyId: string | null = null;
  for (const adjustment of adjustments) {
    const state = states.get(adjustment.scheduleId);
    if (!state) continue;
    const amount = Number(adjustment.amount);
    const reversed = await tx.revenueScheduleAdjustment.updateMany({ where: { id: adjustment.id, reversedAt: null }, data: { reversedAt: now } });
    if (reversed.count !== 1) continue;
    companyId = state.companyId;

    if (state.status === "CANCELLED" && adjustment.schedule.document?.status === "CANCELLED") {
      signed(lines, SYSTEM_ACCOUNTS.DEFERRED_REVENUE, amount, "debit", state);
      signed(lines, SYSTEM_ACCOUNTS.SALES_RETURNS, amount, "credit", state, "Credit note cancelled after its invoice");
      continue;
    }
    if (state.status === "CANCELLED" && movedByHandOf(state) > 0) {
      signed(lines, SYSTEM_ACCOUNTS.DEFERRED_REVENUE, amount, "debit", state);
      signed(lines, SYSTEM_ACCOUNTS.SALES, amount, "credit", state, "Its schedule was cancelled; recognised now");
      continue;
    }

    const hasMonths = state.lines.length > 0 || state.kind === "RATABLE";
    if (hasMonths) {
      const unposted = state.lines.filter((l) => !l.posted);
      const held = state.status === "ACTIVE" || state.status === "PENDING_APPROVAL" ? unrecognisedOf(state) : 0;
      const from = firstReplannableMonth(state, monthKeyAt(now));
      const period = state.kind === "RATABLE" && state.startDate && state.endDate
        ? { from: state.startDate, to: state.endDate, evenly: state.spreadEvenly, skip: state.lines.filter((l) => l.posted).map((l) => l.month) }
        : undefined;
      await writeUnposted(tx, state, replan(held > 0 ? unposted : [], round2(held + amount), from, period));
    }
    if (state.status === "CANCELLED" || state.status === "COMPLETED") {
      await tx.revenueSchedule.update({ where: { id: state.id }, data: { status: "ACTIVE" } });
    }
  }
  if (lines.length === 0) return null;
  const toReturns = lines.some((l) => l.account === SYSTEM_ACCOUNTS.SALES_RETURNS);
  return {
    date: await openDate(tx, now),
    narration: `${toReturns ? NARRATION.creditRestored : NARRATION.restoredRecognised}credit note ${creditNote.docNumber} cancelled`,
    companyId,
    lines,
  };
}

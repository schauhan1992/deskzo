import type { CommissionKind, Prisma, StatementStatus } from "@deskzo/control-client";
import { formatMoney } from "@/lib/billing/money";
import { dayMonthYear, istDayKey, istMonthKey, monthLabel } from "@/lib/console-shared/format";
import { istDateParts, istMidnight } from "@/lib/india-time";
import { partnerAudit, type PartnerActor } from "@/lib/partners/audit";
import { PARTNER_ROUTES } from "@/lib/partners/nav";
import { cleanId, mailPartnerUsers, manyLines, meActor, requiredText, staffActor } from "@/lib/partners/registry";
import { twoPersonPayout } from "@/lib/partners/settings";
import { istDayStart, startOfIstToday } from "@/lib/partners/terms";
import { PARTNER_MONEY, PartnerRefused, percentToBp, type PartnerMe, type PayoutMask, type TaxLine, type TaxLineInput } from "@/lib/partners/types";
import { partnerOrigin } from "@/lib/partners/users";
import { controlDb } from "@/lib/platform/control-db";
import { withPlatformLease } from "@/lib/platform/fanout";
import type { Staff } from "@/lib/platform/staff-session";

/**
 * Partner statements (partner_statements, spec §6): what a payout is made against — one month's
 * commission for one partner in one currency.
 *
 *   · Generation drafts last IST month's statements, under a platform lease: every unattached PENDING
 *     entry earned before the month's end, plus the pending reversals of those (a refund seen before
 *     the statement nets out on it). A net total ≤ 0 is not drafted — it rolls into the next month.
 *     The tick does it once the IST day reaches `partners.statementDay`; staff may on any day.
 *   · DRAFT → APPROVED (staff's tax lines and net payable; payout details required; entries
 *     APPROVED) → PAID (a reference and the IST day it was paid; entries PAID) — or VOID from DRAFT
 *     or APPROVED (entries go back to PENDING, unattached, for the next statement). PAID is final.
 *   · With `partners.twoPersonPayout` on (owner decision O4), whoever approved a statement cannot also
 *     mark it paid.
 *
 * Staff-facing functions take the staff member and write the partner audit; the console actions write
 * the platform audit. The tick's generation writes its own platform audit row (SYSTEM "tick").
 * Refusals are PartnerRefused. Sums are BigInt minor units, never added across currencies.
 */

const STATEMENT_LEASE_MS = 10 * 60_000;
const AUTO_VOID_REASON = "Nothing left to pay after an entry was voided.";
const MAX_TAX_LINES = 6;
/** A tax line's amount, at most — far beyond any real statement, well inside a safe integer. */
const MAX_TAX_AMOUNT = 1_000_000_000_000;
const REGISTERED_KINDS = new Set(["GSTIN", "VAT", "GST"]);
const CHUNK = 1000;

type Tx = Prisma.TransactionClient;

// ─── Pure helpers ────────────────────────────────────────────────────────────────────────────────

/** The IST month before `now`'s: "2026-08" from 1 August 00:00 IST to 1 September 00:00 IST (half-open). */
export function previousIstMonth(now: Date): { period: string; start: Date; end: Date } {
  const { year, month } = istDateParts(now);
  const start = istMidnight(year, month - 1, 1);
  return { period: istMonthKey(start), start, end: istMidnight(year, month, 1) };
}

export type StatementSums = { entryCount: number; earned: bigint; reversed: bigint; adjustments: bigint; total: bigint };

/** A statement's sums from its entries: accruals, reversals (≤ 0), adjustments, and their total. */
export function statementSums(entries: { kind: CommissionKind; amount: number; reversesId: string | null }[]): StatementSums {
  let earned = BigInt(0);
  let reversed = BigInt(0);
  let adjustments = BigInt(0);
  for (const e of entries) {
    const amount = BigInt(Math.trunc(e.amount));
    if (e.kind === "ADJUSTMENT") adjustments += amount;
    else if (e.reversesId) reversed += amount;
    else earned += amount;
  }
  return { entryCount: entries.length, earned, reversed, adjustments, total: earned + reversed + adjustments };
}

/** "<SLUG>-<YYYY-MM>-<CUR>", upper case. */
export function statementNumberBase(slug: string, period: string, currency: string): string {
  return `${slug}-${period}-${currency}`.toUpperCase();
}

/** The base number, or "-2", "-3"… after it when void statements already hold the earlier ones. */
export function nextStatementNumber(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Net payable: the total, plus the ADD lines, less the WITHHOLD lines. */
export function netPayableOf(total: bigint, taxLines: TaxLine[]): bigint {
  return taxLines.reduce((net, line) => (line.kind === "ADD" ? net + BigInt(line.amount) : net - BigInt(line.amount)), total);
}

type TaxLineDraft = { label: string; kind: "ADD" | "WITHHOLD"; rateBp: number | null; amount: number | null };

/** Staff's tax lines, checked (spec §6.2): at most six; a label, ADD or WITHHOLD, a rate and/or an amount. */
function cleanTaxLines(raw: unknown): TaxLineDraft[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new PartnerRefused("Tax lines are a list.");
  if (raw.length > MAX_TAX_LINES) throw new PartnerRefused(`A statement has at most ${MAX_TAX_LINES} tax lines.`);
  return raw.map((line: unknown, i) => {
    const x = (line && typeof line === "object" ? line : {}) as Record<string, unknown>;
    const n = i + 1;
    const label = requiredText(x.label, 2, 60, `Tax line ${n}: give it a label of 2 to 60 characters.`);
    if (x.kind !== "ADD" && x.kind !== "WITHHOLD") throw new PartnerRefused(`Tax line ${n}: it is either added to the payment or withheld from it.`);
    const rateText = x.rate === null || x.rate === undefined ? "" : String(x.rate).trim();
    const rateBp = rateText ? percentToBp(rateText) : null;
    if (rateText && rateBp === null) throw new PartnerRefused(`Tax line ${n}: the rate is a percentage from 0 to 100, with at most two decimals.`);
    let amount: number | null = null;
    if (!(x.amount === null || x.amount === undefined || (typeof x.amount === "string" && x.amount.trim() === ""))) {
      const a = typeof x.amount === "number" ? x.amount : typeof x.amount === "string" && /^\s*\d{1,13}\s*$/.test(x.amount) ? Number(x.amount.trim()) : NaN;
      if (!Number.isSafeInteger(a) || a < 0 || a > MAX_TAX_AMOUNT) throw new PartnerRefused(`Tax line ${n}: the amount is a whole number of the currency's smallest unit (paise, cents), zero or more.`);
      amount = a;
    }
    if (amount === null && rateBp === null) throw new PartnerRefused(`Tax line ${n}: give an amount or a rate.`);
    return { label, kind: x.kind, rateBp, amount };
  });
}

const minor = (n: bigint | number): number => Number(n);

function lockStatement(tx: Tx, id: string) {
  return tx.$queryRaw<{ id: string }[]>`SELECT id FROM partner_statements WHERE id = ${id} FOR UPDATE`;
}

/**
 * Who a generation run is, for the partner audit: the tick, the command line (`npm run partners --
 * statements`, which writes its own platform audit row), or the staff member named by `by` ("staff:<id>").
 */
async function generationActor(by: string, staff: Staff | undefined): Promise<PartnerActor> {
  if (by === "tick") return { kind: "system", name: "tick" };
  if (by === "script") return { kind: "script" };
  if (staff && `staff:${staff.id}` === by) return staffActor(staff);
  const id = by.slice("staff:".length);
  const person = await controlDb().platformUser.findUnique({ where: { id }, select: { id: true, name: true } });
  return { kind: "staff", id, name: person?.name ?? id };
}

// ─── Generation ──────────────────────────────────────────────────────────────────────────────────

export type StatementsRun = {
  /** The IST month covered, "2026-08". */
  period: string;
  /** Statements drafted. */
  made: number;
  /** Partners that got at least one. */
  partners: number;
  numbers: string[];
  /** Statements that could not be drafted (logged; their entries stay unattached). */
  failed: number;
};

const CANDIDATE_SELECT = { id: true, partnerId: true, currency: true, kind: true, amount: true, reversesId: true } as const satisfies Prisma.CommissionEntrySelect;
type Candidate = Prisma.CommissionEntryGetPayload<{ select: typeof CANDIDATE_SELECT }>;

const SNAPSHOT_SELECT = {
  slug: true,
  legalName: true,
  displayName: true,
  country: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  region: true,
  postalCode: true,
  taxIds: true,
  payoutMask: true,
} as const satisfies Prisma.PartnerSelect;

function snapshotOf(p: Prisma.PartnerGetPayload<{ select: typeof SNAPSHOT_SELECT }>) {
  return {
    legalName: p.legalName,
    displayName: p.displayName,
    country: p.country,
    address: { line1: p.addressLine1, line2: p.addressLine2, city: p.city, region: p.region, postalCode: p.postalCode },
    taxIds: p.taxIds,
    payout: p.payoutMask ?? null,
  };
}

/**
 * Drafts last IST month's statements (spec §6.1): for every (partner, currency) with candidates, when
 * no live statement exists for the period and the candidates add up to more than zero. `by` is "tick"
 * or "staff:<id>" (pass `staff` too, to name them in the partner audit). `partnerId`: that partner only.
 * Refused while another run holds the lease.
 */
export async function generateStatements(now: Date, opts: { by: string; partnerId?: string | null; staff?: Staff }): Promise<StatementsRun> {
  const by = String(opts?.by ?? "").trim().slice(0, 60);
  if (by !== "tick" && by !== "script" && !/^staff:[^\s]+$/.test(by)) throw new PartnerRefused("Say who is generating the statements.");
  const ran = await withPlatformLease("partner-statements", STATEMENT_LEASE_MS, () => generate(now, by, opts));
  if (!ran.ran) throw new PartnerRefused("Statements are being generated right now.");
  return ran.value;
}

async function generate(now: Date, by: string, opts: { partnerId?: string | null; staff?: Staff }): Promise<StatementsRun> {
  const control = controlDb();
  const { period, start, end } = previousIstMonth(now);
  const only = opts.partnerId ? { partnerId: cleanId(opts.partnerId) } : {};

  const earned = await control.commissionEntry.findMany({ where: { ...only, status: "PENDING", statementId: null, earnedAt: { lt: end } }, select: CANDIDATE_SELECT });
  const byId = new Map<string, Candidate>(earned.map((e) => [e.id, e]));
  // A refund seen before generation nets out on the same statement, whenever it was seen.
  const accrualIds = earned.filter((e) => e.kind !== "ADJUSTMENT" && e.reversesId === null).map((e) => e.id);
  for (let i = 0; i < accrualIds.length; i += CHUNK) {
    const reversals = await control.commissionEntry.findMany({
      where: { status: "PENDING", statementId: null, reversesId: { in: accrualIds.slice(i, i + CHUNK) } },
      select: CANDIDATE_SELECT,
    });
    for (const r of reversals) byId.set(r.id, r);
  }

  const groups = new Map<string, { partnerId: string; currency: string; entries: Candidate[] }>();
  for (const e of byId.values()) {
    const key = `${e.partnerId}|${e.currency}`;
    const group = groups.get(key) ?? { partnerId: e.partnerId, currency: e.currency, entries: [] };
    group.entries.push(e);
    groups.set(key, group);
  }

  let actor: PartnerActor | null = null;
  const numbers: string[] = [];
  const partners = new Set<string>();
  let failed = 0;
  for (const { partnerId, currency, entries } of groups.values()) {
    const live = await control.partnerStatement.findFirst({ where: { partnerId, currency, period, status: { not: "VOID" } }, select: { id: true } });
    if (live) continue;
    const sums = statementSums(entries);
    if (sums.total <= BigInt(0)) continue;
    const ids = entries.map((e) => e.id);
    const who = actor ?? (actor = await generationActor(by, opts.staff));
    try {
      const number = await control.$transaction(
        async (tx) => {
          const partner = await tx.partner.findUnique({ where: { id: partnerId }, select: SNAPSHOT_SELECT });
          if (!partner) throw new Error("the partner no longer exists");
          const base = statementNumberBase(partner.slug, period, currency);
          const taken = await tx.partnerStatement.findMany({ where: { OR: [{ number: base }, { number: { startsWith: `${base}-` } }] }, select: { number: true } });
          const number = nextStatementNumber(base, taken.map((t) => t.number));
          const statement = await tx.partnerStatement.create({
            data: {
              number,
              partnerId,
              currency,
              period,
              periodStart: start,
              periodEnd: end,
              status: "DRAFT",
              ...sums,
              taxLines: [],
              netPayable: sums.total,
              partnerSnapshot: snapshotOf(partner) as Prisma.InputJsonValue,
              generatedAt: now,
              generatedBy: by,
            },
            select: { id: true },
          });
          // Under the lease nothing else attaches entries, so a different count is a bug: nothing is kept.
          const attached = await tx.commissionEntry.updateMany({ where: { id: { in: ids }, statementId: null, status: "PENDING" }, data: { statementId: statement.id } });
          if (attached.count !== ids.length) throw new Error(`${attached.count} of ${ids.length} entries could be attached`);
          await partnerAudit(who, partnerId, "statement.generate", "statement", statement.id, { statement: number, period, currency, total: minor(sums.total) }, { tx, visibleToPartner: false });
          return number;
        },
        { timeout: 60_000 },
      );
      numbers.push(number);
      partners.add(partnerId);
    } catch (err) {
      failed += 1;
      console.error(`[partners] statement for partner ${partnerId} ${currency} ${period} failed: ${err instanceof Error ? err.message.split("\n")[0].slice(0, 300) : "error"}`);
    }
  }

  // The staff's run is audited by the console action; the tick's by itself — only when it did something.
  if (by === "tick" && numbers.length) {
    await control.platformAuditLog.create({
      data: { actorKind: "SYSTEM", actor: "tick", action: "partner.statements.generate", detail: { period, made: numbers.length, partners: partners.size } },
      select: { id: true },
    });
  }
  return { period, made: numbers.length, partners: partners.size, numbers, failed };
}

// ─── Approval, payment, void ─────────────────────────────────────────────────────────────────────

/** What the console action needs for its platform audit and its answer. Amounts in minor units. */
export type StatementDecided = {
  id: string;
  number: string;
  partnerId: string;
  partnerSlug: string;
  currency: string;
  period: string;
  status: StatementStatus;
  total: number;
  netPayable: number;
};

const DECIDE_SELECT = {
  id: true,
  number: true,
  partnerId: true,
  status: true,
  currency: true,
  period: true,
  total: true,
  netPayable: true,
  approvedAt: true,
  approvedBy: true,
  partnerSnapshot: true,
  partner: { select: { slug: true, payoutMask: true, taxIds: true } },
} as const satisfies Prisma.PartnerStatementSelect;

async function statementForUpdate(tx: Tx, statementId: string) {
  const id = cleanId(statementId);
  if (!id || !(await lockStatement(tx, id))[0]) throw new PartnerRefused("That statement no longer exists.");
  return tx.partnerStatement.findUniqueOrThrow({ where: { id }, select: DECIDE_SELECT });
}

const statusRefusal = (status: StatementStatus): string =>
  status === "VOID" ? "That statement is void." : status === "PAID" ? "That statement has been paid." : status === "APPROVED" ? "That statement has been approved already." : "That statement is still a draft.";

const statementLink = (number: string) => `${partnerOrigin()}${PARTNER_ROUTES.statement(number)}`;

/**
 * Approves a DRAFT (spec §6.2; console PAYERS): the partner must have payout details on file; the sums
 * are worked out again from its entries (all still PENDING); the tax lines give the net payable, which
 * must be more than zero; the snapshot's payout mask is refreshed. Its entries become APPROVED. The
 * partner's ADMIN and FINANCE users are emailed.
 */
export async function approveStatement(statementId: string, input: { taxLines?: TaxLineInput[] | null }, staff: Staff, now: Date = new Date()): Promise<StatementDecided> {
  const drafts = cleanTaxLines(input?.taxLines);
  const result = await controlDb().$transaction(async (tx) => {
    const st = await statementForUpdate(tx, statementId);
    if (st.status !== "DRAFT") throw new PartnerRefused(statusRefusal(st.status));
    const mask = st.partner.payoutMask as PayoutMask | null;
    if (!mask) throw new PartnerRefused("No payout details on file for this partner.");
    const entries = await tx.commissionEntry.findMany({ where: { statementId: st.id }, select: { kind: true, amount: true, reversesId: true, status: true } });
    if (!entries.length || entries.some((e) => e.status !== "PENDING")) throw new PartnerRefused("This statement's entries have changed. Void it and generate it again.");
    const sums = statementSums(entries);
    if (sums.total <= BigInt(0)) throw new PartnerRefused("There is nothing to pay on this statement. Void it instead.");
    const taxLines: TaxLine[] = drafts.map((d) => ({
      label: d.label,
      kind: d.kind,
      rateBp: d.rateBp,
      amount: d.amount ?? minor((sums.total * BigInt(d.rateBp ?? 0)) / BigInt(10_000)),
    }));
    const netPayable = netPayableOf(sums.total, taxLines);
    if (netPayable <= BigInt(0)) throw new PartnerRefused("The net payable must be more than zero.");

    const approved = await tx.commissionEntry.updateMany({ where: { statementId: st.id, status: "PENDING" }, data: { status: "APPROVED" } });
    if (approved.count !== entries.length) throw new PartnerRefused("This statement's entries have changed. Void it and generate it again.");
    const snapshot = { ...(st.partnerSnapshot && typeof st.partnerSnapshot === "object" && !Array.isArray(st.partnerSnapshot) ? st.partnerSnapshot : {}), payout: mask };
    const done = await tx.partnerStatement.updateMany({
      where: { id: st.id, status: "DRAFT" },
      data: {
        status: "APPROVED",
        approvedAt: now,
        approvedBy: `staff:${staff.id}`,
        ...sums,
        taxLines: taxLines as Prisma.InputJsonValue,
        netPayable,
        partnerSnapshot: snapshot as Prisma.InputJsonValue,
      },
    });
    if (done.count !== 1) throw new PartnerRefused(statusRefusal("APPROVED"));
    await partnerAudit(staffActor(staff), st.partnerId, "statement.approve", "statement", st.id, {
      statement: st.number,
      total: minor(sums.total),
      netPayable: minor(netPayable),
      currency: st.currency,
    }, { tx });
    const registered = Array.isArray(st.partner.taxIds) && st.partner.taxIds.some((t) => !!t && typeof t === "object" && REGISTERED_KINDS.has(String((t as { kind?: unknown }).kind)));
    return {
      decided: { id: st.id, number: st.number, partnerId: st.partnerId, partnerSlug: st.partner.slug, currency: st.currency, period: st.period, status: "APPROVED" as const, total: minor(sums.total), netPayable: minor(netPayable) },
      taxLines,
      registered,
    };
  });

  const { decided } = result;
  await mailPartnerUsers(decided.partnerId, { roles: ["ADMIN", "FINANCE"] }, `Partner portal: your statement ${decided.number} is ready`, [
    `Your commission statement for ${monthLabel(decided.period)} (${decided.currency}) has been approved for payment.`,
    "",
    `Commission: ${formatMoney(decided.total, decided.currency)}`,
    ...(result.taxLines.length ? result.taxLines.map((l) => `${l.label} (${l.kind === "ADD" ? "added" : "withheld"}): ${formatMoney(l.amount, decided.currency)}`) : []),
    `Net payable: ${formatMoney(decided.netPayable, decided.currency)}`,
    ...(result.registered ? ["", "Please add your invoice number for this statement in the partner portal."] : []),
    "",
    `See it in the partner portal: ${statementLink(decided.number)}`,
  ]);
  return decided;
}

/**
 * Records the payment of an APPROVED statement (spec §6.3; console PAYERS): a reference, and the IST
 * day it was paid — not in the future, not before the day it was approved. Its entries become PAID.
 * With `partners.twoPersonPayout` on, the member of staff who approved it is refused. The partner's
 * ADMIN and FINANCE users are emailed.
 */
export async function markStatementPaid(
  statementId: string,
  input: { reference: string; paidOn: string; note?: string | null },
  staff: Staff,
  now: Date = new Date(),
): Promise<StatementDecided & { reference: string; paidOn: string }> {
  const reference = requiredText(input?.reference, 3, 120, "Give the payment reference (3 to 120 characters).");
  const paidOnText = String(input?.paidOn ?? "").trim();
  const paidAt = istDayStart(paidOnText);
  if (!paidAt) throw new PartnerRefused("Give the day it was paid as yyyy-mm-dd.");
  if (paidAt.getTime() > startOfIstToday(now).getTime()) throw new PartnerRefused("The day it was paid can't be in the future.");
  const noteText = manyLines(input?.note);
  if (noteText.length > 500) throw new PartnerRefused("Keep the note to 500 characters.");
  const twoPerson = await twoPersonPayout();

  const decided = await controlDb().$transaction(async (tx) => {
    const st = await statementForUpdate(tx, statementId);
    if (st.status !== "APPROVED") throw new PartnerRefused(st.status === "DRAFT" ? "Approve the statement before marking it paid." : statusRefusal(st.status));
    if (twoPerson && st.approvedBy === `staff:${staff.id}`) throw new PartnerRefused("A different person must mark this statement paid.");
    if (st.approvedAt && paidAt.getTime() < startOfIstToday(st.approvedAt).getTime()) {
      throw new PartnerRefused(`The day it was paid can't be before the day it was approved (${dayMonthYear(st.approvedAt)}).`);
    }
    const attached = await tx.commissionEntry.count({ where: { statementId: st.id } });
    const paid = await tx.commissionEntry.updateMany({ where: { statementId: st.id, status: "APPROVED" }, data: { status: "PAID" } });
    if (paid.count !== attached) throw new PartnerRefused("This statement's entries have changed. Void it and generate it again.");
    const done = await tx.partnerStatement.updateMany({
      where: { id: st.id, status: "APPROVED" },
      data: { status: "PAID", paidAt, paidBy: `staff:${staff.id}`, paymentReference: reference, paymentNote: noteText || null },
    });
    if (done.count !== 1) throw new PartnerRefused(statusRefusal("PAID"));
    await partnerAudit(staffActor(staff), st.partnerId, "statement.paid", "statement", st.id, {
      statement: st.number,
      reference,
      paidOn: istDayKey(paidAt),
      netPayable: minor(st.netPayable),
      currency: st.currency,
    }, { tx });
    return { id: st.id, number: st.number, partnerId: st.partnerId, partnerSlug: st.partner.slug, currency: st.currency, period: st.period, status: "PAID" as const, total: minor(st.total), netPayable: minor(st.netPayable) };
  });

  await mailPartnerUsers(decided.partnerId, { roles: ["ADMIN", "FINANCE"] }, `Partner portal: statement ${decided.number} paid — reference ${reference}`, [
    `Your commission statement ${decided.number} for ${monthLabel(decided.period)} has been paid: ${formatMoney(decided.netPayable, decided.currency)}, on ${dayMonthYear(paidAt)}.`,
    "",
    `Payment reference: ${reference}`,
    "",
    `See it in the partner portal: ${statementLink(decided.number)}`,
  ]);
  return { ...decided, reference, paidOn: istDayKey(paidAt) };
}

/**
 * Voids a DRAFT or APPROVED statement (spec §6.4; console PAYERS): its entries go back to PENDING,
 * unattached, for the next statement. A PAID statement is final. The partner sees the void in its
 * activity only when the statement had been approved (a draft was never shown to it).
 */
export async function voidStatement(statementId: string, reason: string, staff: Staff, now: Date = new Date()): Promise<StatementDecided & { was: StatementStatus; entries: number }> {
  const why = requiredText(reason, 3, 500, "Give a reason (3 to 500 characters).");
  return controlDb().$transaction(async (tx) => {
    const st = await statementForUpdate(tx, statementId);
    if (st.status === "PAID") throw new PartnerRefused("Paid statements are final — record a correction as an adjustment.");
    if (st.status === "VOID") throw new PartnerRefused("That statement is void already.");
    const returned = await tx.commissionEntry.updateMany({ where: { statementId: st.id, status: { in: ["PENDING", "APPROVED"] } }, data: { status: "PENDING", statementId: null } });
    // Anything else still attached (a voided entry) is let go too: a void statement holds nothing.
    await tx.commissionEntry.updateMany({ where: { statementId: st.id }, data: { statementId: null } });
    await tx.partnerStatement.update({ where: { id: st.id }, data: { status: "VOID", voidedAt: now, voidedBy: `staff:${staff.id}`, voidReason: why }, select: { id: true } });
    await partnerAudit(staffActor(staff), st.partnerId, "statement.void", "statement", st.id, { statement: st.number }, { tx, visibleToPartner: st.status === "APPROVED" });
    return {
      id: st.id,
      number: st.number,
      partnerId: st.partnerId,
      partnerSlug: st.partner.slug,
      currency: st.currency,
      period: st.period,
      status: "VOID" as const,
      total: minor(st.total),
      netPayable: minor(st.netPayable),
      was: st.status,
      entries: returned.count,
    };
  });
}

/**
 * Recomputes a DRAFT statement's sums from the entries still on it, inside the caller's transaction —
 * after an entry on it was voided (spec §5.9). A statement left at zero or less is voided with
 * "Nothing left to pay after an entry was voided." and lets its entries go. Returns its number when
 * it was voided, else null. Anything but a DRAFT is left alone.
 */
export async function recomputeDraftStatement(tx: Tx, statementId: string, actor: PartnerActor, voidedBy: string, now: Date): Promise<string | null> {
  const id = cleanId(statementId);
  if (!id || !(await lockStatement(tx, id))[0]) return null;
  const st = await tx.partnerStatement.findUniqueOrThrow({ where: { id }, select: { id: true, number: true, partnerId: true, status: true } });
  if (st.status !== "DRAFT") return null;
  const left = await tx.commissionEntry.findMany({ where: { statementId: id }, select: { kind: true, amount: true, reversesId: true } });
  const sums = statementSums(left);
  if (sums.total > BigInt(0)) {
    await tx.partnerStatement.update({ where: { id }, data: { ...sums, netPayable: sums.total }, select: { id: true } });
    return null;
  }
  await tx.commissionEntry.updateMany({ where: { statementId: id }, data: { statementId: null } });
  await tx.partnerStatement.update({
    where: { id },
    data: { ...sums, netPayable: sums.total, status: "VOID", voidedAt: now, voidedBy, voidReason: AUTO_VOID_REASON },
    select: { id: true },
  });
  await partnerAudit(actor, st.partnerId, "statement.void", "statement", st.id, { statement: st.number }, { tx, visibleToPartner: false });
  return st.number;
}

// ─── The partner's own invoice number ────────────────────────────────────────────────────────────

/**
 * The partner's own invoice number for an APPROVED statement (spec §6.5; portal PARTNER_MONEY) —
 * changeable until the statement is paid. Only the caller's own partner's statements; another's reads
 * as not there.
 */
export async function setPartnerInvoiceNumber(me: PartnerMe, number: string, invoiceNumber: string): Promise<{ number: string; invoiceNumber: string }> {
  if (!PARTNER_MONEY.includes(me.role)) throw new PartnerRefused("Your role cannot do that.");
  const key = String(number ?? "").trim().toUpperCase().slice(0, 80);
  const value = requiredText(invoiceNumber, 1, 60, "Give your invoice number (1 to 60 characters).");
  if (!key) throw new PartnerRefused("That no longer exists.");
  return controlDb().$transaction(async (tx) => {
    const st = await tx.partnerStatement.findFirst({ where: { number: key, partnerId: me.partner.id }, select: { id: true, number: true, status: true, partnerInvoiceNumber: true } });
    if (!st || st.status === "VOID") throw new PartnerRefused("That no longer exists.");
    if (st.status === "DRAFT") throw new PartnerRefused("An invoice number can be added once the statement is approved.");
    if (st.status === "PAID") throw new PartnerRefused("This statement has been paid, so its invoice number can no longer change.");
    if (st.partnerInvoiceNumber === value) throw new PartnerRefused("Nothing to change.");
    const done = await tx.partnerStatement.updateMany({ where: { id: st.id, partnerId: me.partner.id, status: "APPROVED" }, data: { partnerInvoiceNumber: value } });
    if (done.count !== 1) throw new PartnerRefused("This statement has been paid, so its invoice number can no longer change.");
    await partnerAudit(meActor(me), me.partner.id, "statement.invoice-number", "statement", st.id, { statement: st.number, invoiceNumber: value }, { tx });
    return { number: st.number, invoiceNumber: value };
  });
}

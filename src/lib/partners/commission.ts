import { randomUUID } from "node:crypto";
import { Prisma } from "@wroffy/control-client";
import { redactSecrets } from "@/lib/console-shared/redact";
import { istDateParts } from "@/lib/india-time";
import { attributionAt } from "@/lib/partners/attribution";
import { partnerAudit } from "@/lib/partners/audit";
import {
  clockStartOf,
  commissionFor,
  mulDivFloor,
  phaseOf,
  planLinesOf,
  reversalTarget,
  reversedBaseOf,
  withinClawback,
  withinDuration,
  type AccrualOutcome,
  type CommissionBasis,
} from "@/lib/partners/rates";
import { expireDeals } from "@/lib/partners/referrals";
import { cleanId, requiredText, staffActor } from "@/lib/partners/registry";
import { clawbackMonths, statementDay } from "@/lib/partners/settings";
import { generateStatements, recomputeDraftStatement } from "@/lib/partners/statements";
import { istDayStart, startOfIstToday, termsAt } from "@/lib/partners/terms";
import { PartnerRefused } from "@/lib/partners/types";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { withPlatformLease } from "@/lib/platform/fanout";
import type { Staff } from "@/lib/platform/staff-session";

/**
 * The commission engine (spec §5): gateway invoices in, commission entries out.
 *
 *   · `accrueCommissions` looks at every PAID invoice it has never seen, and every invoice that changed
 *     since it last looked (`invoices.updatedAt` > the state row's `seenUpdatedAt`) — oldest payment
 *     first, 500 at a time, at most 20 batches a run, one transaction per invoice. One invoice failing
 *     is logged and counted; the run carries on.
 *   · The first look decides the invoice's outcome once and for all: the DIRECT entry for the partner
 *     the workspace was attributed to when it was paid (its terms then, its phase and duration), and a
 *     distributor's OVERRIDE on its reseller's customer. Later looks only reverse — a refund, a credit
 *     note, a void — in proportion, as new negative entries. Nothing written is ever recomputed.
 *   · A refund reaches a PAID commission only within `partners.clawbackMonths` of its statement being
 *     paid (owner decision O3); past that no reversal is written and the invoice's state records when
 *     that was found (`clawbackExpiredAt`). PENDING and APPROVED entries are always reversed.
 *   · Every entry has a unique `sourceKey` and is written with `skipDuplicates`, so a second run over
 *     the same invoices writes nothing.
 *
 * The arithmetic is src/lib/partners/rates.ts (pure); statements are src/lib/partners/statements.ts.
 * `now` is a parameter everywhere, so a check can place the clock.
 */

type Tx = Prisma.TransactionClient;

const BATCH_SIZE = 500;
const MAX_BATCHES = 20;
const COMMISSION_LEASE_MS = 20 * 60_000;
const INVOICE_TX = { timeout: 30_000, maxWait: 10_000 };
const ENGINE = "engine";
const MAX_ADJUSTMENT = 1_000_000_000;
const REVERSAL_VOID_REASON = "Voided with the commission it reversed.";

const INVOICE_SELECT = {
  id: true,
  tenantId: true,
  gateway: true,
  status: true,
  currency: true,
  total: true,
  tax: true,
  amountRefunded: true,
  amountCredited: true,
  paidAt: true,
  refundedAt: true,
  planLines: true,
  subscriptionId: true,
  updatedAt: true,
  tenant: { select: { isDefault: true, country: true } },
} as const satisfies Prisma.InvoiceSelect;
type InvoiceRow = Prisma.InvoiceGetPayload<{ select: typeof INVOICE_SELECT }>;

const STATE_SELECT = { base: true, reversedBase: true, outcome: true, clawbackExpiredAt: true } as const satisfies Prisma.CommissionInvoiceStateSelect;
type StateRow = Prisma.CommissionInvoiceStateGetPayload<{ select: typeof STATE_SELECT }>;

const PARTNER_FACTS = { id: true, kind: true, status: true, parentId: true, terminatedAt: true } as const satisfies Prisma.PartnerSelect;
type PartnerFacts = Prisma.PartnerGetPayload<{ select: typeof PARTNER_FACTS }>;

/** What one look at one invoice did. */
export type InvoiceAccrual = {
  /** The first look: the DIRECT outcome. A later look: "rechecked". Nothing to do (not PAID and never seen, or gone): "skipped". */
  outcome: AccrualOutcome | "rechecked" | "skipped";
  /** Accrual entries written (DIRECT, OVERRIDE). */
  accrued: number;
  /** Reversal entries written. */
  reversed: number;
  /** PAID entries a refund came too late to claw back (O3). */
  clawbackExpired: number;
};

export type AccrualRun = {
  /** Invoices looked at. */
  invoices: number;
  accrued: number;
  reversed: number;
  /** Invoices by what the look made of them: the eight outcomes, "rechecked" and "skipped". */
  outcomes: Record<string, number>;
  failed: number;
};

const SKIPPED: InvoiceAccrual = { outcome: "skipped", accrued: 0, reversed: 0, clawbackExpired: 0 };

const currencyOf = (raw: string) => raw.trim().toUpperCase();
const earlier = (a: Date, b: Date) => a.getTime() <= b.getTime();
/** Terminated at or before the instant: from then on it earns nothing (D18). */
const terminatedBy = (p: { status: string; terminatedAt: Date | null }, at: Date) => p.status === "TERMINATED" && !!p.terminatedAt && earlier(p.terminatedAt, at);

/** A failure's message fit for a log line: the constraint's name rather than a CHECK message quoting the row. */
function failureText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const check = /violates check constraint "([^"]+)"/.exec(message);
  if (check) return `check constraint ${check[1]}`;
  const code = (err as { code?: unknown } | null)?.code;
  const line = message.replace(/\s+/g, " ").trim().slice(0, 300);
  return redactSecrets(typeof code === "string" ? `${code} ${line}` : line) ?? "error";
}

// ─── The run ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Every invoice the engine should look at (spec §5.1), oldest payment first: `batchSize` (500) at a
 * time, at most `maxBatches` (20) a run. An invoice that fails, or has nothing to do, is not picked
 * again in the same run.
 */
export async function accrueCommissions(now: Date = new Date(), opts: { batchSize?: number; maxBatches?: number } = {}): Promise<AccrualRun> {
  const upTo = (n: number | undefined, max: number) => (typeof n === "number" && Number.isFinite(n) ? Math.max(1, Math.min(max, Math.trunc(n))) : max);
  const batchSize = upTo(opts?.batchSize, BATCH_SIZE);
  const maxBatches = upTo(opts?.maxBatches, MAX_BATCHES);
  const run: AccrualRun = { invoices: 0, accrued: 0, reversed: 0, outcomes: {}, failed: 0 };
  // Looked at and left as they were (a failure, or nothing to do): the next batch would only pick them again.
  const passed: string[] = [];
  for (let batch = 0; batch < maxBatches; batch++) {
    const rows = await controlDb().$queryRaw<{ id: string }[]>`
      SELECT i.id
      FROM invoices i
      LEFT JOIN commission_invoice_states s ON s."invoiceId" = i.id
      WHERE ((s."invoiceId" IS NULL AND i.status = 'PAID') OR (s."invoiceId" IS NOT NULL AND i."updatedAt" > s."seenUpdatedAt"))
        ${passed.length ? Prisma.sql`AND i.id NOT IN (${Prisma.join(passed)})` : Prisma.empty}
      ORDER BY i."paidAt" ASC NULLS LAST, i.id ASC
      LIMIT ${batchSize}`;
    for (const { id } of rows) {
      run.invoices += 1;
      try {
        const done = await accrueInvoice(id, now);
        run.accrued += done.accrued;
        run.reversed += done.reversed;
        run.outcomes[done.outcome] = (run.outcomes[done.outcome] ?? 0) + 1;
        if (done.outcome === "skipped") passed.push(id);
      } catch (err) {
        run.failed += 1;
        passed.push(id);
        console.error(`[partners] commission for invoice ${id} failed: ${failureText(err)}`);
      }
    }
    if (rows.length < batchSize) break;
  }
  return run;
}

/**
 * One invoice (spec §5.2), in one transaction with the invoice's row locked — so a webhook's change
 * waits for it, and the `seenUpdatedAt` recorded is the version that was worked on.
 */
export async function accrueInvoice(invoiceId: string, now: Date = new Date()): Promise<InvoiceAccrual> {
  const id = cleanId(invoiceId);
  if (!id) return SKIPPED;
  return controlDb().$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM invoices WHERE id = ${id} FOR UPDATE`;
    if (!locked[0]) return SKIPPED;
    const invoice = await tx.invoice.findUniqueOrThrow({ where: { id }, select: INVOICE_SELECT });
    const state = await tx.commissionInvoiceState.findUnique({ where: { invoiceId: id }, select: STATE_SELECT });
    if (state) return await recheck(tx, invoice, state, now);
    if (invoice.status !== "PAID" || !invoice.paidAt) return SKIPPED;
    return await firstLook(tx, invoice, invoice.paidAt, now);
  }, INVOICE_TX);
}

// ─── The first look ──────────────────────────────────────────────────────────────────────────────

/** The earliest payment of the workspace's PAID invoices at any gateway, whoever they were attributed to. */
async function firstPaidAtOf(tx: Tx, tenantId: string, paidAt: Date): Promise<Date> {
  const first = await tx.invoice.aggregate({ where: { tenantId, status: "PAID", paidAt: { not: null } }, _min: { paidAt: true } });
  const at = first._min.paidAt;
  return at && at.getTime() < paidAt.getTime() ? at : paidAt;
}

/** The plan an invoice is for when its lines are not known: its subscription's EDITION plan, else its first item's. */
async function primaryPlanKey(tx: Tx, subscriptionId: string | null): Promise<string | null> {
  if (!subscriptionId) return null;
  const items = await tx.subscriptionItem.findMany({ where: { subscriptionId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { plan: { select: { key: true, kind: true } } } });
  return (items.find((i) => i.plan.kind === "EDITION") ?? items[0])?.plan.key ?? null;
}

type Attribution = NonNullable<Awaited<ReturnType<typeof attributionAt>>>;

async function directEntry(
  tx: Tx,
  invoice: InvoiceRow,
  partner: PartnerFacts,
  a: Attribution,
  facts: { base: number; currency: string; paidAt: Date; firstPaidAt: Date; clockStart: Date },
): Promise<{ outcome: AccrualOutcome; row: Prisma.CommissionEntryCreateManyInput | null }> {
  const { base, currency, paidAt, firstPaidAt, clockStart } = facts;
  if (terminatedBy(partner, paidAt)) return { outcome: "terminated", row: null };
  const terms = await termsAt(partner.id, paidAt);
  if (!terms) return { outcome: "no-terms", row: null };
  if (!withinDuration(clockStart, paidAt, terms.durationMonths)) return { outcome: "outside-duration", row: null };
  const phase = phaseOf(firstPaidAt, paidAt, terms.newMonths);
  let lines = planLinesOf(invoice.planLines);
  if (!lines.length) lines = [{ planKey: await primaryPlanKey(tx, invoice.subscriptionId), amount: 1 }];
  const made = commissionFor(base, lines, terms, { country: invoice.tenant.country, phase, source: a.source });
  if (made.amount === 0) return { outcome: "zero", row: null };
  const basis: CommissionBasis = { type: "accrual", termsId: terms.id, phase, source: a.source, clockStart: clockStart.toISOString(), lines: made.lines };
  return {
    outcome: "accrued",
    row: {
      partnerId: partner.id,
      tenantId: invoice.tenantId,
      invoiceId: invoice.id,
      kind: "DIRECT",
      currency,
      base,
      rateBp: made.rateBp,
      amount: made.amount,
      basis: basis as Prisma.InputJsonValue,
      sourceKey: `acc:${invoice.id}:${partner.id}:DIRECT`,
      earnedAt: paidAt,
      createdBy: ENGINE,
    },
  };
}

/**
 * A distributor's cut of its reseller's customer's invoice (spec §5.5): the reseller's parent at
 * accrual time, not terminated by the payment, with an override rate in its terms then, within its
 * own duration from the same clock start. Flat on the base: no lines, no plan, country or phase.
 */
async function overrideEntry(
  tx: Tx,
  invoice: InvoiceRow,
  reseller: PartnerFacts,
  facts: { base: number; currency: string; paidAt: Date; clockStart: Date },
): Promise<Prisma.CommissionEntryCreateManyInput | null> {
  if (reseller.kind !== "RESELLER" || !reseller.parentId) return null;
  const { base, currency, paidAt, clockStart } = facts;
  const parent = await tx.partner.findUnique({ where: { id: reseller.parentId }, select: PARTNER_FACTS });
  if (!parent || terminatedBy(parent, paidAt)) return null;
  const terms = await termsAt(parent.id, paidAt);
  const rateBp = Math.min(10_000, terms?.overrideRateBp ?? 0);
  if (!terms || rateBp <= 0) return null;
  if (!withinDuration(clockStart, paidAt, terms.durationMonths)) return null;
  const amount = mulDivFloor(base, rateBp, 10_000);
  if (amount === 0) return null;
  const basis: CommissionBasis = { type: "override", termsId: terms.id, resellerId: reseller.id, rateBp };
  return {
    partnerId: parent.id,
    tenantId: invoice.tenantId,
    invoiceId: invoice.id,
    kind: "OVERRIDE",
    currency,
    base,
    rateBp,
    amount,
    basis: basis as Prisma.InputJsonValue,
    sourceKey: `acc:${invoice.id}:${parent.id}:OVERRIDE`,
    earnedAt: paidAt,
    createdBy: ENGINE,
  };
}

async function firstLook(tx: Tx, invoice: InvoiceRow, paidAt: Date, now: Date): Promise<InvoiceAccrual> {
  const base = Math.max(0, invoice.total - invoice.tax);
  const currency = currencyOf(invoice.currency);
  const rows: Prisma.CommissionEntryCreateManyInput[] = [];
  // The order of these checks is the spec's (§5.2): the first that applies is the outcome.
  let outcome: AccrualOutcome;
  if (invoice.tenant.isDefault) outcome = "exempt";
  else if (base === 0) outcome = "zero";
  else {
    const a = await attributionAt(invoice.tenantId, paidAt);
    const partner = a?.partnerId ? await tx.partner.findUnique({ where: { id: a.partnerId }, select: PARTNER_FACTS }) : null;
    if (!a || !partner) outcome = "no-partner";
    else if (!a.commissionable) outcome = "not-commissionable";
    else {
      const firstPaidAt = await firstPaidAtOf(tx, invoice.tenantId, paidAt);
      const facts = { base, currency, paidAt, firstPaidAt, clockStart: clockStartOf(firstPaidAt, a.validFrom) };
      const direct = await directEntry(tx, invoice, partner, a, facts);
      outcome = direct.outcome;
      if (direct.row) rows.push(direct.row);
      // Whatever the reseller's own outcome was ("no-terms", "outside-duration", "terminated" too).
      const override = await overrideEntry(tx, invoice, partner, facts);
      if (override) rows.push(override);
    }
  }

  const accrued = rows.length ? (await tx.commissionEntry.createMany({ data: rows, skipDuplicates: true })).count : 0;
  // A refund already on the invoice when it is first seen is reversed now: the change that brought it
  // is the very `updatedAt` being recorded, so no later look would come for it.
  const reversal = await reverseInvoice(tx, invoice, { base, reversedBase: 0 }, now);
  await tx.commissionInvoiceState.create({
    data: {
      invoiceId: invoice.id,
      status: invoice.status,
      base,
      reversedBase: reversal.reversedBase,
      outcome,
      seenUpdatedAt: invoice.updatedAt,
      processedAt: now,
      clawbackExpiredAt: reversal.expired ? now : null,
    },
    select: { invoiceId: true },
  });
  return { outcome, accrued, reversed: reversal.reversed, clawbackExpired: reversal.expired };
}

// ─── Later looks: reversals ──────────────────────────────────────────────────────────────────────

/**
 * The reversals an invoice's refunds, credit notes or void call for now (spec §5.6): for every accrual
 * entry that is not VOID, the part of it that should stand reversed at the invoice's cumulative
 * `reversedBase`, less what its reversals already took back, as one new negative entry. A PAID entry
 * whose statement was paid more than `partners.clawbackMonths` before the refund is left (O3).
 */
async function reverseInvoice(tx: Tx, invoice: InvoiceRow, state: { base: number; reversedBase: number }, now: Date): Promise<{ reversedBase: number; reversed: number; expired: number }> {
  const accruals = await tx.commissionEntry.findMany({
    where: { invoiceId: invoice.id, reversesId: null, kind: { in: ["DIRECT", "OVERRIDE"] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      partnerId: true,
      tenantId: true,
      kind: true,
      status: true,
      currency: true,
      base: true,
      rateBp: true,
      amount: true,
      statement: { select: { paidAt: true } },
      reversals: { select: { amount: true } },
    },
  });
  const r = reversedBaseOf(invoice, accruals.length > 0, state);
  const earnedAt = invoice.refundedAt ?? now;
  const basis: CommissionBasis = { type: "reversal", reversedBase: r.reversedBase, reversedGross: r.reversedGross, reason: r.reason };
  const rows: Prisma.CommissionEntryCreateManyInput[] = [];
  let months: number | null = null;
  let expired = 0;
  for (const e of accruals) {
    if (e.status === "VOID") continue;
    const target = reversalTarget(e, r.reversedBase);
    const taken = e.reversals.reduce((sum, x) => sum + Math.abs(x.amount), 0);
    if (target <= taken) continue;
    if (e.status === "PAID" && e.statement?.paidAt) {
      months ??= await clawbackMonths();
      if (!withinClawback(e.statement.paidAt, earnedAt, months)) {
        expired += 1;
        continue;
      }
    }
    rows.push({
      partnerId: e.partnerId,
      tenantId: e.tenantId,
      invoiceId: invoice.id,
      kind: e.kind,
      currency: e.currency,
      base: Math.max(0, r.reversedBase - state.reversedBase),
      rateBp: e.rateBp,
      amount: -(target - taken),
      basis: basis as Prisma.InputJsonValue,
      sourceKey: `rev:${e.id}:${r.reversedBase}`,
      reversesId: e.id,
      earnedAt,
      createdBy: ENGINE,
    });
  }
  const reversed = rows.length ? (await tx.commissionEntry.createMany({ data: rows, skipDuplicates: true })).count : 0;
  return { reversedBase: r.reversedBase, reversed, expired };
}

/** A later look (spec §5.2 step 4): reversals only; an invoice that was never accrued just has its state refreshed. */
async function recheck(tx: Tx, invoice: InvoiceRow, state: StateRow, now: Date): Promise<InvoiceAccrual> {
  const reversal = await reverseInvoice(tx, invoice, state, now);
  await tx.commissionInvoiceState.update({
    where: { invoiceId: invoice.id },
    data: {
      status: invoice.status,
      reversedBase: reversal.reversedBase,
      seenUpdatedAt: invoice.updatedAt,
      processedAt: now,
      ...(reversal.expired && !state.clawbackExpiredAt ? { clawbackExpiredAt: now } : {}),
    },
    select: { invoiceId: true },
  });
  return { outcome: "rechecked", accrued: 0, reversed: reversal.reversed, clawbackExpired: reversal.expired };
}

// ─── Staff's actions on entries (console, SELLERS) ───────────────────────────────────────────────

export type CommissionVoided = {
  entryId: string;
  partnerId: string;
  partnerSlug: string;
  amount: number;
  currency: string;
  /** Its PENDING reversals, voided with an accrual. */
  reversalsVoided: number;
  /** DRAFT statements left at zero or less and voided with it. */
  statementsVoided: string[];
};

/**
 * Voids a PENDING entry (spec §5.9) — unattached, or on a DRAFT statement, whose sums are then worked
 * out again (and which is voided when nothing is left to pay). An accrual's PENDING reversals go with
 * it. A voided entry leaves its statement; it is never reversed. The partner sees the void, not the reason.
 */
export async function voidCommission(entryId: string, reason: string, staff: Staff, now: Date = new Date()): Promise<CommissionVoided> {
  const id = cleanId(entryId);
  const why = requiredText(reason, 3, 500, "Give a reason (3 to 500 characters).");
  if (!id) throw new PartnerRefused("That no longer exists.");
  const actor = staffActor(staff);
  const by = `staff:${staff.id}`;
  return controlDb().$transaction(async (tx) => {
    const peek = await tx.commissionEntry.findUnique({ where: { id }, select: { statementId: true, kind: true, reversesId: true } });
    if (!peek) throw new PartnerRefused("That no longer exists.");
    const reversals =
      peek.kind !== "ADJUSTMENT" && peek.reversesId === null
        ? await tx.commissionEntry.findMany({ where: { reversesId: id, status: "PENDING" }, select: { id: true, statementId: true } })
        : [];
    const statementIds = [...new Set([peek.statementId, ...reversals.map((r) => r.statementId)].filter((s): s is string => !!s))].sort();
    // Statements before entries — the order approval, payment and void take them in — so two staff
    // actions on one statement queue rather than deadlock.
    for (const sid of statementIds) await tx.$queryRaw`SELECT id FROM partner_statements WHERE id = ${sid} FOR UPDATE`;
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM commission_entries WHERE id = ${id} FOR UPDATE`;
    if (!locked[0]) throw new PartnerRefused("That no longer exists.");
    const entry = await tx.commissionEntry.findUniqueOrThrow({
      where: { id },
      select: { id: true, partnerId: true, kind: true, status: true, amount: true, currency: true, reversesId: true, statementId: true, statement: { select: { status: true } }, partner: { select: { slug: true } } },
    });
    if (entry.status === "VOID") throw new PartnerRefused("That commission is void already.");
    if (entry.status !== "PENDING" || (entry.statement && entry.statement.status !== "DRAFT")) {
      throw new PartnerRefused("Only a pending commission can be voided. Void its statement first, or record a correction as an adjustment.");
    }
    const changed = "That commission changed while you were looking at it. Try again.";
    if (entry.statementId !== peek.statementId) throw new PartnerRefused(changed);
    // Its pending reversals again, now the statements are held: one drafted onto another statement meanwhile is a change.
    const pending = entry.kind !== "ADJUSTMENT" && entry.reversesId === null ? await tx.commissionEntry.findMany({ where: { reversesId: id, status: "PENDING" }, select: { id: true, statementId: true } }) : [];
    if (pending.some((r) => r.statementId !== null && !statementIds.includes(r.statementId))) throw new PartnerRefused(changed);

    const voided = await tx.commissionEntry.updateMany({ where: { id, status: "PENDING" }, data: { status: "VOID", voidedAt: now, voidedBy: by, voidReason: why, statementId: null } });
    if (voided.count !== 1) throw new PartnerRefused(changed);
    const reversalsVoided = pending.length
      ? (
          await tx.commissionEntry.updateMany({
            where: { id: { in: pending.map((r) => r.id) }, status: "PENDING" },
            data: { status: "VOID", voidedAt: now, voidedBy: by, voidReason: REVERSAL_VOID_REASON, statementId: null },
          })
        ).count
      : 0;

    const statementsVoided: string[] = [];
    for (const sid of statementIds) {
      const number = await recomputeDraftStatement(tx, sid, actor, by, now);
      if (number) statementsVoided.push(number);
    }
    await partnerAudit(actor, entry.partnerId, "commission.void", "commission", entry.id, { entry: entry.id, amount: entry.amount, currency: entry.currency }, { tx });
    return { entryId: entry.id, partnerId: entry.partnerId, partnerSlug: entry.partner.slug, amount: entry.amount, currency: entry.currency, reversalsVoided, statementsVoided };
  });
}

export type AdjustmentInput = {
  currency: string;
  /** Signed minor units: positive owed to the partner, negative taken back. Not 0; at most 10^9 either way. */
  amount: number;
  /** Shown to the partner, 3–500 characters. */
  note: string;
  /** The customer it is about, if any: a workspace that has been this partner's. */
  tenantSlug?: string | null;
  /** The IST day it counts from, "yyyy-mm-dd" (not in the future); none: now. */
  earnedOn?: string | null;
};

export type AdjustmentAdded = { id: string; partnerId: string; partnerSlug: string; amount: number; currency: string; tenantId: string | null; earnedAt: Date };

/** A staff correction (spec §5.9): an ADJUSTMENT entry, PENDING, for the next statement in its currency. */
export async function addAdjustment(partnerId: string, input: AdjustmentInput, staff: Staff, now: Date = new Date()): Promise<AdjustmentAdded> {
  const x = (input ?? {}) as Partial<Record<keyof AdjustmentInput, unknown>>;
  const currency = String(x.currency ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new PartnerRefused("Give the currency as its three-letter code, like INR.");
  const amount = typeof x.amount === "number" ? x.amount : typeof x.amount === "string" && /^\s*-?\d{1,10}\s*$/.test(x.amount) ? Number(x.amount.trim()) : NaN;
  if (!Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount) > MAX_ADJUSTMENT) {
    throw new PartnerRefused("The amount is a whole number of the currency's smallest unit (paise, cents): not zero, and at most 1,000,000,000 either way.");
  }
  const note = requiredText(x.note, 3, 500, "Give a note for the partner (3 to 500 characters).");
  let earnedAt = now;
  if (x.earnedOn !== null && x.earnedOn !== undefined && String(x.earnedOn).trim() !== "") {
    const day = istDayStart(String(x.earnedOn));
    if (!day) throw new PartnerRefused("Give the date as yyyy-mm-dd.");
    if (day.getTime() > startOfIstToday(now).getTime()) throw new PartnerRefused("The date can't be in the future.");
    earnedAt = day;
  }

  const control = controlDb();
  const partner = await control.partner.findUnique({ where: { id: cleanId(partnerId) }, select: { id: true, slug: true } });
  if (!partner) throw new PartnerRefused("That partner no longer exists.");
  let tenant: { id: string; name: string } | null = null;
  const slug = String(x.tenantSlug ?? "").trim().toLowerCase().slice(0, 63);
  if (slug) {
    tenant = await control.tenant.findUnique({ where: { slug }, select: { id: true, name: true } });
    if (!tenant) throw new PartnerRefused("That workspace no longer exists.");
    // The portal shows an entry's customer: only a workspace that has been this partner's may be named.
    const ever = await control.tenantAttribution.findFirst({ where: { tenantId: tenant.id, partnerId: partner.id }, select: { id: true } });
    if (!ever) throw new PartnerRefused("That workspace has never been this partner's customer.");
  }

  const basis: CommissionBasis = { type: "adjustment" };
  return control.$transaction(async (tx) => {
    const entry = await tx.commissionEntry.create({
      data: {
        partnerId: partner.id,
        tenantId: tenant?.id ?? null,
        invoiceId: null,
        kind: "ADJUSTMENT",
        status: "PENDING",
        currency,
        base: 0,
        rateBp: 0,
        amount,
        basis: basis as Prisma.InputJsonValue,
        sourceKey: `adj:${randomUUID()}`,
        earnedAt,
        note,
        createdBy: `staff:${staff.id}`,
      },
      select: { id: true },
    });
    await partnerAudit(staffActor(staff), partner.id, "commission.adjust", "commission", entry.id, {
      entry: entry.id,
      amount,
      currency,
      note,
      ...(tenant ? { workspace: tenant.name } : {}),
    }, { tx });
    return { id: entry.id, partnerId: partner.id, partnerSlug: partner.slug, amount, currency, tenantId: tenant?.id ?? null, earnedAt };
  });
}

// ─── The tick ────────────────────────────────────────────────────────────────────────────────────

/** What the partner chores did on one tick — `TickSummary.partners` (src/lib/platform/tick-summary.ts). */
export type PartnerChores = { accrued: number; reversed: number; statements: number; expiredDeals: number; failed: number };

/**
 * The partner programme's share of the platform tick (spec §14), under its own lease: commission every
 * run; on the run that does the daily block, deal expiry and — from `partners.statementDay` of the IST
 * month on — last month's statements. Never throws: each chore's failure is logged and counted, so
 * none of it can fail the billing chores. Null when another run holds the lease (or there is no control plane).
 */
export async function runPartnerChores(now: Date, opts: { daily: boolean }): Promise<PartnerChores | null> {
  if (!controlConfigured()) return null;
  const chore = async (name: string, out: PartnerChores, work: () => Promise<void>) => {
    try {
      await work();
    } catch (err) {
      out.failed += 1;
      console.error(`[partners] ${name} failed: ${failureText(err)}`);
    }
  };
  try {
    const ran = await withPlatformLease("partner-commissions", COMMISSION_LEASE_MS, async () => {
      const out: PartnerChores = { accrued: 0, reversed: 0, statements: 0, expiredDeals: 0, failed: 0 };
      await chore("commission", out, async () => {
        const run = await accrueCommissions(now);
        out.accrued = run.accrued;
        out.reversed = run.reversed;
        out.failed += run.failed;
      });
      if (opts?.daily) {
        await chore("deal expiry", out, async () => {
          out.expiredDeals = await expireDeals(now);
        });
        await chore("statements", out, async () => {
          if (istDateParts(now).day < (await statementDay())) return;
          const made = await generateStatements(now, { by: "tick" });
          out.statements = made.made;
          out.failed += made.failed;
        });
      }
      return out;
    });
    return ran.ran ? ran.value : null;
  } catch (err) {
    console.error(`[partners] the partner chores failed: ${failureText(err)}`);
    return { accrued: 0, reversed: 0, statements: 0, expiredDeals: 0, failed: 1 };
  }
}

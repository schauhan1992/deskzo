import type { PlanLine } from "@/lib/billing/sync";
import type { AttributionSource, TermsRates } from "@/lib/partners/types";
import { indiaClock } from "@/lib/time/zone";

/**
 * The commission engine's arithmetic (spec §5.3–§5.6), pure: no database, no clock of its own, and
 * nothing imported but types and India's calendar — so the console and the portal can show the same
 * working, and a check can prove it by hand.
 *
 *   · Money is whole minor units of the invoice's currency. Every division floors; a product that
 *     could pass 2^53 (a base times an amount) is worked out in BigInt.
 *   · Rates are basis points (1500 is 15 %), 0–10000.
 *   · Months are India's calendar months (`addIstMonths`): the same wall-clock time n months on, the
 *     day clamped to the month's end — 31 January + 1 month is 28 (or 29) February, same time of day.
 *     India's whatever zone the console keeps: commission is earned on the platform's own invoices, and
 *     a display setting must not move an invoice between a customer's new and renewal months.
 *
 * Client-safe. src/lib/partners/commission.ts does the reading and writing.
 */

export type Phase = "NEW" | "RENEWAL";
export type RateBy = "plan" | "country" | "phase" | "default" | "territory";
export type RateContext = { planKey: string | null; country: string; phase: Phase; source: AttributionSource };

/** A plan line with its part of the base. */
export type AllocatedLine = PlanLine & { share: number };
export type CommissionLine = { planKey: string | null; share: number; rateBp: number; by: RateBy };
/** A DIRECT amount: the sum of the per-line floors, and the effective rate over the whole base. */
export type Commission = { amount: number; rateBp: number; lines: CommissionLine[] };

export type ReversalReason = "refund" | "credit" | "void";
/** How much of an invoice is reversed: of its total (`reversedGross`) and of its base (`reversedBase`, cumulative). */
export type Reversal = { reversedGross: number; reversedBase: number; reason: ReversalReason };

/** What the engine made of an invoice the first time it saw it — `commission_invoice_states.outcome`. */
export const ACCRUAL_OUTCOMES = ["accrued", "no-partner", "not-commissionable", "no-terms", "outside-duration", "terminated", "exempt", "zero"] as const;
export type AccrualOutcome = (typeof ACCRUAL_OUTCOMES)[number];

/** `commission_entries.basis` (spec §5.8): shown to staff; the portal shows `phase`, `by` and the per-line rates. */
export type CommissionBasis =
  | { type: "accrual"; termsId: string; phase: Phase; source: AttributionSource; clockStart: string; lines: CommissionLine[] }
  | { type: "override"; termsId: string; resellerId: string; rateBp: number }
  | { type: "reversal"; reversedBase: number; reversedGross: number; reason: ReversalReason }
  | { type: "adjustment" };

const BP = 10_000;

const whole = (n: number): number => (Number.isFinite(n) ? Math.trunc(n) : 0);
const clampBp = (bp: number): number => Math.min(BP, Math.max(0, whole(bp)));

/** `a × b / c`, floored, exactly. For non-negative whole numbers and `c > 0`; 0 otherwise. */
export function mulDivFloor(a: number, b: number, c: number): number {
  const [x, y, z] = [whole(a), whole(b), whole(c)];
  if (x <= 0 || y <= 0 || z <= 0) return 0;
  return Number((BigInt(x) * BigInt(y)) / BigInt(z));
}

// ─── Rates ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The rate for one line of an invoice (spec §5.3). The first match wins:
 *   1. a TERRITORY attribution: the territory rate, else the default;
 *   2. a plan rate for the line's plan;
 *   3. a country rate for the customer's country;
 *   4. the phase's rate (new or renewal), when set;
 *   5. the default rate.
 */
export function rateFor(terms: TermsRates, ctx: RateContext): { rateBp: number; by: RateBy } {
  if (ctx.source === "TERRITORY") return { rateBp: clampBp(terms.territoryRateBp ?? terms.defaultRateBp), by: "territory" };
  const plan = ctx.planKey !== null && Array.isArray(terms.planRates) ? terms.planRates.find((r) => r?.planKey === ctx.planKey) : undefined;
  if (plan) return { rateBp: clampBp(plan.rateBp), by: "plan" };
  const country = Array.isArray(terms.countryRates) ? terms.countryRates.find((r) => r?.country === ctx.country) : undefined;
  if (country) return { rateBp: clampBp(country.rateBp), by: "country" };
  if (ctx.phase === "NEW" && terms.newRateBp !== null && terms.newRateBp !== undefined) return { rateBp: clampBp(terms.newRateBp), by: "phase" };
  if (ctx.phase === "RENEWAL" && terms.renewalRateBp !== null && terms.renewalRateBp !== undefined) return { rateBp: clampBp(terms.renewalRateBp), by: "phase" };
  return { rateBp: clampBp(terms.defaultRateBp), by: "default" };
}

// ─── Months, phase and duration ──────────────────────────────────────────────────────────────────

/**
 * The same India wall-clock time `n` calendar months later (earlier for a negative `n`), the day
 * clamped to the last day of that month: 31 Jan 2026 18:30 IST + 1 is 28 Feb 2026 18:30 IST.
 */
export function addIstMonths(at: Date, n: number): Date {
  const { year, month, day } = indiaClock.parts(at);
  // India keeps no daylight saving, so a time of day is the same span after every midnight.
  const timeOfDay = at.getTime() - indiaClock.midnight(year, month, day).getTime();
  const target = month + whole(n);
  // Day 0 of the month after is the target month's last day; Date.UTC carries a month past 11 into the next year.
  const lastDay = new Date(Date.UTC(year, target + 1, 0)).getUTCDate();
  return new Date(indiaClock.midnight(year, target, Math.min(day, lastDay)).getTime() + timeOfDay);
}

/** NEW while the customer is within its first `newMonths` months from its first paid invoice; RENEWAL after. */
export function phaseOf(firstPaidAt: Date, paidAt: Date, newMonths: number): Phase {
  return paidAt.getTime() < addIstMonths(firstPaidAt, newMonths).getTime() ? "NEW" : "RENEWAL";
}

/** Whether an invoice paid at `paidAt` is within `months` of the clock's start; null months: the customer's lifetime. */
export function withinDuration(clockStart: Date, paidAt: Date, months: number | null): boolean {
  return months === null || months === undefined || paidAt.getTime() < addIstMonths(clockStart, months).getTime();
}

/** The duration clock starts at the later of the customer's first payment and the attribution's start (a takeover starts its own). */
export function clockStartOf(firstPaidAt: Date, validFrom: Date): Date {
  return validFrom.getTime() > firstPaidAt.getTime() ? validFrom : firstPaidAt;
}

/**
 * Whether a refund seen at `earnedAt` may still claw back a commission paid out on `paidOn` — within
 * `months` calendar months of it (owner decision O3). Past that, the PAID entry is left as it is.
 */
export function withinClawback(paidOn: Date, earnedAt: Date, months: number): boolean {
  return earnedAt.getTime() <= addIstMonths(paidOn, months).getTime();
}

// ─── The DIRECT amount ───────────────────────────────────────────────────────────────────────────

/**
 * `invoices.planLines` as stored, checked: the lines with a whole, positive amount; a planKey that is
 * not a non-empty string reads as null. Anything else (SQL NULL: "not known") is no lines.
 */
export function planLinesOf(raw: unknown): PlanLine[] {
  if (!Array.isArray(raw)) return [];
  const lines: PlanLine[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { planKey, amount } = item as Record<string, unknown>;
    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) continue;
    lines.push({ planKey: typeof planKey === "string" && planKey ? planKey : null, amount });
  }
  return lines;
}

/**
 * The base split across the lines in proportion to their amounts: each share floored, and what the
 * floors leave over goes to the line with the largest amount (the first of equals), so the shares
 * always add up to the base. A line whose amount is not a whole positive number gets nothing; when
 * no line has one, the first takes it all. No lines: nothing.
 */
export function allocate(base: number, lines: PlanLine[]): AllocatedLine[] {
  if (!lines.length) return [];
  const total = Math.max(0, whole(base));
  const amounts = lines.map((l) => (Number.isSafeInteger(l.amount) && l.amount > 0 ? l.amount : 0));
  const sum = amounts.reduce((s, a) => s + a, 0);
  if (sum <= 0) return lines.map((l, i) => ({ planKey: l.planKey, amount: l.amount, share: i === 0 ? total : 0 }));
  const shares = amounts.map((a) => mulDivFloor(total, a, sum));
  let largest = 0;
  for (let i = 1; i < amounts.length; i++) if (amounts[i] > amounts[largest]) largest = i;
  shares[largest] += total - shares.reduce((s, x) => s + x, 0);
  return lines.map((l, i) => ({ planKey: l.planKey, amount: l.amount, share: shares[i] }));
}

/**
 * The DIRECT commission on `base` (spec §5.3): the base allocated across the lines, each share at its
 * own rate and floored, summed. The stored rate is the effective one over the whole base.
 */
export function commissionFor(base: number, lines: PlanLine[], terms: TermsRates, ctx: Omit<RateContext, "planKey">): Commission {
  const out: CommissionLine[] = allocate(base, lines).map((line) => {
    const rate = rateFor(terms, { ...ctx, planKey: line.planKey });
    return { planKey: line.planKey, share: line.share, rateBp: rate.rateBp, by: rate.by };
  });
  const amount = out.reduce((s, l) => s + mulDivFloor(l.share, l.rateBp, BP), 0);
  const total = Math.max(0, whole(base));
  return { amount, rateBp: amount === 0 || total === 0 ? 0 : Math.round((amount * BP) / total), lines: out };
}

// ─── Refunds, credit notes, voids ────────────────────────────────────────────────────────────────

const NOT_PAID = new Set(["VOID", "UNCOLLECTIBLE", "OPEN", "DRAFT"]);

/**
 * How much of an invoice is reversed now (spec §5.6). An invoice that was accrued and is no longer
 * PAID is reversed whole; otherwise the larger of what was refunded and what was credited, up to the
 * total. The base's part is proportional, and never goes back down from what was reversed before
 * (`state.reversedBase`) nor past the base — a refund cannot be un-refunded here; staff adjust instead.
 */
export function reversedBaseOf(
  invoice: { status: string; total: number; amountRefunded: number; amountCredited: number },
  accrued: boolean,
  state: { base: number; reversedBase: number },
): Reversal {
  const total = Math.max(0, whole(invoice.total));
  const refunded = Math.max(0, whole(invoice.amountRefunded));
  const credited = Math.max(0, whole(invoice.amountCredited));
  const voided = accrued && NOT_PAID.has(invoice.status);
  const reversedGross = voided ? total : Math.min(total, Math.max(refunded, credited));
  const base = Math.max(0, whole(state.base));
  const proportional = total > 0 ? mulDivFloor(base, reversedGross, total) : 0;
  const reversedBase = Math.min(base, Math.max(Math.max(0, whole(state.reversedBase)), proportional));
  return { reversedGross, reversedBase, reason: voided ? "void" : credited > refunded ? "credit" : "refund" };
}

/** How much of an accrual entry should stand reversed at `reversedBase`: `floor(|amount| × reversedBase / base)`. */
export function reversalTarget(entry: { amount: number; base: number }, reversedBase: number): number {
  const base = whole(entry.base);
  if (base <= 0) return 0;
  return mulDivFloor(Math.abs(whole(entry.amount)), Math.min(base, whole(reversedBase)), base);
}

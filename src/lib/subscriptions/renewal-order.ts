import type { BillingCycle } from "@prisma/client";

/**
 * Turning an expiring subscription into the order that replaces it.
 *
 * Pure, and worth checking, because two of the numbers here are quietly expensive to get wrong:
 *
 *   · **The price.** A renewal is priced from `fullTermUnitPrice`, never from `unitPrice`. On a
 *     subscription with seats added mid-term, `unitPrice` on those rows is a pro-rated figure — the
 *     ₹4,405 charged for eight months of a ₹6,000 seat — and renewing at it under-bills by the part
 *     of the year that had already gone. Silent, in the customer's favour, and nothing else notices.
 *   · **The quantity.** The renewal covers the parent *and* everything co-terminating with it. Ten
 *     seats plus five added in November is a twenty-seat renewal, not a ten-seat one.
 *
 * The dates are the third: a new term starts the day after the old one ends, so there is no gap and
 * no overlapping day being charged twice.
 */

const DAY = 86400000;

function toUtcDate(value: Date | string): Date {
  const d = new Date(value);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Adds months, clamping to the end of the target month.
 *
 * 31 January plus one month is 28 February, not 3 March — which is what naive date arithmetic
 * produces and what puts a renewal term three days out for the rest of its life.
 */
export function addMonths(date: Date, months: number): Date {
  const d = toUtcDate(date);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d.getUTCDate(), lastDay)));
}

export const cycleMonths: Record<BillingCycle, number> = {
  MONTHLY: 1,
  QUARTERLY: 3,
  ANNUAL: 12,
  // Nothing recurs. Kept as a year for the instalment arithmetic's sake; nothing renews by it.
  ONE_TIME: 12,
};

export type Term = { startDate: string; endDate: string; days: number };

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** The term a subscription is given when nothing says otherwise: a year. */
export const DEFAULT_TERM_MONTHS = 12;

/**
 * How many months a term ran, from its own dates: the whole months from its first day to the day after
 * its last (1 April to 31 March is 12, to 31 March three years on is 36). A term that isn't whole
 * months — a co-termed one, or dates typed by hand — is its nearest number of months, never under one.
 * Null without both dates.
 */
export function termMonthsOf(start: Date | string | null | undefined, end: Date | string | null | undefined): number | null {
  if (!start || !end) return null;
  const from = toUtcDate(start);
  const after = new Date(toUtcDate(end).getTime() + DAY);
  if (after <= from) return null;
  for (let months = 1; months <= 120; months++) {
    const step = addMonths(from, months).getTime();
    if (step === after.getTime()) return months;
    if (step > after.getTime()) break;
  }
  return Math.max(1, Math.round((after.getTime() - from.getTime()) / DAY / 30.4375));
}

/** The terms the order form offers as a quick pick, in months; anything else is typed as a date. */
export const TERM_CHOICES: readonly { months: number; label: string }[] = [
  { months: 1, label: "1 month" },
  { months: 3, label: "3 months" },
  { months: 12, label: "1 year" },
  { months: 24, label: "2 years" },
  { months: 36, label: "3 years" },
];

/** The last day of a term this many months long from `start` (yyyy-mm-dd): the day before the next would begin. */
export function termEndFor(start: string, months: number): string {
  return iso(new Date(addMonths(toUtcDate(start), months).getTime() - DAY));
}

/**
 * The term that follows this one: as long as this one was (a three-year deal renews for three years, a
 * monthly one for a month — the term is the order's, not the product's), a year when its length can't
 * be told.
 *
 * Starts the day after the previous expiry — not on it. A term running 10/08/2026 to 09/08/2027
 * renews as 10/08/2027 to 09/08/2028: no gap in cover, and no day billed on both orders.
 */
export function nextTerm(params: { previousStart?: Date | string | null; previousEnd: Date | string; termMonths?: number | null }): Term {
  const start = new Date(toUtcDate(params.previousEnd).getTime() + DAY);
  const months = params.termMonths ?? termMonthsOf(params.previousStart, params.previousEnd) ?? DEFAULT_TERM_MONTHS;
  // One cycle forward, then back a day, so the term ends the day before the next would begin.
  const end = new Date(addMonths(start, months).getTime() - DAY);
  return {
    startDate: iso(start),
    endDate: iso(end),
    days: Math.round((end.getTime() - start.getTime()) / DAY) + 1,
  };
}

export type RenewalSource = {
  quantity: number;
  unitPrice: number | null;
  fullTermUnitPrice: number | null;
  /** The term being renewed: the next one is as long. */
  startDate?: Date | string | null;
  endDate: Date | string | null;
  /** The parent plus its addons, already totalled — see `renewalGroup`. */
  group?: { totalQuantity: number; renewalValue: number; incomplete: boolean; note: string } | null;
};

export type RenewalDraft = {
  quantity: number;
  unitPrice: number | null;
  term: Term | null;
  value: number | null;
  /** What somebody should be told before they punch it, in plain words. */
  warnings: string[];
};

/** The prefilled renewal order, and anything about it worth saying out loud first. */
export function renewalOrderDraft(source: RenewalSource): RenewalDraft {
  const warnings: string[] = [];

  const quantity = source.group?.totalQuantity ?? source.quantity;
  if (source.group && source.group.totalQuantity > source.quantity) {
    warnings.push(
      `Renewing ${source.group.totalQuantity} — the original ${source.quantity} plus ${source.group.totalQuantity - source.quantity} added mid-term, which come back together.`,
    );
  }

  // The full-term price, always. Falling back to `unitPrice` only where no full-term price was ever
  // recorded, and saying so — on a plain subscription the two are the same, and on one with addons
  // they are emphatically not.
  let unitPrice = source.fullTermUnitPrice;
  if (unitPrice === null) {
    unitPrice = source.unitPrice;
    if (unitPrice !== null) {
      warnings.push("No full-term price on record, so this is the last price charged. Check it covers a whole term.");
    }
  }
  if (unitPrice === null) warnings.push("No price on the original at all — put one in before this goes for approval.");
  if (source.group?.incomplete) warnings.push(source.group.note);

  const term = source.endDate ? nextTerm({ previousStart: source.startDate, previousEnd: source.endDate }) : null;
  if (!term) warnings.push("The original has no expiry date, so the new term has to be set by hand.");

  return {
    quantity,
    unitPrice,
    term,
    value: unitPrice === null ? null : Math.round(unitPrice * quantity * 100) / 100,
    warnings,
  };
}

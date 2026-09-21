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
  // Nothing recurs, so there is no next term to compute. Treated as a year so the form still opens
  // with something sensible for whoever is renewing a perpetual licence's support.
  ONE_TIME: 12,
};

export type Term = { startDate: string; endDate: string; days: number };

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The term that follows this one.
 *
 * Starts the day after the previous expiry — not on it. A term running 10/08/2026 to 09/08/2027
 * renews as 10/08/2027 to 09/08/2028: no gap in cover, and no day billed on both orders.
 */
export function nextTerm(params: { previousEnd: Date | string; billingCycle?: BillingCycle | null }): Term {
  const start = new Date(toUtcDate(params.previousEnd).getTime() + DAY);
  const months = cycleMonths[params.billingCycle ?? "ANNUAL"] ?? 12;
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
  endDate: Date | string | null;
  billingCycle?: BillingCycle | null;
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

  const term = source.endDate ? nextTerm({ previousEnd: source.endDate, billingCycle: source.billingCycle }) : null;
  if (!term) warnings.push("The original has no expiry date, so the new term has to be set by hand.");

  return {
    quantity,
    unitPrice,
    term,
    value: unitPrice === null ? null : Math.round(unitPrice * quantity * 100) / 100,
    warnings,
  };
}

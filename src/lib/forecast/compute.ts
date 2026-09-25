import { AFTER, BEFORE, UNDATED, bucketFor, type Period } from "@/lib/forecast/periods";
import type { OpenStage } from "@/lib/forecast/stages";

/**
 * The forecasts themselves — sales, renewals, collections, AMC opportunities — as pure functions of
 * rows already loaded, laid into periods.
 *
 * Every figure is before GST, like the order value targets are measured in, so a forecast and the
 * target beside it are the same kind of number. Nothing is stored: a forecast is only ever as good
 * as the data at the moment it is asked, and a stored one stops being true the moment a deal moves.
 */

const round = (n: number) => Math.round(n * 100) / 100;

/** Each period's cells, plus the ones outside it: before the first, after the last, undated. */
export type Buckets<T> = { periods: Record<string, T>; before: T; after: T; undated: T };

function buckets<T>(periods: Period[], empty: () => T): Buckets<T> {
  return { periods: Object.fromEntries(periods.map((p) => [p.key, empty()])), before: empty(), after: empty(), undated: empty() };
}

function cellFor<T>(b: Buckets<T>, key: string): T {
  if (key === BEFORE) return b.before;
  if (key === AFTER) return b.after;
  if (key === UNDATED) return b.undated;
  return b.periods[key]!;
}

// ─── Sales ───────────────────────────────────────────────────────────────────

export type Deal = {
  id: string;
  stage: OpenStage;
  /** Before GST. Null when neither a proposal nor an estimate says. */
  value: number | null;
  closeDate: Date | string | null;
};

export type SalesCell = {
  deals: number;
  /** Every open deal's value. */
  pipeline: number;
  /** Proposal sent or further. */
  bestCase: number;
  /** In negotiation. */
  commit: number;
  /** Each deal's value times its stage's weight. */
  weighted: number;
  /** Deals with no value at all, counted so they are not silently zero. */
  unvalued: number;
};

const emptySales = (): SalesCell => ({ deals: 0, pipeline: 0, bestCase: 0, commit: 0, weighted: 0, unvalued: 0 });

/**
 * Open deals by when they are expected to close. A deal whose close date has already passed is
 * "slipped" (the before bucket) rather than quietly counted in this month — somebody needs to put a
 * new date on it, and the forecast says so instead of guessing one.
 */
export function forecastSales(
  deals: Deal[],
  periods: Period[],
  weights: Record<OpenStage, number>,
  /** The start of today. A close date before it has slipped, even one earlier this month. */
  today?: Date,
): Buckets<SalesCell> {
  const out = buckets(periods, emptySales);
  for (const deal of deals) {
    const slipped = today !== undefined && deal.closeDate !== null && new Date(deal.closeDate).getTime() < today.getTime();
    const cell = cellFor(out, slipped ? BEFORE : bucketFor(deal.closeDate, periods));
    cell.deals += 1;
    if (deal.value === null) {
      cell.unvalued += 1;
      continue;
    }
    cell.pipeline += deal.value;
    if (deal.stage === "PROPOSAL_SENT" || deal.stage === "NEGOTIATION") cell.bestCase += deal.value;
    if (deal.stage === "NEGOTIATION") cell.commit += deal.value;
    cell.weighted += (deal.value * (weights[deal.stage] ?? 0)) / 100;
  }
  for (const cell of [...Object.values(out.periods), out.before, out.after, out.undated]) {
    cell.pipeline = round(cell.pipeline);
    cell.bestCase = round(cell.bestCase);
    cell.commit = round(cell.commit);
    cell.weighted = round(cell.weighted);
  }
  return out;
}

// ─── Renewals ────────────────────────────────────────────────────────────────

export type RenewalRate = { rate: number; sample: number; source: "learned" | "standard" };
export const STANDARD_RENEWAL_RATE = 80;
export const MIN_RENEWAL_SAMPLE = 8;

/**
 * Of the subscriptions that ran out in the last year, the share that was renewed — overall, and per
 * brand where a brand has history enough. A Microsoft seat and an Autodesk licence do not renew at
 * the same rate, and a forecast that pretends they do is wrong about both.
 */
export function learnRenewalRates(history: { brand: string | null; renewed: boolean }[]): {
  overall: RenewalRate;
  byBrand: Record<string, RenewalRate>;
} {
  const rateOf = (rows: { renewed: boolean }[], fallback: number): RenewalRate =>
    rows.length >= MIN_RENEWAL_SAMPLE
      ? { rate: Math.round((rows.filter((r) => r.renewed).length / rows.length) * 100), sample: rows.length, source: "learned" }
      : { rate: fallback, sample: rows.length, source: "standard" };
  const overall = rateOf(history, STANDARD_RENEWAL_RATE);
  const brands = [...new Set(history.map((h) => h.brand).filter((b): b is string => !!b))];
  const byBrand: Record<string, RenewalRate> = {};
  // A brand without enough history borrows the overall rate rather than the standard one.
  for (const brand of brands) byBrand[brand] = rateOf(history.filter((h) => h.brand === brand), overall.rate);
  return { overall, byBrand };
}

export type RenewalItem = {
  id: string;
  endDate: Date | string;
  brand: string | null;
  /** The full-term value of the subscription and its co-terminating addons, before GST. */
  value: number;
  outcome: "RENEWED" | "LOST" | "OPEN";
};

export type RenewalCell = { due: number; dueValue: number; renewed: number; renewedValue: number; lost: number; lostValue: number; open: number; expected: number };
const emptyRenewals = (): RenewalCell => ({ due: 0, dueValue: 0, renewed: 0, renewedValue: 0, lost: 0, lostValue: 0, open: 0, expected: 0 });

/**
 * Renewals by the month they fall due. Renewed ones count at their value — that money is booked; lost
 * ones at nothing; open ones at their value times the rate their brand actually renews at. The before
 * bucket is what has already lapsed without a renewal: late renewals do happen, so it is still expected
 * at the same rate, and shown apart so nobody mistakes it for this month's business.
 */
export function forecastRenewals(
  items: RenewalItem[],
  periods: Period[],
  rates: { overall: RenewalRate; byBrand: Record<string, RenewalRate> },
): Buckets<RenewalCell> {
  const out = buckets(periods, emptyRenewals);
  for (const item of items) {
    const cell = cellFor(out, bucketFor(item.endDate, periods));
    cell.due += 1;
    cell.dueValue += item.value;
    if (item.outcome === "RENEWED") {
      cell.renewed += 1;
      cell.renewedValue += item.value;
      cell.expected += item.value;
    } else if (item.outcome === "LOST") {
      cell.lost += 1;
      cell.lostValue += item.value;
    } else {
      cell.open += 1;
      const rate = (item.brand ? rates.byBrand[item.brand] : undefined) ?? rates.overall;
      cell.expected += (item.value * rate.rate) / 100;
    }
  }
  for (const cell of [...Object.values(out.periods), out.before, out.after, out.undated]) {
    cell.dueValue = round(cell.dueValue);
    cell.renewedValue = round(cell.renewedValue);
    cell.lostValue = round(cell.lostValue);
    cell.expected = round(cell.expected);
  }
  return out;
}

// ─── Collections ─────────────────────────────────────────────────────────────

export type OpenBill = {
  id: string;
  dueOn: Date | string;
  /** Still owed. */
  balance: number;
  /** The customer's average lateness from the credit engine; null for a customer with no history. */
  averageDaysLate: number | null;
};

const DAY = 86_400_000;

/**
 * When a bill will actually be paid: its due date, pushed back by however late this customer usually
 * is. A customer who is early on average is not assumed to be early this time.
 */
export function expectedOn(bill: Pick<OpenBill, "dueOn" | "averageDaysLate">): Date {
  const late = Math.max(0, Math.round(bill.averageDaysLate ?? 0));
  return new Date(new Date(bill.dueOn).getTime() + late * DAY);
}

export type CollectionCell = { bills: number; dueAsWritten: number; expected: number };
const emptyCollections = (): CollectionCell => ({ bills: 0, dueAsWritten: 0, expected: 0 });

/**
 * Money expected in, by period — beside what the invoices say is due in it, so the gap between the
 * two is the slippage this customer base is known for.
 *
 * A bill already past due, or expected before today, is "overdue" (the before bucket) rather than
 * pretended into this week: when it will arrive is the one thing nobody knows.
 */
export function forecastCollections(bills: OpenBill[], periods: Period[], today: Date): Buckets<CollectionCell> & { overdue: CollectionCell } {
  const out = buckets(periods, emptyCollections);
  const overdue = emptyCollections();
  for (const bill of bills) {
    if (bill.balance <= 0) continue;
    const due = new Date(bill.dueOn);
    if (due.getTime() < today.getTime()) {
      overdue.bills += 1;
      overdue.dueAsWritten += bill.balance;
      overdue.expected += bill.balance;
      continue;
    }
    const dueCell = cellFor(out, bucketFor(due, periods));
    dueCell.dueAsWritten += bill.balance;
    const expectedCell = cellFor(out, bucketFor(expectedOn(bill), periods));
    expectedCell.bills += 1;
    expectedCell.expected += bill.balance;
  }
  for (const cell of [...Object.values(out.periods), out.before, out.after, out.undated, overdue]) {
    cell.dueAsWritten = round(cell.dueAsWritten);
    cell.expected = round(cell.expected);
  }
  return { ...out, overdue };
}

// ─── Warranty → AMC ──────────────────────────────────────────────────────────

export type WarrantyAsset = { id: string; companyId: string; warrantyEndsOn: Date | string };
export type AmcCell = { machines: number; customers: number };

/**
 * Customers' machines coming out of warranty with no AMC to follow — the service contract business
 * waiting to be sold. Counted in machines and in customers, because it is sold by customer.
 */
export function forecastAmc(assets: WarrantyAsset[], periods: Period[]): Buckets<AmcCell> {
  const customers = new Map<string, Set<string>>();
  const out = buckets<AmcCell>(periods, () => ({ machines: 0, customers: 0 }));
  for (const asset of assets) {
    const key = bucketFor(asset.warrantyEndsOn, periods);
    cellFor(out, key).machines += 1;
    if (!customers.has(key)) customers.set(key, new Set());
    customers.get(key)!.add(asset.companyId);
  }
  for (const [key, set] of customers) cellFor(out, key).customers = set.size;
  return out;
}

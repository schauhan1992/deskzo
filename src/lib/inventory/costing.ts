import { proportionPaise, unitCost4, valuePaise } from "@/lib/accounts/money";

/**
 * What an issue of stock costs, and how it draws down the receipts still on hand (owner, 22 Oct 2026).
 *
 * Two methods, chosen once per company in Accounts settings:
 *
 *   · **Weighted average** — an issue costs its share of the balance's value: q of Q units worth V costs
 *     V × q / Q. Taking the whole balance takes exactly its value, so nothing is left behind.
 *   · **FIFO** — an issue costs what its oldest receipts cost, layer by layer.
 *
 * Under both, the receipts on hand (`layers`) are drawn down oldest first, because that is how stock is
 * physically used and what stock aging reads; only under FIFO do they decide the cost.
 *
 * Stock issued beyond what is on hand — only where the company allows negative stock — costs the last cost
 * known (the average, the newest layer's, or the item's cost price) and leaves the balance owing that.
 *
 * Pure, in whole paise and thousandths (src/lib/accounts/money.ts), so check:inventory can hold every
 * figure to it without a database.
 */

export type CostingMethodKey = "WEIGHTED_AVERAGE" | "FIFO";

/** A receipt still (partly) on hand, oldest first. */
export type CostLayer = { id?: string; remainingMilli: number; cost4: number };

export type BalanceState = { qtyMilli: number; valuePaise: number };

export type IssueCosting = {
  /** The issue's value at cost, in paise — positive. */
  valuePaise: number;
  /** How much to take from each layer, by its index in the list given. */
  takes: { index: number; takeMilli: number }[];
  /** What was issued beyond the stock on hand. */
  shortfallMilli: number;
};

/** The average cost of a balance, in ten-thousandths of a rupee — 0 when nothing is on hand. */
export function averageCost4(balance: BalanceState): number {
  return balance.qtyMilli > 0 ? unitCost4(balance.valuePaise, balance.qtyMilli) : 0;
}

/**
 * Costs an issue of `issueMilli` from a balance and its layers. `fallbackCost4` prices anything issued
 * beyond what is on hand when there is nothing on hand to price it from.
 */
export function costIssue(
  method: CostingMethodKey,
  balance: BalanceState,
  layers: readonly CostLayer[],
  issueMilli: number,
  fallbackCost4: number,
): IssueCosting {
  if (issueMilli <= 0) return { valuePaise: 0, takes: [], shortfallMilli: 0 };

  // The layers drawn down oldest first, whatever the method.
  const takes: { index: number; takeMilli: number }[] = [];
  let left = issueMilli;
  let fifoValue = 0;
  let lastCost4: number | null = null;
  layers.forEach((layer, index) => {
    if (layer.remainingMilli > 0) lastCost4 = layer.cost4;
    if (left <= 0 || layer.remainingMilli <= 0) return;
    const take = Math.min(left, layer.remainingMilli);
    takes.push({ index, takeMilli: take });
    fifoValue += valuePaise(take, layer.cost4);
    left -= take;
  });

  const onHand = Math.max(0, balance.qtyMilli);
  const fromStock = Math.min(issueMilli, onHand);
  const shortfallMilli = issueMilli - fromStock;

  const taken = issueMilli - left;
  let value: number;
  if (method === "FIFO") {
    // Every layer emptied and the balance with them: its value exactly, so rounding per layer leaves no
    // stray paise on an empty balance.
    const emptiesAll = fromStock === onHand && left === 0 && shortfallMilli === 0;
    if (emptiesAll) {
      value = Math.max(0, balance.valuePaise);
    } else {
      // Stock on hand that no layer describes (a balance older than its layers) costs at the average; what
      // goes beyond the stock on hand costs the newest layer's price.
      const uncoveredOnHand = Math.max(0, fromStock - taken);
      const beyond = issueMilli - Math.max(taken, fromStock);
      value =
        fifoValue +
        valuePaise(uncoveredOnHand, averageCost4(balance) || lastCost4 || fallbackCost4) +
        valuePaise(Math.max(0, beyond), lastCost4 ?? (averageCost4(balance) || fallbackCost4));
    }
  } else {
    value = onHand > 0 ? proportionPaise(Math.max(0, balance.valuePaise), fromStock, onHand) : 0;
    if (shortfallMilli > 0) value += valuePaise(shortfallMilli, averageCost4(balance) || lastCost4 || fallbackCost4);
  }

  return { valuePaise: value, takes, shortfallMilli };
}

/** A balance after a receipt of `qtyMilli` worth `paise`. */
export function afterReceipt(balance: BalanceState, qtyMilli: number, paise: number): BalanceState {
  return { qtyMilli: balance.qtyMilli + qtyMilli, valuePaise: balance.valuePaise + paise };
}

/** A balance after an issue of `qtyMilli` costing `paise`. */
export function afterIssue(balance: BalanceState, qtyMilli: number, paise: number): BalanceState {
  return { qtyMilli: balance.qtyMilli - qtyMilli, valuePaise: balance.valuePaise - paise };
}

/** Days between a receipt and a day, for stock aging. */
export function ageInDays(receivedAt: Date, asOf: Date): number {
  return Math.max(0, Math.floor((asOf.getTime() - receivedAt.getTime()) / 86_400_000));
}

/** The aging buckets stock is reported in. */
export const AGING_BUCKETS = [
  { key: "0-30", label: "0–30 days", max: 30 },
  { key: "31-60", label: "31–60 days", max: 60 },
  { key: "61-90", label: "61–90 days", max: 90 },
  { key: "91-180", label: "91–180 days", max: 180 },
  { key: "181-365", label: "181–365 days", max: 365 },
  { key: "365+", label: "Over a year", max: Number.POSITIVE_INFINITY },
] as const;

export type AgingBucketKey = (typeof AGING_BUCKETS)[number]["key"];

export function agingBucketOf(days: number): AgingBucketKey {
  return AGING_BUCKETS.find((b) => days <= b.max)!.key;
}

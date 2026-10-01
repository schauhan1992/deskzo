import { calculateOrderAmount } from "@/lib/gst";
import { impliedMargin } from "@/lib/orders/handoff-rules";
import { expectedRebate, frontMargin, isBelowCost, unitCostOf, type RebateBasisKey } from "@/lib/rebates/rules";

/**
 * The figures the order-punching form shows while it is filled in — the total with GST, the price
 * against list, the cost, the margin and the rebates — worked out in one place from the values as
 * typed, so the summary, the credit check and the hints under the fields can never disagree.
 *
 * Pure: it reads what the form holds, not what the server will store. The rules are the server's
 * own (`calculateOrderAmount`, `frontMargin`, `unitCostOf`, `expectedRebate`), applied to the
 * same defaults the order schema applies — a blank quantity is one, a blank price is the list price.
 */

/** The part of the form the figures read. Every value is as typed: a string, a number, or blank. */
export type FigureValues = {
  quantity?: unknown;
  unitPrice?: unknown;
  quotedPurchasePrice?: unknown;
  dealPrice?: unknown;
  expenses?: ({ amount?: unknown } | null | undefined)[] | null;
  rebates?: ({ basis?: string | null; value?: unknown } | null | undefined)[] | null;
};

/** The product as the pickers hand it over: Decimal columns arrive as numbers or strings. */
export type FigureItem = { sellingPrice: unknown; taxRatePercent?: unknown };

export type OrderFigures = {
  /** As the order will record it: blank is one. */
  quantity: number;
  /** The catalogue price of one unit; null with no product chosen. */
  listPrice: number | null;
  /** Whether a price was typed, rather than the list price standing in for it. */
  priceTyped: boolean;
  /** What one unit sells for — the typed price, else the list price — when that is above zero. */
  unitPrice: number | null;
  /** How far a typed price sits under list, in percent; negative when it is above. Null when there is nothing to compare. */
  belowListPercent: number | null;
  subtotal: number;
  /** The product's GST rate in percent; zero when it has none. */
  taxRate: number;
  gstAmount: number;
  total: number;
  /** The distributor's price per unit, as typed. */
  quotePrice: number | null;
  /** The deal price per unit under a registration, as typed. */
  dealPrice: number | null;
  /** What one unit costs as far as the form knows: the deal price, else the distributor's price. */
  unitCost: number | null;
  costSource: "DEAL" | "QUOTE" | null;
  /** The margin at the distributor's price, before expenses. */
  quoteMargin: { margin: number; percent: number | null } | null;
  /** The margin at the deal price, before expenses. */
  dealMargin: { margin: number; percent: number | null } | null;
  expensesTotal: number;
  /** Sale less cost less expenses, before any rebate. Null until both prices are known. */
  frontMargin: number | null;
  /** The front margin as a share of the sale, one decimal. */
  frontMarginPercent: number | null;
  /** Sold under cost: a manager approves it before it goes ahead. */
  belowCost: boolean;
  /** Each rebate row's expected amount, in row order; null where it can't be worked out yet. */
  rebateExpected: (number | null)[];
  rebateTotal: number;
  /** Front margin plus the rebates expected. Null while the front margin is. */
  netMargin: number | null;
};

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** A typed amount as a number, or null for a blank or for anything that is not a number. */
export function typedAmount(raw: unknown): number | null {
  if (raw === "" || raw === undefined || raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function orderFigures(values: FigureValues, item: FigureItem | null | undefined): OrderFigures {
  const typedQuantity = typedAmount(values.quantity);
  const quantity = typedQuantity === null ? 1 : Math.max(0, typedQuantity);

  const listPrice = item ? typedAmount(item.sellingPrice) : null;
  const typedPrice = typedAmount(values.unitPrice);
  const salePrice = typedPrice ?? listPrice;
  const unitPrice = salePrice !== null && salePrice > 0 ? salePrice : null;
  const belowListPercent =
    typedPrice !== null && typedPrice > 0 && listPrice !== null && listPrice > 0 && typedPrice !== listPrice
      ? round1(((listPrice - typedPrice) / listPrice) * 100)
      : null;

  // A rate of zero is no GST, as the order page has always shown it.
  const rate = item ? typedAmount(item.taxRatePercent) : null;
  const amount = calculateOrderAmount({ quantity, unitPrice: unitPrice ?? 0, taxRatePercent: rate ? rate : null });

  const quotePrice = typedAmount(values.quotedPurchasePrice);
  const dealPrice = typedAmount(values.dealPrice);
  const cost = unitCostOf({ dealPrice, quotedPurchasePrice: quotePrice });
  const unitCost = cost?.cost ?? null;
  const costSource = cost?.from === "DEAL" || cost?.from === "QUOTE" ? cost.from : null;

  const expensesTotal = round2((values.expenses ?? []).reduce((sum, e) => sum + (typedAmount(e?.amount) ?? 0), 0));
  const front = frontMargin({ quantity, unitPrice, unitCost, expenses: expensesTotal });
  const revenue = unitPrice !== null ? unitPrice * quantity : 0;

  const rebateExpected = (values.rebates ?? []).map((r) => {
    const value = typedAmount(r?.value);
    if (!r || value === null || value <= 0) return null;
    const basis = (r.basis || "PURCHASE_VALUE") as RebateBasisKey;
    return expectedRebate(
      { basis, rate: basis === "AMOUNT" ? null : value, amount: basis === "AMOUNT" ? value : null },
      { quantity, unitPrice, unitCost },
    );
  });
  const rebateTotal = round2(rebateExpected.reduce<number>((sum, v) => sum + (v ?? 0), 0));

  return {
    quantity,
    listPrice,
    priceTyped: typedPrice !== null,
    unitPrice,
    belowListPercent,
    subtotal: round2(amount.subtotal),
    taxRate: amount.rate,
    gstAmount: amount.gstAmount,
    total: amount.total,
    quotePrice,
    dealPrice,
    unitCost,
    costSource,
    quoteMargin: quotePrice !== null && unitPrice !== null ? impliedMargin(unitPrice, quotePrice, quantity) : null,
    dealMargin: dealPrice !== null && unitPrice !== null ? impliedMargin(unitPrice, dealPrice, quantity) : null,
    expensesTotal,
    frontMargin: front,
    frontMarginPercent: front !== null && revenue > 0 ? round1((front / revenue) * 100) : null,
    belowCost: isBelowCost(unitPrice, unitCost),
    rebateExpected,
    rebateTotal,
    netMargin: front !== null ? round2(front + rebateTotal) : null,
  };
}

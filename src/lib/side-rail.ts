/**
 * The tools that live on the right edge of every screen.
 *
 * The test for putting something here is narrow: it has to be a thing somebody needs *while looking
 * at something else*. Ticking off a task, jotting a note, working out what a figure comes to with
 * tax on it — all things that interrupt whatever you were doing, and each of which currently means
 * leaving the page, losing your filters and navigating back.
 *
 * Anything that is the main work of a page does not belong here. A rail that becomes a second
 * navigation menu is one nobody reads, and the point of it is that there are few enough buttons to
 * recognise them by shape.
 */

export type SideRailTool = "tasks" | "notes" | "calculator" | "prorata" | "currency" | "lookup";

export const SIDE_RAIL_TOOLS: SideRailTool[] = [
  "tasks",
  "notes",
  "calculator",
  "prorata",
  "currency",
  "lookup",
];

/**
 * Where the open tool is remembered.
 *
 * `localStorage` rather than a cookie: it is a per-device preference with nothing sensitive in it,
 * and reading it on the client avoids sending the state to the server on every request. The panel
 * is closed on the server's first paint and opens once mounted — which is why the component reads
 * it through `useSyncExternalStore` rather than during render.
 */
export const SIDE_RAIL_STORAGE_KEY = "wroffy.rail";

export function parseTool(value: string | null | undefined): SideRailTool | null {
  return SIDE_RAIL_TOOLS.includes(value as SideRailTool) ? (value as SideRailTool) : null;
}

// ─── The calculator's arithmetic ────────────────────────────────────────────────────────────────

export const GST_RATES = [0, 5, 12, 18, 28] as const;

export type TaxSplit = {
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  tax: number;
  total: number;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * What a figure comes to with tax on it, or what it was before tax.
 *
 * Both directions, because both are asked constantly and getting the second one wrong is the
 * classic mistake: the tax inside an inclusive figure is `amount × rate / (100 + rate)`, not
 * `amount × rate / 100`. On ₹1,18,000 at 18% that is the difference between ₹18,000 and ₹21,240 —
 * an error of over three thousand rupees that looks perfectly plausible on a quote.
 *
 * The intra-state split halves the tax between CGST and SGST rather than computing each from the
 * rate, so the two always add back to exactly the total. Halving an odd number of paise leaves the
 * remainder on CGST, which is what the GST engine does with a document line.
 */
export function splitTax(amount: number, ratePercent: number, interState: boolean, inclusive: boolean): TaxSplit {
  const rate = Number.isFinite(ratePercent) ? ratePercent : 0;
  const value = Number.isFinite(amount) ? amount : 0;

  const taxable = inclusive ? round2((value * 100) / (100 + rate)) : round2(value);
  const total = inclusive ? round2(value) : round2(taxable * (1 + rate / 100));
  // Derived from the two rounded ends rather than computed separately, so the parts always add up
  // to the whole on screen.
  const tax = round2(total - taxable);

  if (interState) return { taxable, cgst: 0, sgst: 0, igst: tax, tax, total };

  /**
   * CGST takes the rounded half and SGST the remainder, which is the order computeLine uses in
   * src/lib/gst-engine.ts. It matters that it is the same order and not merely a similar one: the
   * point of this calculator is to say what the invoice will say, and a tool that puts the odd
   * paisa on the other line disagrees with the document by a paisa — which is exactly the sort of
   * discrepancy that gets queried and cannot be explained.
   */
  const half = round2(tax / 2);
  return { taxable, cgst: half, sgst: round2(tax - half), igst: 0, tax, total };
}

/**
 * A margin, both ways round.
 *
 * `markup` is what you add to cost; `margin` is what the profit is as a share of the selling price.
 * People say "thirty per cent" and mean either, and quoting the wrong one is how a deal that looked
 * profitable is not — a 30% markup is a 23% margin.
 */
export function marginOf(cost: number, price: number): { profit: number; marginPercent: number; markupPercent: number } {
  const c = Number.isFinite(cost) ? cost : 0;
  const p = Number.isFinite(price) ? price : 0;
  const profit = round2(p - c);
  return {
    profit,
    marginPercent: p === 0 ? 0 : round2((profit / p) * 100),
    markupPercent: c === 0 ? 0 : round2((profit / c) * 100),
  };
}

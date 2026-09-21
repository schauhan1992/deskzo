/**
 * Which cards a page has, and the order they come in before anybody moves them.
 *
 * A registry rather than the order they happen to be written in the JSX, for the same reason the
 * sidebar groups got one: the moment a layout is stored, the page's own order is only a default,
 * and a default that lives in markup is a default nobody can find. It is also what the action
 * validates against — without it, a hand-made request could put arbitrary strings in somebody's
 * layout row, and the page would render a run of empty slots.
 */

export type LayoutWidget = {
  key: string;
  label: string;
  /** "stat" takes one column, "wide" two. The same sizes the dashboard grid understands. */
  size: "stat" | "wide";
};

export type PageLayoutDefinition = {
  key: string;
  label: string;
  widgets: LayoutWidget[];
};

export const PAGE_LAYOUTS: PageLayoutDefinition[] = [
  {
    key: "accounting",
    label: "Accounting overview",
    // The order an accountant opening this page most likely wants: the shape of the year, then
    // what is owed either way, then the totals, then the reference cards nobody reads twice.
    widgets: [
      { key: "incomeExpense", label: "Income and expense", size: "wide" },
      { key: "topExpenses", label: "Top expenses", size: "stat" },
      { key: "cashFlow", label: "Cash flow", size: "wide" },
      { key: "receivables", label: "Total receivables", size: "stat" },
      { key: "payables", label: "Total payables", size: "stat" },
      { key: "statIncome", label: "Income this year", size: "stat" },
      { key: "statExpense", label: "Expenses this year", size: "stat" },
      { key: "statProfit", label: "Net profit or loss", size: "stat" },
      { key: "statAssets", label: "Total assets", size: "stat" },
      { key: "provenance", label: "Where the figures come from", size: "wide" },
      { key: "statements", label: "Statements", size: "wide" },
    ],
  },
];

const BY_KEY = new Map(PAGE_LAYOUTS.map((l) => [l.key, l]));

export function getPageLayoutDefinition(key: string): PageLayoutDefinition | undefined {
  return BY_KEY.get(key);
}

/**
 * The stored order, reconciled against what the page actually has.
 *
 * Stored keys first, in the order somebody left them, then anything the page has gained since —
 * appended rather than dropped. A widget added in a release must appear for people who had already
 * arranged the page, and it must not appear in the middle of an arrangement they chose.
 */
export function resolveLayout(key: string, stored: string[] | undefined): string[] {
  const def = getPageLayoutDefinition(key);
  if (!def) return [];
  const known = new Set(def.widgets.map((w) => w.key));
  const kept = (stored ?? []).filter((k) => known.has(k));
  const seen = new Set(kept);
  return [...kept, ...def.widgets.map((w) => w.key).filter((k) => !seen.has(k))];
}

/**
 * How a list screen is laid out: the full table, or a narrow list with one record open beside it.
 *
 * The choice is the person's, not the screen's — some people work through a list one record at a
 * time and want the split; some are scanning columns and want the table. It's stored per list
 * rather than globally because the same person often wants different things from Leads and from
 * Invoices.
 */
export type ViewMode = "list" | "split" | "cards";

/** Every list that offers the choice. The key is also the cookie's suffix. */
export const VIEW_MODE_KEYS = [
  "companies",
  "customers",
  "vendors",
  "resellers",
  "commission-parties",
  "leads",
  "orders",
  "renewals",
  "tickets",
  "documents",
  "workspace",
  "vault",
] as const;

export type ViewModeKey = (typeof VIEW_MODE_KEYS)[number];

/**
 * What each list offers, and what it opens in.
 *
 * Per list because they are not the same shape. Most of these are a table with an optional
 * reading pane beside it. The vault is a set of cards by nature — a stored login is half a dozen
 * facts and two buttons, not a row — and the table is the alternative for somebody scanning
 * expiry dates down a column rather than reading one record.
 *
 * Stated rather than inferred, so adding a list forces a decision about what it should open in
 * instead of quietly inheriting somebody else's.
 */
export const LAYOUTS: Record<ViewModeKey, { offers: readonly ViewMode[]; fallback: ViewMode }> = {
  companies: { offers: ["list", "split"], fallback: "list" },
  customers: { offers: ["list", "split"], fallback: "list" },
  vendors: { offers: ["list", "split"], fallback: "list" },
  resellers: { offers: ["list", "split"], fallback: "list" },
  "commission-parties": { offers: ["list", "split"], fallback: "list" },
  leads: { offers: ["list", "split"], fallback: "list" },
  orders: { offers: ["list", "split"], fallback: "list" },
  renewals: { offers: ["list", "split"], fallback: "list" },
  tickets: { offers: ["list", "split"], fallback: "list" },
  documents: { offers: ["list", "split"], fallback: "list" },
  workspace: { offers: ["list", "split"], fallback: "list" },
  vault: { offers: ["cards", "list"], fallback: "cards" },
};

export const DEFAULT_VIEW_MODE: ViewMode = "list";

export function viewModeCookie(key: ViewModeKey) {
  return `deskzo.view.${key}`;
}

/**
 * A stored value the list does not offer falls back to that list's own default.
 *
 * Which is what happens to somebody who used the split view on Companies and then opens the
 * vault: the cookies are per list, but a hand-edited or stale one must not render a layout the
 * page has no markup for.
 */
export function parseViewMode(key: ViewModeKey, value: string | undefined | null): ViewMode {
  const layout = LAYOUTS[key];
  return layout.offers.includes(value as ViewMode) ? (value as ViewMode) : layout.fallback;
}
/**
 * The query param naming the open record. Kept in the URL rather than component state so a
 * particular record in the split view is a link somebody can send.
 */
export const SELECTED_PARAM = "sel";

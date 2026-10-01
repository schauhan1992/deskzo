import type { PermissionKey } from "@/lib/permissions";

/**
 * What the search box in the header can search, one list at a time.
 *
 * Every scope is a list the app already has, searched the way that list searches — the same action,
 * the same `where`, the same scope rules — so the search box can never show somebody a record their
 * own list would not. It has no query of its own to get wrong.
 *
 * One scope at a time rather than everything at once: "Acme" is a customer, a dozen orders, three
 * invoices and a lead, and a mixed list of all of them is harder to use than the one you meant.
 * The chosen scope is remembered per browser.
 */
export type SearchScopeKey =
  | "customers"
  | "companies"
  | "leads"
  | "contacts"
  | "vendors"
  | "orders"
  | "renewals"
  | "proposals"
  | "invoices"
  | "tickets"
  | "projects"
  | "items";

export type SearchScope = {
  key: SearchScopeKey;
  /** "Search in Customers" */
  label: string;
  /** The list page, which takes the same text as `?q=` — where "See all results" goes. */
  listPath: string;
  /** Off when the module is off, or when its view permission is missing (the module check includes it). */
  module: string;
  /** A permission beyond the module's own, for a list inside a module that has one. */
  permission?: PermissionKey;
  /**
   * The display-ref prefix whose detail page accepts it in the URL (`/leads/LEAD-000123`), for the
   * "Open LEAD-000123" shortcut. Only where the detail page resolves refs — see src/lib/record-url.ts.
   */
  ref?: { prefix: string; path: string };
};

export const SEARCH_SCOPES: SearchScope[] = [
  { key: "customers", label: "Customers", listPath: "/customers", module: "companies", ref: { prefix: "COM", path: "/companies" } },
  { key: "companies", label: "Companies", listPath: "/companies", module: "companies", ref: { prefix: "COM", path: "/companies" } },
  { key: "leads", label: "Leads", listPath: "/leads", module: "companies", permission: "leads.view", ref: { prefix: "LEAD", path: "/leads" } },
  { key: "contacts", label: "Contacts", listPath: "/contacts", module: "contacts_library" },
  { key: "vendors", label: "Vendors", listPath: "/vendors", module: "vendors", ref: { prefix: "COM", path: "/companies" } },
  { key: "orders", label: "Orders", listPath: "/orders", module: "orders", ref: { prefix: "ORD", path: "/orders" } },
  { key: "renewals", label: "Renewals", listPath: "/renewals", module: "renewals" },
  { key: "proposals", label: "Proposals", listPath: "/sales/proposals", module: "sales_documents" },
  { key: "invoices", label: "Invoices", listPath: "/sales/invoices", module: "sales_documents" },
  { key: "tickets", label: "Tickets", listPath: "/tickets", module: "helpdesk", ref: { prefix: "TCK", path: "/tickets" } },
  { key: "projects", label: "Projects", listPath: "/projects", module: "projects" },
  { key: "items", label: "Items", listPath: "/items", module: "items", ref: { prefix: "ITM", path: "/items" } },
];

export function searchScope(key: string): SearchScope | undefined {
  return SEARCH_SCOPES.find((s) => s.key === key);
}

/** Where a query first lands, and the one remembered per browser. */
export const SEARCH_SCOPE_STORAGE_KEY = "deskzo.search-scope";

/** Shortest query worth sending: one letter matches half the database and helps nobody. */
export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_MAX_LENGTH = 100;
export const SEARCH_RESULT_LIMIT = 8;

/** The list page for a query — what Enter does, and what "See all results" links to. */
export function searchListHref(scope: SearchScope, query: string): string {
  const q = query.trim();
  return q ? `${scope.listPath}?q=${encodeURIComponent(q)}` : scope.listPath;
}

/**
 * "Open LEAD-000123" — when the query is a display ref in this scope's own form, or a bare number.
 *
 * Nothing is looked up: the link goes to the detail page, which decides whether this person may see
 * it and says "not found" when they may not. So the shortcut is offered on the shape of the text
 * alone, and can never confirm that somebody else's record exists.
 */
export function refShortcut(scope: SearchScope, query: string): { label: string; href: string } | null {
  if (!scope.ref) return null;
  const match = query.trim().match(/^(?:([A-Za-z]{2,4})-)?0*(\d{1,9})$/);
  if (!match) return null;
  const [, prefix, digits] = match;
  if (prefix && prefix.toUpperCase() !== scope.ref.prefix) return null;
  const seq = Number(digits);
  if (!Number.isSafeInteger(seq) || seq <= 0) return null;
  const ref = `${scope.ref.prefix}-${String(seq).padStart(6, "0")}`;
  return { label: `Open ${ref}`, href: `${scope.ref.path}/${ref}` };
}

/** One line in the results. `href` is always an in-app path. */
export type SearchHit = { id: string; title: string; subtitle: string | null; href: string };

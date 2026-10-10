/**
 * Which module a permission belongs to, for the role dialog on Staff & roles.
 *
 * The catalogue (src/lib/permissions.ts) groups permissions by what they are about — "Finance",
 * "People & HR" — and that is the fieldset each one sits in. Some of them are also about a module a
 * company can switch off or leave out of its plan (Payroll, Marketing, Projects…). Ticking "Run
 * payroll" for a role in a workspace whose Payroll module is off does nothing anybody can see until
 * it is switched on, so the dialog files those under their module and says when it is off.
 *
 * By key prefix, as `permissionGroup` does, with a few keys named outright where the prefix spans
 * more than one module or none. A permission with no module here is about the core of the app and
 * is never shown as switched off. Anything left out errs that way on purpose: a missing entry costs a
 * note, a wrong one would tell somebody a permission does nothing when it does.
 *
 * Dependency-free so the client dialog can use it.
 */

/** A permission's module: one key, or several when it does nothing only once all of them are off. */
type ModuleRef = string | readonly string[];

const BY_KEY: Record<string, ModuleRef> = {
  // Quotes and invoices are seen through either documents module; off only when both are.
  "documents.view": ["sales_documents", "purchase_documents"],
  "documents.issue": "sales_documents",
  "documents.send": "sales_documents",
  "documents.void": "sales_documents",
  "catalog.manage": "items",
  "collections.followUp": "receivables",
  "notes.broadcast": "notes",
  "tasks.delete": "tasks",
  "portal.manage": "customer_portal",
  // The Calls module's own view permission (src/lib/modules.ts).
  "calls.view": "calls",
  "workspace.manageAny": "workspace",
  "meetings.schedule": "calendar",
  // Hiring lives in the People (HR) module.
  "hiring.manage": "hr",
};

const BY_PREFIX: Record<string, ModuleRef> = {
  orders: "orders",
  products: "orders",
  projects: "projects",
  expenses: "expenses",
  ledger: "accounting",
  books: "accounting",
  revenue: "revenue_close",
  close: "revenue_close",
  visits: "visits",
  feedback: "feedback",
  forecast: "forecast",
  wins: "wins",
  tickets: "helpdesk",
  visitors: "visitors",
  targets: "targets",
  incentives: "incentives",
  hr: "hr",
  engagement: "engagement",
  payroll: "payroll",
  vault: "vault",
  cards: "cards",
  assets: "it_assets",
  marketing: "marketing",
  forms: "forms",
};

/** The module keys a permission depends on, or an empty list for the core of the app. */
export function permissionModules(key: string): string[] {
  if (key === "payments.manage") return []; // banking, assets and tax reports — not one module
  const named = BY_KEY[key] ?? BY_PREFIX[key.split(".")[0] ?? ""];
  if (!named) return [];
  return typeof named === "string" ? [named] : [...named];
}

/** A module as the dialog needs it: its name, and whether the company can use it now. */
export type ModuleState = { key: string; label: string; entitled: boolean; switchedOn: boolean };

/**
 * Why a permission's module is unavailable, or null when it is on. With several modules, it is on
 * when any of them is.
 */
export function moduleNote(moduleKeys: string[], states: Record<string, ModuleState>): string | null {
  if (moduleKeys.length === 0) return null;
  const known = moduleKeys.map((k) => states[k]).filter((s): s is ModuleState => Boolean(s));
  if (known.length === 0) return null;
  if (known.some((s) => s.entitled && s.switchedOn)) return null;
  const names = known.map((s) => s.label).join(" and ");
  if (known.every((s) => !s.entitled)) return `${names} isn't in this workspace's plan, so these do nothing here yet.`;
  return `${names} is switched off for the company. Ticked permissions take effect when it's switched on.`;
}

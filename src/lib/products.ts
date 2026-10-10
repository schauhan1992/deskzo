/**
 * What the platform sells, as products — the one place the names and their modules are written down.
 * Pure and client-safe: the website (its menus and product pages), the plan catalogue in the console
 * and the checks all read it.
 *
 * Owner decision, 1 Oct 2026: modules are sold on their own as products, the way a suite of apps is —
 * "Deskzo CRM", "Deskzo Books" — and **Deskzo One** is all of them in one workspace. A workspace may
 * hold several products at once (CRM and Books, say); Deskzo One already holds everything.
 *
 * A product is a set of module keys (src/lib/modules.ts). Products may share a module (orders is in
 * Inventory and in Subscriptions): a workspace gets the union, and a module's own `requires` are added
 * by entitlements as they always are. "Companies & Leads" is core, in every workspace whatever it buys.
 *
 * Product names are also reserved as workspace addresses (src/lib/workspace-names.ts), so each can
 * have an address of its own one day (books.<domain>).
 */

export type ProductKey =
  | "one"
  | "crm"
  | "books"
  | "people"
  | "desk"
  | "inventory"
  | "subscriptions"
  | "projects"
  | "campaigns"
  | "analytics"
  | "vault"
  | "cards";

export type Product = {
  key: ProductKey;
  /** What customers call it: "Deskzo CRM". */
  name: string;
  /** Its page on the website: "/crm". */
  path: string;
  /** One line, for menus and cards (≤ 80 characters). */
  tagline: string;
  /** The modules it switches on (src/lib/modules.ts keys). Empty for Deskzo One, which is every module. */
  modules: readonly string[];
  /**
   * The countries it is sold in; absent, everywhere. A product whose heart follows one country's rules
   * is sold only there: Books (India's accounting and GST) and People (owner decision, 1 Oct 2026 —
   * its payroll is India's PF, ESI, professional tax and TDS).
   */
  soldOnlyIn?: readonly string[];
  /** Where it sits in the website's Product menu. */
  group: "suite" | "sell" | "run" | "people";
};

export type AddOnKey = "revenue_close" | "copilot" | "seats";

export type AddOn = {
  key: AddOnKey;
  name: string;
  tagline: string;
  /** The modules it adds; empty when it adds an allowance rather than a module. */
  modules: readonly string[];
  /** The product it is bought with, when it needs one; null: any. */
  onProduct: ProductKey | null;
  /** Products that already include it, so it is never bought on top of them (owner decision, 1 Oct 2026: Revenue & Close comes with Deskzo One). */
  includedIn: readonly ProductKey[];
};

/** The product family's own name, before each product's. */
export const PRODUCT_FAMILY = "Deskzo";

/**
 * Modules every product comes with: the notification centre, tasks, sticky notes and saved lists —
 * the workspace's own furniture rather than anything a product is bought for.
 */
export const BASE_MODULES: readonly string[] = ["notifications", "tasks", "notes", "workspace"];

export const PRODUCTS: readonly Product[] = [
  {
    key: "one",
    name: "Deskzo One",
    path: "/one",
    tagline: "Every Deskzo product in one workspace, on one set of records",
    modules: [],
    group: "suite",
  },
  {
    key: "crm",
    name: "Deskzo CRM",
    path: "/crm",
    tagline: "Leads, pipeline, calls, field visits, targets and incentives",
    modules: ["companies", "contacts_library", "calls", "visits", "domains", "targets", "incentives", "wins", "tasks", "notes", "resellers", "commission_parties"],
    group: "sell",
  },
  {
    key: "books",
    name: "Deskzo Books",
    path: "/books",
    soldOnlyIn: ["IN"],
    tagline: "GST invoicing, accounting, payables, receivables and expenses",
    modules: ["items", "sales_documents", "purchase_documents", "payments", "receivables", "payables", "accounting", "expenses", "vendors"],
    group: "run",
  },
  {
    key: "people",
    name: "Deskzo People",
    path: "/people",
    soldOnlyIn: ["IN"],
    tagline: "HR, payroll, attendance, leave, recruitment and visitors",
    modules: ["hr", "payroll", "visitors", "engagement"],
    group: "people",
  },
  {
    key: "desk",
    name: "Deskzo Desk",
    path: "/desk",
    tagline: "Helpdesk tickets with SLAs, a customer portal and feedback",
    modules: ["helpdesk", "customer_portal", "feedback"],
    group: "sell",
  },
  {
    key: "inventory",
    name: "Deskzo Inventory",
    path: "/inventory",
    tagline: "Items and stock, orders, purchases and IT assets",
    modules: ["items", "orders", "purchase_documents", "vendors", "it_assets"],
    group: "run",
  },
  {
    key: "subscriptions",
    name: "Deskzo Subscriptions",
    path: "/subscriptions",
    tagline: "Recurring orders, renewals, add-ons and AMCs",
    modules: ["items", "orders", "renewals"],
    group: "sell",
  },
  {
    key: "projects",
    name: "Deskzo Projects",
    path: "/projects",
    tagline: "Projects with milestones, billing stages, risks and tasks",
    modules: ["projects", "tasks"],
    group: "run",
  },
  {
    key: "campaigns",
    name: "Deskzo Campaigns",
    path: "/campaigns",
    tagline: "Email journeys, forms and events, with consent built in",
    modules: ["marketing", "forms"],
    group: "sell",
  },
  {
    key: "analytics",
    name: "Deskzo Analytics",
    path: "/analytics",
    tagline: "Reports by any dimension, and the sales forecast",
    modules: ["reports", "forecast"],
    group: "run",
  },
  {
    key: "vault",
    name: "Deskzo Vault",
    path: "/vault",
    tagline: "Shared passwords and credentials, with owners and rotation",
    modules: ["vault"],
    group: "people",
  },
  {
    // Sold on its own and in One (owner, 10 Oct 2026). Leads from a card need the CRM; without it,
    // whoever shares back is kept as a card contact.
    key: "cards",
    name: "Deskzo Cards",
    path: "/cards",
    tagline: "Branded digital business cards, a QR code each, and leads from every meeting",
    modules: ["cards"],
    group: "sell",
  },
];

export const ADD_ONS: readonly AddOn[] = [
  { key: "revenue_close", name: "Revenue & Close", tagline: "Ind AS 115 revenue recognition and a month-end close", modules: ["revenue_close"], onProduct: "books", includedIn: ["one"] },
  { key: "copilot", name: "AI Copilot", tagline: "Questions about your data, answered by the AI provider you choose", modules: [], onProduct: null, includedIn: [] },
  { key: "seats", name: "More people", tagline: "Seats beyond what a plan includes", modules: [], onProduct: null, includedIn: [] },
];

export const PRODUCT_KEYS = PRODUCTS.map((p) => p.key);

export function productByKey(key: string | null | undefined): Product | null {
  return PRODUCTS.find((p) => p.key === key) ?? null;
}

/** The products a module belongs to (several, for a shared one like orders). */
export function productsOfModule(moduleKey: string): Product[] {
  return PRODUCTS.filter((p) => p.modules.includes(moduleKey));
}

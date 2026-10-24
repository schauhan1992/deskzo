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
 * by entitlements as they always are. Companies & contacts are core, in every workspace whatever it buys;
 * the lead pipeline is sold with Deskzo Pipeline, CRM and One (owner, 14 Oct 2026).
 *
 * Product names are also reserved as workspace addresses (src/lib/workspace-names.ts), so each can
 * have an address of its own one day (books.<domain>).
 */

export type ProductKey =
  | "one"
  | "crm"
  | "pipeline"
  | "books"
  | "people"
  | "desk"
  | "inventory"
  | "subscriptions"
  | "projects"
  | "campaigns"
  | "analytics"
  | "vault"
  | "cards"
  | "signatures";

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

export type AddOnKey = "revenue_close" | "copilot" | "seats" | "automate_plus" | "inbox";

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
 * Modules every product comes with: the notification centre, tasks, sticky notes, team chat and saved
 * lists — the workspace's own furniture rather than anything a product is bought for.
 */
export const BASE_MODULES: readonly string[] = ["notifications", "tasks", "notes", "chat", "workspace", "automate"];

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
    // Everything in Deskzo Pipeline too — its web forms and booking pages (owner, 14 Oct 2026).
    modules: ["companies", "leads", "contacts_library", "calls", "visits", "domains", "targets", "incentives", "wins", "tasks", "notes", "resellers", "commission_parties", "forms", "booking"],
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
    // A Bigin-like CRM for small teams (owner, 14 Oct 2026): team pipelines on a board, contacts, calls
    // and follow-ups, web forms and booking pages — less than Deskzo CRM, which holds all of it.
    key: "pipeline",
    name: "Deskzo Pipeline",
    path: "/pipeline",
    tagline: "A simple pipeline CRM for small teams: deals, contacts, follow-ups, bookings",
    modules: ["companies", "leads", "contacts_library", "calls", "forms", "booking"],
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
  {
    // Sold on its own and in One (owner, 10 Oct 2026). The free generator on the website leads here.
    key: "signatures",
    name: "Deskzo Signatures",
    path: "/signatures",
    tagline: "Company email signatures, kept in step and put into every mailbox",
    modules: ["signatures"],
    group: "sell",
  },
];

export const ADD_ONS: readonly AddOn[] = [
  { key: "revenue_close", name: "Revenue & Close", tagline: "Ind AS 115 revenue recognition and a month-end close", modules: ["revenue_close"], onProduct: "books", includedIn: ["one"] },
  // Deskzo AI credits on top of every plan's own (owner, 17 Oct 2026). The key is older than the name.
  { key: "copilot", name: "AI Plus", tagline: "More AI credits every month, on top of what your plan includes", modules: [], onProduct: null, includedIn: [] },
  { key: "seats", name: "More people", tagline: "Seats beyond what a plan includes", modules: [], onProduct: null, includedIn: [] },
  // Deskzo Automate's bigger limits (owner, 17 Oct 2026: ₹999 a month for the workspace). An allowance, never "included".
  {
    key: "automate_plus",
    name: "Automate Plus",
    tagline: "More workflows, 50,000 more steps a month, a year of run history and every connector, WhatsApp too",
    modules: [],
    onProduct: null,
    includedIn: [],
  },
  // The Customer inbox (owner, 24 Oct 2026: "let the platform admin choose") — an add-on staff may price and sell on its own,
  // or tick into any plan in the console; Deskzo One has every module, so it's there already.
  { key: "inbox", name: "Customer inbox", tagline: "Website chat with a bot, and WhatsApp, answered from one inbox", modules: ["inbox"], onProduct: null, includedIn: ["one"] },
];

/** A product's plan key in the catalogue — an identifier invitations and scripts name, so it never follows a rename of the brand. */
export const productPlanKey = (product: ProductKey) => `deskzo-${product}`;

export const PRODUCT_KEYS = PRODUCTS.map((p) => p.key);

export function productByKey(key: string | null | undefined): Product | null {
  return PRODUCTS.find((p) => p.key === key) ?? null;
}

/** The product whose page a link goes to ("/crm", "/crm#plans"); null for any other address. */
export function productByPath(href: string | null | undefined): Product | null {
  const path = href?.split(/[?#]/)[0]?.toLowerCase();
  return path ? (PRODUCTS.find((p) => p.path === path) ?? null) : null;
}

/** The products a module belongs to (several, for a shared one like orders). */
export function productsOfModule(moduleKey: string): Product[] {
  return PRODUCTS.filter((p) => p.modules.includes(moduleKey));
}

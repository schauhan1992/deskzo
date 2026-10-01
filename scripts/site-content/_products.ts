import type { IconName, RichInline, SiteBlock, SiteLink } from "../../src/components/site/blocks/types";
import { ADD_ONS, BASE_MODULES, PRODUCTS, productByKey, productsOfModule, type AddOnKey, type Product, type ProductKey } from "../../src/lib/products";
import { note, runs, type Feature } from "./_build";
import { byPath } from "./_catalog";
import type { SeedPage } from "./types";

/**
 * Where the website's products (src/lib/products.ts) meet its module pages (_catalog.ts, _product-*.ts):
 *
 *   · MODULES — every module key a product names, as the website shows it in a product's "What's in
 *     it": a label, an icon, one sentence true of the code, and the module page that describes it, or
 *     null where the site has none (such a module is listed without a link, never sent to a page
 *     invented for it);
 *   · PAGE_PLACES — each module page, and the module keys it describes, so the page can say which
 *     products it is in (productsOfModule over those keys). A page about something every workspace
 *     has says so; an add-on's page names the product it is bought with.
 *
 * The names of products and add-ons are never written here: they are read from products.ts.
 */

export type ModuleInfo = { label: string; icon: IconName; blurb: string; page: string | null };

export const MODULES: Record<string, ModuleInfo> = {
  // ── Sell & serve ──
  companies: { label: "Companies & leads", icon: "building", blurb: "Companies and their contacts, and a lead pipeline from new to won, with scores that explain themselves.", page: "/product/crm" },
  contacts_library: { label: "Contacts library", icon: "users", blurb: "Every contact across every company, clients, vendors and OEMs, in one list to search and filter.", page: "/product/crm" },
  calls: { label: "Calls", icon: "headset", blurb: "A phone icon on each record dials from your device and times the call; the outcome and any callback are logged.", page: "/product/crm" },
  visits: { label: "Field visits", icon: "map-pin", blurb: "Visits planned with a purpose, checked in on the day, written up, and the travel claimed against them.", page: "/product/crm" },
  domains: { label: "Domain intel", icon: "globe", blurb: "What public DNS and a company's website reveal: who runs its email, whether the domain is protected, and who hosts it.", page: null },
  targets: { label: "Targets", icon: "gauge", blurb: "Targets for people, teams and the company, measured from the records as they happen.", page: "/product/targets-incentives" },
  incentives: { label: "Incentives", icon: "rupee", blurb: "Incentive schemes with thresholds, bands and caps, worked out from what was achieved and approved by a manager.", page: "/product/targets-incentives" },
  wins: { label: "Sales wins", icon: "sparkles", blurb: "A wins wall with the month's sales leaderboard, and a TV screen for the sales floor.", page: "/product/targets-incentives" },
  resellers: { label: "Resellers", icon: "layers", blurb: "Channel partners who buy for their own customers, whose end customers are kept off limits to direct contact and marketing.", page: null },
  commission_parties: { label: "Commission parties", icon: "users", blurb: "Agents, brokers and referral partners you pay commission to, tracked apart from vendors.", page: null },
  helpdesk: { label: "Helpdesk", icon: "headset", blurb: "Support tickets with a type, a priority, an SLA target, an assigned agent and a comment thread.", page: "/product/helpdesk" },
  customer_portal: { label: "Customer portal", icon: "globe", blurb: "A page for each customer contact, opened from a personal link, with their subscriptions, invoices and tickets.", page: "/product/helpdesk" },
  feedback: { label: "Customer feedback", icon: "check", blurb: "A one-time link asks the customer to rate the person who helped and the product, on a scale of one to five.", page: "/product/helpdesk" },
  orders: { label: "Orders", icon: "file-text", blurb: "Sales punches the order, accounts approves the payment terms and purchasing sources it, with the margin on every order.", page: "/product/subscriptions-renewals" },
  renewals: { label: "Renewals", icon: "calendar", blurb: "Every subscription's expiry, what is due in the next 30 days, 60 days or 90 days, and a stage for each renewal.", page: "/product/subscriptions-renewals" },
  marketing: { label: "Marketing automation", icon: "megaphone", blurb: "Campaigns and triggered journeys built from your records, with every send checked against consent first.", page: "/product/marketing" },
  forms: { label: "Forms & events", icon: "calendar", blurb: "Enquiry forms, assessments and events with RSVPs, seat limits and an attendance register.", page: "/product/marketing" },
  projects: { label: "Projects", icon: "layers", blurb: "Client projects with milestones, billing stages, agreements, encrypted credentials, risks and weekly updates.", page: "/product/projects" },
  // ── Run the business ──
  items: { label: "Items & inventory", icon: "package", blurb: "One catalogue of goods, services, subscriptions and licences, with HSN or SAC codes, GST rates and stock for goods.", page: "/product/inventory" },
  sales_documents: { label: "Quotes & invoices", icon: "receipt", blurb: "Proposals, proformas, GST tax invoices, credit notes and delivery challans, with e-invoice and e-way bill steps in India.", page: "/product/quotes-invoices" },
  purchase_documents: { label: "Purchase orders & bills", icon: "file-text", blurb: "Purchase orders raised on vendors, and the bills they send back, with GST and TDS worked out.", page: "/product/purchases-payables" },
  payments: { label: "Payments", icon: "card", blurb: "Payments by bank transfer, UPI, cheque, card or cash, allocated against the invoices they settle.", page: "/product/payments-receivables" },
  receivables: { label: "Receivables", icon: "gauge", blurb: "What customers owe, aged from each invoice's due date, with statements and a credit rating for each customer.", page: "/product/payments-receivables" },
  payables: { label: "Payables", icon: "scroll", blurb: "What you owe vendors, aged from each bill's due date, with a statement for each vendor.", page: "/product/purchases-payables" },
  accounting: { label: "Accounting & GST", icon: "book", blurb: "A double-entry ledger that posts itself, financial statements, bank reconciliation, GSTR-1 and GSTR-3B, TDS and TCS.", page: "/product/accounting-gst" },
  expenses: { label: "Expenses", icon: "receipt", blurb: "Expense claims with receipts and GST, approved by a manager, reimbursed and posted to the ledger.", page: "/product/expenses" },
  vendors: { label: "Vendors", icon: "truck", blurb: "Vendors, OEMs, distributors and partners, kept apart from your customers, each with its onboarding status.", page: "/product/purchases-payables" },
  it_assets: { label: "IT assets", icon: "server", blurb: "Every machine and licence by serial number, with custody, warranty and AMC cover, and the consignments that move them.", page: "/product/assets" },
  reports: { label: "Reports", icon: "chart", blurb: "Any figure from orders, leads, tickets, invoices, payments or visits, broken down by anything else.", page: "/product/reports" },
  forecast: { label: "Forecast", icon: "sparkles", blurb: "Open deals weighted by each stage's real win rate, renewals and cash expected, period by period.", page: "/product/reports" },
  // ── People & security ──
  hr: { label: "HR", icon: "users", blurb: "Employee records, joining and exit checklists, HR letters, holidays, leave, attendance and hiring.", page: "/product/hr" },
  payroll: { label: "Payroll", icon: "rupee", blurb: "Salary structures, the monthly run and payslips, with PF, ESI and professional tax worked out.", page: "/product/payroll" },
  visitors: { label: "Visitor management", icon: "door", blurb: "A sign-in tablet for reception: visitors leave their details and a photo, and their host is told they have arrived.", page: null },
  engagement: { label: "Speak up & forms", icon: "mail", blurb: "An anonymous feedback channel, and forms, polls and votes HR can send to one person, a department or everyone.", page: null },
  vault: { label: "Credential vault", icon: "key", blurb: "The company's own logins, encrypted, opened with your own password, shared deliberately, every opening logged.", page: "/product/security" },
  // ── Every product's own ──
  tasks: { label: "Tasks", icon: "check", blurb: "To-dos with due dates and reminders, assigned to a person and linked to a company, lead or ticket.", page: null },
  notes: { label: "Sticky notes", icon: "file-text", blurb: "Quick notes kept to yourself, shared with your reporting line, or stuck to a company, lead or ticket.", page: null },
  notifications: { label: "Notifications", icon: "mail", blurb: "Everything the app has told you, searchable, with a switch for each kind.", page: null },
  workspace: { label: "Saved lists", icon: "layers", blurb: "Lists saved as filters, so they stay current as the records change.", page: "/product/crm" },
  // ── Add-ons ──
  revenue_close: { label: "Revenue & Close", icon: "calendar", blurb: "Revenue recognised as it is earned under Ind AS 115, prepaid and accrual schedules, and a month-end close.", page: "/product/revenue-close" },
};

/** The add-ons' own module pages. "More people" adds seats rather than a module, so it has none. */
export const ADD_ON_PAGES: Partial<Record<AddOnKey, string>> = { revenue_close: "/product/revenue-close", copilot: "/product/ai-copilot" };

/** The module pages the Product menu lists beside the add-ons: what every workspace has, each with its page. */
export const CAPABILITY_PAGES = ["/product/security", "/product/linked-workspaces", "/product/import-migration"] as const;

type PagePlace = { modules: readonly string[] } | { addOn: AddOnKey } | { everyProduct: true; alsoModules?: readonly string[] };

/** Each module page (_catalog.ts PRODUCT_GROUPS) and what it describes. */
export const PAGE_PLACES: Record<string, PagePlace> = {
  "/product/crm": { modules: ["companies", "contacts_library", "calls", "visits"] },
  "/product/quotes-invoices": { modules: ["sales_documents"] },
  "/product/subscriptions-renewals": { modules: ["orders", "renewals"] },
  "/product/payments-receivables": { modules: ["payments", "receivables"] },
  "/product/helpdesk": { modules: ["helpdesk", "customer_portal", "feedback"] },
  "/product/marketing": { modules: ["marketing", "forms"] },
  "/product/projects": { modules: ["projects"] },
  "/product/accounting-gst": { modules: ["accounting"] },
  "/product/purchases-payables": { modules: ["purchase_documents", "payables", "vendors"] },
  "/product/inventory": { modules: ["items"] },
  "/product/expenses": { modules: ["expenses"] },
  // The fixed asset register is the ledger's; IT assets are their own module.
  "/product/assets": { modules: ["it_assets", "accounting"] },
  "/product/reports": { modules: ["reports", "forecast"] },
  "/product/hr": { modules: ["hr"] },
  "/product/payroll": { modules: ["payroll"] },
  // Attendance, leave and hiring are all the HR module's.
  "/product/attendance": { modules: ["hr"] },
  "/product/leave": { modules: ["hr"] },
  "/product/recruitment": { modules: ["hr"] },
  "/product/targets-incentives": { modules: ["targets", "incentives", "wins"] },
  "/product/revenue-close": { addOn: "revenue_close" },
  "/product/ai-copilot": { addOn: "copilot" },
  // Roles, sign-in rules and the logs are every workspace's; the vault is a module (and a product).
  "/product/security": { everyProduct: true, alsoModules: ["vault"] },
  // Branches and their GSTINs number and tax the invoices and returns: quotes and invoices, and the ledger.
  "/product/multi-branch-gst": { modules: ["sales_documents", "accounting"] },
  "/product/linked-workspaces": { everyProduct: true },
  "/product/import-migration": { everyProduct: true },
};

const ONE = productByKey("one")!;
const link = (p: Product): [string, string] => [p.name, p.path];

/** "A, B and C" as runs, each a link to its product's page. */
function productList(products: Product[]): (string | [string, string])[] {
  const out: (string | [string, string])[] = [];
  products.forEach((p, i) => {
    if (i > 0) out.push(i === products.length - 1 ? " and " : ", ");
    out.push(link(p));
  });
  return out;
}

/** The products a module page's modules are in (productsOfModule over its keys), in products.ts order. */
export function productsOfPage(path: string): Product[] {
  const place = PAGE_PLACES[path];
  if (!place) throw new Error(`No product place for ${path}: add it to PAGE_PLACES.`);
  const keys = "modules" in place ? place.modules : "everyProduct" in place ? (place.alsoModules ?? []) : [];
  const found = new Set(keys.flatMap((k) => productsOfModule(k).map((p) => p.key)));
  return PRODUCTS.filter((p) => found.has(p.key));
}

/** The line under a module page's header: which products it is in, each linked. */
export function productLine(path: string): RichInline {
  const place = PAGE_PLACES[path];
  if (!place) throw new Error(`No product place for ${path}: add it to PAGE_PLACES.`);
  if ("addOn" in place) {
    const addOn = ADD_ONS.find((a) => a.key === place.addOn)!;
    const on = addOn.onProduct ? productByKey(addOn.onProduct) : null;
    return on ? runs(`${addOn.name} is an add-on to `, link(on), ".") : runs(`${addOn.name} is an add-on to any {siteName} product, `, link(ONE), " included.");
  }
  if ("everyProduct" in place) {
    const also = productsOfPage(path);
    return runs("In every {siteName} product, and in ", link(ONE), ".", ...(also.length ? [` The ${MODULES[place.alsoModules![0]!]!.label.toLowerCase()} is also a product of its own: `, ...productList(also), "."] : []));
  }
  const products = productsOfPage(path);
  if (!products.length) throw new Error(`${path}'s modules are in no product.`);
  return runs("Part of ", ...productList(products), ", and of ", link(ONE), ".");
}

/** A module page with its product line under the header (the hero), as a note of its own. */
export function withProductLine(page: SeedPage): SeedPage {
  const path = `/${page.slug}`;
  const blocks = [...page.document.blocks];
  const at = blocks.findIndex((b) => b.type === "hero" || b.type === "pageHeader") + 1;
  const line: SiteBlock = { id: `${page.slug.replace(/\//g, "-")}-products`, type: "richText", props: { content: [note(productLine(path))] } };
  blocks.splice(at, 0, line);
  return { ...page, document: { ...page.document, blocks } };
}

/** "What's in it": a product's modules as cards, each linking to its module page where the site has one. */
export function moduleCards(product: Product): Feature[] {
  return product.modules.map((key) => {
    const m = MODULES[key];
    if (!m) throw new Error(`${product.name} names a module the website doesn't describe: ${key}. Add it to MODULES.`);
    const linkTo: SiteLink | undefined = m.page ? { label: `${byPath(m.page).label} in detail`, href: m.page } : undefined;
    return { icon: m.icon, title: m.label, body: m.blurb, ...(linkTo ? { link: linkTo } : {}) };
  });
}

/** "Every product also comes with…": the base modules by their website labels. */
export function baseModulesLine(): string {
  const labels = BASE_MODULES.map((k) => MODULES[k]?.label.toLowerCase() ?? k);
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/** A product by key, for the pages: a typo in the data throws rather than publishing an empty name. */
export function product(key: ProductKey): Product {
  const p = productByKey(key);
  if (!p) throw new Error(`No product ${key} in src/lib/products.ts.`);
  return p;
}

/** "CRM" from "Deskzo CRM": the product's name less the family's, as a list of products reads. */
export function shortName(p: Product, family: string): string {
  return p.name.startsWith(`${family} `) ? p.name.slice(family.length + 1) : p.name;
}

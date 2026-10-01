import type { LucideIcon } from "lucide-react";
import { ClipboardPen, Trophy, DoorOpen, CalendarClock as CalendarClockIcon, MessagesSquare, ClipboardCheck, KeyRound, FolderKanban, BarChart4, StickyNote, Building2, CalendarDays, Fingerprint, IdCard, Plane, Target, UserRound, Package, PackageCheck, CalendarClock, Banknote, Users, Ticket, Truck, CheckSquare, Handshake, ShoppingCart, HandCoins, Store, FileText, FileCheck2, Receipt, ReceiptText, FileMinus2, ClipboardList, MapPin, Wallet, Scale, BookOpen, NotebookPen, ListTree, TrendingUp, Landmark, PhoneCall, Globe, LayoutList, BadgeCheck, UserPlus, PartyPopper, Waves, Boxes, FileSpreadsheet, Percent, Lock, Laptop, Gauge, MessageSquareQuote, Star, Megaphone, Route, ShieldBan, MailCheck, ScanSearch, Inbox, BellRing, Tags, ShieldCheck, Mail, Send, ListPlus, Combine, CalendarRange, Layers, Hourglass, ListChecks, PiggyBank, Coins } from "lucide-react";
import type { PermissionKey } from "@/lib/permissions";

/**
 * The keys a nav item is gated on, as a list.
 *
 * One place to normalise the two forms, so the sidebar and `check:rbac` cannot disagree about what
 * a string-or-array permission means.
 */
export function navPermissionKeys(item: { permission?: string | readonly string[] }): string[] {
  if (!item.permission) return [];
  return Array.isArray(item.permission) ? [...item.permission] : [item.permission as string];
}

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shown only to a workspace in one of these countries (ISO 3166-1 alpha-2) — see `countries` below. */
  countries?: readonly string[];
  /**
   * Hidden unless the viewer holds this permission.
   *
   * Module toggles answer "does this company use the feature"; this answers "is it any use to
   * this person". Without it an ordinary employee sees Biometric and Payroll in the sidebar and
   * gets a wall when they click — an invitation to a locked door.
   */
  permission?: string | readonly string[];
};

export type ModuleDefinition = {
  key: string;
  label: string;
  description: string;
  /** Core modules underpin the rest of the app and cannot be disabled. */
  core?: boolean;
  /** Sidebar section this module's links appear under. */
  navGroup: string;
  navItems: NavItem[];
  /**
   * The permission somebody needs to see this module's records at all.
   *
   * The toggle above answers "does this company use it"; this answers "may this person see it".
   * `isModuleEnabled` checks both, so every page, action and dashboard figure that already asks
   * whether a module is on also asks, without being changed, whether it is on *for this person*.
   * The sidebar hides the module's links to people without it. See the `*.view` permissions.
   */
  viewPermission?: PermissionKey;
  /**
   * Modules this one cannot work without: a plan that includes it includes these too
   * (src/lib/platform/entitlements.ts). An order is for items; a renewal renews an order.
   */
  requires?: readonly string[];
  /** In every plan, whatever it lists: the basics every workspace has, like its own notifications. */
  inEveryPlan?: boolean;
  /**
   * Sold only to workspaces in these countries (ISO 3166-1 alpha-2) — India's tax law is built into
   * it, and no other country's is yet. Left out elsewhere whatever the plan says.
   */
  countries?: readonly string[];
};

/**
 * Pieces of a module that only make sense in some countries: the government's e-invoice and e-way
 * bill systems are India's. The rest of the module works anywhere.
 */
export const COUNTRY_FEATURES = {
  einvoice: ["IN"],
  eway: ["IN"],
} as const satisfies Record<string, readonly string[]>;

export type CountryFeature = keyof typeof COUNTRY_FEATURES;

export const MODULE_REGISTRY: ModuleDefinition[] = [
  {
    key: "companies",
    label: "Companies & Leads",
    description: "Company profiling, contacts, and the lead pipeline.",
    core: true,
    navGroup: "Sales",
    navItems: [
      { href: "/companies", label: "Companies", icon: Building2 },
      { href: "/leads", label: "Leads", icon: Target, permission: "leads.view" },
      { href: "/customers", label: "Customer", icon: Handshake },
      // One company entered twice, and the merge that folds it into the real one — src/lib/companies/merge.ts.
      { href: "/companies/duplicates", label: "Duplicate companies", icon: Combine, permission: "companies.merge" },
      // Every email the ERP sent a customer — src/actions/mail-log.ts.
      { href: "/mail-log", label: "Mail log", icon: Mail, permission: "emails.view" },
    ],
  },
  {
    key: "items",
    label: "Items & Inventory",
    description: "Catalog of goods, services, and subscriptions, with stock tracking for goods.",
    navGroup: "Catalog & Stock",
    navItems: [
      { href: "/items", label: "Items & Inventory", icon: Package },
      // The catalogue behind the item pickers — moved here from Settings → Lists, since a reseller's
      // thousand brands are catalogue work rather than configuration.
      { href: "/items/brands", label: "Brands & families", icon: Tags },
    ],
  },
  {
    key: "orders",
    requires: ["items"],
    viewPermission: "orders.view",
    label: "Orders",
    description:
      "Order punching: sales punches an order, accounts approves payment terms, purchasing sources the vendor — with margin, PO, and fulfillment tracking end to end.",
    navGroup: "Orders & Renewals",
    navItems: [
      { href: "/orders", label: "Orders", icon: ShoppingCart },
      // What purchase saved against sales's distributor prices: for purchase, approvers and performance viewers.
      { href: "/orders/savings", label: "Purchase savings", icon: PiggyBank, permission: ["orders.process", "orders.approve", "performance.view"] },
    ],
  },
  {
    key: "sales_documents",
    requires: ["items"],
    viewPermission: "documents.view",
    label: "Sales Documents",
    description:
      "Proposals, proforma invoices, GST tax invoices and credit notes — with place-of-supply tax handling, and e-invoice (IRN) and e-way bill generation through the government portal.",
    navGroup: "Quotes & Invoices",
    navItems: [
      { href: "/sales/proposals", label: "Proposals", icon: FileText },
      { href: "/sales/proformas", label: "Proforma Invoices", icon: FileCheck2 },
      { href: "/sales/invoices", label: "Tax Invoices", icon: Receipt },
      { href: "/sales/credit-notes", label: "Credit Notes", icon: FileMinus2 },
      // With the other trade documents, because it is one. E-way bills directly below cover
      // invoices, credit notes *and* challans, so filing the challan elsewhere split a set of three.
      { href: "/sales/challans", label: "Delivery Challans", icon: PackageCheck },
      { href: "/sales/eway-bills", label: "E-Way Bills", icon: Truck, countries: COUNTRY_FEATURES.eway },
    ],
  },
  {
    key: "purchase_documents",
    requires: ["items"],
    viewPermission: "documents.view",
    label: "Purchase Documents",
    description: "Purchase orders raised on vendors, and the bills they send back against them.",
    navGroup: "Purchase",
    navItems: [
      { href: "/purchase/orders", label: "Purchase Orders", icon: ClipboardList },
      { href: "/purchase/bills", label: "Vendor Bills", icon: ReceiptText },
      { href: "/purchase/reconciliation", label: "Reconciliation", icon: ScanSearch, permission: "purchase.reconcile" },
    ],
  },
  {
    key: "renewals",
    requires: ["orders"],
    viewPermission: "orders.view",
    label: "Renewals",
    description:
      "Track subscription start/expiry dates across every customer and manage upcoming renewals in one place.",
    navGroup: "Orders & Renewals",
    navItems: [{ href: "/renewals", label: "Renewals", icon: CalendarClockIcon }],
  },
  {
    key: "payments",
    viewPermission: "payments.view",
    label: "Payments",
    description: "Record payments received against orders and track outstanding balances across every customer.",
    navGroup: "Payments",
    navItems: [{ href: "/payments", label: "Payments", icon: Banknote }],
  },
  {
    key: "receivables",
    requires: ["sales_documents", "payments"],
    viewPermission: "payments.view",
    label: "Receivables",
    description:
      "What customers owe, aged from each invoice's due date — with payments and credit notes applied against invoices, and a statement of account per customer.",
    navGroup: "Payments",
    navItems: [
      { href: "/receivables", label: "Receivables", icon: Scale },
      // Who is safe to give terms to — the credit engine's list (src/lib/credit/engine.ts).
      { href: "/receivables/credit", label: "Customer credit", icon: ShieldCheck },
      // A salesperson's dues to chase, and the promises they logged (src/actions/collections.ts).
      { href: "/collections", label: "My collections", icon: Coins, permission: "collections.followUp" },
    ],
  },
  {
    key: "payables",
    requires: ["purchase_documents"],
    label: "Payables",
    description:
      "What we owe vendors, aged from each bill's due date — bills settled by payments out, with a statement of account per vendor.",
    navGroup: "Payments",
    navItems: [{ href: "/payables", label: "Payables", icon: Scale }],
  },
  {
    key: "accounting",
    countries: ["IN"],
    label: "Accounting",
    description:
      "The general ledger: a chart of accounts, double-entry postings raised automatically as invoices, bills, payments, expense claims and payroll are recorded, hand-written journal entries, and the statements built from them — trial balance, P&L, balance sheet and cash flow. Plus the bits that keep books defensible: bank reconciliation, a fixed asset register with depreciation, GST and TDS returns, and closing a period so a filed figure can't change afterwards.",
    navGroup: "Accounting",
    navItems: [
      { href: "/accounting", label: "Overview", icon: BookOpen, permission: "ledger.viewReports" },
      { href: "/accounting/journal", label: "Journal", icon: NotebookPen, permission: "ledger.viewReports" },
      { href: "/accounting/accounts", label: "Chart of Accounts", icon: ListTree, permission: "ledger.viewReports" },
      { href: "/accounting/trial-balance", label: "Trial Balance", icon: Scale, permission: "ledger.viewReports" },
      { href: "/accounting/profit-loss", label: "Profit & Loss", icon: TrendingUp, permission: "ledger.viewReports" },
      { href: "/accounting/balance-sheet", label: "Balance Sheet", icon: Landmark, permission: "ledger.viewReports" },
      { href: "/accounting/cash-flow", label: "Cash Flow", icon: Waves, permission: "ledger.viewReports" },
      { href: "/accounting/banking", label: "Banking", icon: Building2 },
      { href: "/accounting/assets", label: "Fixed Assets", icon: Boxes },
      { href: "/accounting/gst", label: "GST Returns", icon: FileSpreadsheet },
      { href: "/accounting/tds", label: "TDS", icon: Percent },
      { href: "/accounting/books", label: "Close the Books", icon: Lock },
    ],
  },
  {
    key: "revenue_close",
    // On top of the ledger, and sold only where it is: a plan sold abroad must not keep this add-on
    // while its accounting is dropped (entitlementsFrom drops country-bound modules after dependencies).
    requires: ["accounting"],
    countries: ["IN"],
    label: "Revenue & Close",
    description:
      "Revenue recognised as it is earned rather than when it is invoiced (Ind AS 115): a subscription's or a service's invoice waits in deferred revenue and moves into sales month by month, and a milestone's when the work is delivered. Plus the month-end close — a checklist that mostly checks itself (bank reconciled, revenue recognised, receivables agreeing with the ledger…), prepaid and accrual schedules, and the month's large movements explained before it is locked.",
    navGroup: "Accounting",
    navItems: [
      { href: "/accounting/revenue", label: "Revenue", icon: CalendarRange, permission: ["revenue.viewReports", "revenue.manage"] },
      { href: "/accounting/revenue/waterfall", label: "Revenue Waterfall", icon: Layers, permission: ["revenue.viewReports", "revenue.manage"] },
      { href: "/accounting/schedules", label: "Prepaids & Accruals", icon: Hourglass, permission: ["close.work", "close.manage"] },
      { href: "/accounting/close", label: "Month-end Close", icon: ListChecks, permission: ["close.work", "close.manage"] },
    ],
  },
  {
    key: "workspace",
    label: "Workspace",
    description:
      "Saved lists built from filters — a territory, a renewal window, every account nobody has called in 90 days. The filters are saved rather than the rows, so a list stays current as the data moves, and the whole team can work the same one.",
    navGroup: "Prospecting",
    navItems: [
      { href: "/workspace", label: "Workspace", icon: LayoutList },
      { href: "/verifications", label: "Contact Checks", icon: BadgeCheck, permission: "contacts.view" },
    ],
  },
  {
    key: "domains",
    label: "Domain Intel",
    description:
      "What public DNS and a company's own website reveal: who runs their email, whether the domain is protected against spoofing, what the site is built on, who hosts it, who it's registered with — and what each of those leaves open for a salesperson.",
    navGroup: "Prospecting",
    navItems: [{ href: "/domains", label: "Domain Intel", icon: Globe }],
  },
  {
    key: "calls",
    viewPermission: "calls.view",
    label: "Calls",
    description:
      "Call logging for the calling and sales teams: a phone icon on every company, lead, ticket and renewal that dials the contact, times the call and records how it went, plus a worklist of the callbacks still owed.",
    navGroup: "Prospecting",
    navItems: [{ href: "/calls", label: "Calls", icon: PhoneCall }],
  },
  {
    key: "targets",
    label: "Targets",
    description:
      "Numbers for people and teams to hit — sales value, collections, calls connected, visits, tickets closed — measured against what actually happened. Nothing is stored except the target itself: the achievement is worked out from the records each time it is read, so a cancelled invoice reduces it the moment it is cancelled.",
    navGroup: "Performance",
    navItems: [
      { href: "/targets/mine", label: "My targets", icon: Target },
      { href: "/targets", label: "All targets", icon: Gauge, permission: "targets.viewAll" },
    ],
  },
  {
    key: "incentives",
    requires: ["targets"],
    label: "Incentives",
    description:
      "What hitting a target is worth: schemes with thresholds, bands and caps, worked out against what was actually achieved and paid through payroll. What somebody was paid is frozen at the moment it is worked out — editing a scheme next quarter can't rewrite what went out last quarter.",
    navGroup: "Performance",
    navItems: [
      { href: "/incentives/mine", label: "My incentives", icon: HandCoins },
      // Either key opens it. Gating on manage alone hid the approval queue from the very people
      // whose job is to work it — ACCOUNTS holds approve and not manage.
      { href: "/incentives", label: "Incentive queue", icon: Wallet, permission: ["incentives.manage", "incentives.approve"] },
      { href: "/incentives/schemes", label: "Schemes", icon: Scale, permission: "incentives.manage" },
    ],
  },
  {
    key: "it_assets",
    label: "IT Assets",
    description:
      "Every machine and licence, tracked individually: ours, ours deployed at a client, and the estates we manage for clients — with custody, warranty and AMC cover, and a movement history. Plus the consignments that move kit about, which raise the delivery challans and e-way bills filed under Quotes & Invoices. A client's asset never reaches our balance sheet, however much of it we look after.",
    navGroup: "IT Assets",
    navItems: [
      { href: "/assets", label: "Assets", icon: Laptop },
      { href: "/assets/mine", label: "What I'm holding", icon: HandCoins },
      /**
       * Consignments stay; the other two have moved.
       *
       * A consignment in this app is always an asset movement — `createConsignment` refuses without
       * at least one asset — so this is its home. The delivery challan it raises is a trade document
       * and now sits with the other trade documents. Transporters is a reference list set up once,
       * like brands or industries, so it lives in Settings rather than holding a daily-use slot.
       */
      { href: "/logistics", label: "Consignments", icon: Truck, permission: "assets.manage" },
    ],
  },
  {
    key: "hr",
    label: "People (HR)",
    description:
      "Hiring and joining, employee records, the holiday calendar, leave with balances and approvals, and daily attendance. Payroll is a separate module so that who earns what stays behind its own permission.",
    navGroup: "People",
    navItems: [
      { href: "/people/me", label: "My HR", icon: UserRound },
      { href: "/people", label: "People", icon: IdCard },
      { href: "/people/hiring", label: "Hiring", icon: UserPlus, permission: "hr.manage" },
      { href: "/people/leave", label: "Leave", icon: Plane },
      { href: "/people/attendance", label: "Attendance", icon: CalendarDays },
      { href: "/people/celebrations", label: "Celebrations", icon: PartyPopper, permission: "hr.manage" },
      { href: "/people/devices", label: "Biometric", icon: Fingerprint, permission: "hr.manage" },
    ],
  },
  {
    key: "visitors",
    label: "Visitor Management",
    description:
      "A sign-in tablet for reception, running as a full-screen app with no address bar. Visitors pick a purpose and who they are seeing, leave their details and a photo, and the host is told the moment they arrive. Plus the book of who is in the building.",
    navGroup: "People",
    navItems: [
      { href: "/visitors", label: "Visitors", icon: DoorOpen, permission: "visitors.view" },
      // No permission: anybody can invite somebody to come and see them.
      { href: "/visitors/expected", label: "Expected visitors", icon: CalendarClock },
    ],
  },
  {
    key: "engagement",
    label: "Speak Up & Forms",
    description:
      "An anonymous feedback channel that records nothing about who sent what, plus forms, polls and votes HR can aim at one person, a department or everyone. Mandatory forms cover the screen on next sign-in; results stay hidden until five people have answered.",
    navGroup: "People",
    navItems: [
      { href: "/speak-up", label: "Speak up", icon: MessagesSquare },
      { href: "/surveys", label: "Forms & polls", icon: ClipboardCheck },
      { href: "/people/feedback", label: "Anonymous feedback", icon: MessagesSquare, permission: "engagement.readFeedback" },
    ],
  },
  {
    key: "payroll",
    requires: ["hr"],
    countries: ["IN"],
    label: "Payroll",
    description:
      "Salary structures, the monthly payroll run, and payslips — with PF, ESI and professional tax computed from the Indian rules. Needs the People module for the attendance and leave that drive loss of pay.",
    navGroup: "People",
    navItems: [{ href: "/people/payroll", label: "Payroll", icon: Banknote }],
  },
  {
    key: "contacts_library",
    viewPermission: "contacts.view",
    label: "Contacts Library",
    description: "Every contact across every company — clients, vendors, OEMs — in one searchable, filterable list.",
    navGroup: "Directory",
    navItems: [{ href: "/contacts", label: "Contacts", icon: Users }],
  },
  {
    key: "vendors",
    label: "Vendors",
    description: "Every vendor, OEM, distributor, and partner company — separate from the client-facing Companies list.",
    navGroup: "Directory",
    navItems: [{ href: "/vendors", label: "Vendors", icon: Truck }],
  },
  {
    key: "resellers",
    label: "Resellers",
    description:
      "Channel partners who buy from Wroffy for their own customers. Orders and payments sit with the reseller, and their end customers are flagged as off limits to direct contact and marketing.",
    navGroup: "Directory",
    navItems: [{ href: "/resellers", label: "Resellers", icon: Store }],
  },
  {
    key: "commission_parties",
    label: "Commission Parties",
    description: "Agents, brokers, and referral partners Wroffy pays commission to — with the same onboarding lifecycle as vendors, tracked separately.",
    navGroup: "Directory",
    navItems: [{ href: "/commission-parties", label: "Commission Parties", icon: HandCoins }],
  },
  {
    key: "visits",
    viewPermission: "visits.view",
    label: "Field Visits",
    description:
      "Client meetings and field visits: plan them with a purpose and agenda, check in and out on the day, write up the outcome, and claim the travel against them.",
    navGroup: "Field & Expenses",
    navItems: [{ href: "/visits", label: "Field Visits", icon: MapPin }],
  },
  {
    key: "expenses",
    label: "Expenses",
    description:
      "Every company expense in one place — travel claimed against a visit, and everything else the business spends — with manager approval and reimbursement tracking.",
    navGroup: "Field & Expenses",
    navItems: [{ href: "/expenses", label: "Expenses", icon: Wallet }],
  },
  {
    key: "notifications",
    inEveryPlan: true,
    label: "Notifications",
    description:
      "Everything the app has told you, past the twenty the bell holds — searchable, archivable, and with a switch per kind so people can turn down what they do not need rather than learning to ignore the bell entirely.",
    navGroup: "My work",
    navItems: [{ href: "/notifications", label: "Notifications", icon: BellRing }],
  },
  {
    key: "tasks",
    inEveryPlan: true,
    label: "Tasks",
    description: "Assignable to-dos, optionally linked to a company, lead, or ticket — with due dates and reminders.",
    navGroup: "My work",
    navItems: [{ href: "/tasks", label: "Tasks", icon: CheckSquare }],
  },
  {
    key: "notes",
    inEveryPlan: true,
    label: "Sticky Notes",
    description:
      "Quick notes that do not warrant a task — kept to yourself, shared with your reporting line, or stuck to a company, lead or ticket so the context lives with the record rather than in somebody's head.",
    navGroup: "My work",
    navItems: [{ href: "/notes", label: "Sticky Notes", icon: StickyNote }],
  },
  {
    key: "marketing",
    requires: ["workspace"],
    label: "Marketing Automation",
    description:
      "Campaigns and triggered journeys built from what the ERP already knows — a renewal coming up, a warranty running out, more staff than seats. Every send is checked against consent and suppression first, and a step can hand one of ours a task instead of mailing the customer. A reseller's end customers are never reachable from here.",
    navGroup: "Marketing",
    navItems: [
      { href: "/marketing/send", label: "Send a mass mail", icon: Send, permission: "marketing.manage" },
      { href: "/marketing", label: "Campaigns", icon: Megaphone },
      { href: "/marketing/journeys", label: "Journeys", icon: Route },
      { href: "/marketing/templates", label: "Templates", icon: FileText },
      { href: "/marketing/audiences", label: "Audiences", icon: MailCheck },
      { href: "/marketing/lists", label: "Mailing lists", icon: ListPlus },
      { href: "/marketing/suppressions", label: "Suppression list", icon: ShieldBan, permission: "marketing.manage" },
    ],
  },
  {
    key: "wins",
    label: "Sales Wins",
    description:
      "Wins that celebrate themselves: a big deal closed, a target reached, a new customer's first order, the month's top performer — a full-screen splash with confetti for everybody or just the winner, a wins wall with this month's leaderboard, and a TV screen for the sales floor.",
    navGroup: "Sales",
    // Everybody sees it: the whole point is that the rest of the room sees the win.
    navItems: [{ href: "/wins", label: "Wins & leaderboard", icon: Trophy }],
  },
  {
    key: "forecast",
    label: "Forecasting",
    description:
      "What is coming, period by period: open deals weighted by the win rate each stage has actually achieved, renewals by the rate each brand really renews at, cash expected in from each customer's own payment habits, machines coming out of warranty with no AMC — beside targets, last year and each salesperson's own commit.",
    navGroup: "Sales",
    // No permission gate: everybody sees the forecast for the accounts they can see.
    navItems: [{ href: "/forecast", label: "Forecast", icon: TrendingUp }],
  },
  {
    key: "forms",
    label: "Forms & Events",
    description:
      "Forms built in the app rather than in a spreadsheet: customer roundtables and event invitations with RSVPs and an attendance register, requirement assessments before a proposal, enquiry and survey forms. Share a public link, send personal invitations, or both — and decide per form who can see it, change it, invite to it and read what people answered.",
    navGroup: "Marketing",
    // No permission gate: the list shows the forms shared with each person, which is the point.
    navItems: [{ href: "/marketing/forms", label: "Forms & events", icon: ClipboardPen }],
  },
  {
    key: "customer_portal",
    label: "Customer Portal",
    description:
      "A page of their own for customers: what they have, when it expires, what they owe, and their open tickets. They sign in with a link rather than a password, because they have no account here — and what they can see is one setting for everybody, while who gets in is decided per customer.",
    navGroup: "Support",
    navItems: [
      { href: "/customer-portal", label: "Portal access", icon: Globe, permission: "portal.manage" },
      { href: "/customer-requests", label: "Customer requests", icon: Inbox, permission: "portal.manage" },
    ],
  },
  {
    key: "feedback",
    label: "Customer Feedback",
    description:
      "Send a customer a one-time link and ask how it went — about the person who dealt with them, and about what they bought. Every answer is kept here whatever the score; a happy one can also be offered your public review page.",
    navGroup: "Support",
    navItems: [
      { href: "/feedback", label: "Customer feedback", icon: MessageSquareQuote },
      { href: "/feedback/mine", label: "About me", icon: Star },
    ],
  },
  {
    key: "projects",
    viewPermission: "projects.view",
    label: "Projects",
    description:
      "Delivered work for customers — website builds, migrations, implementations. Milestones and billing stages, an agreement and NDA store, encrypted credentials, risks and weekly updates. Visible to the people on each project rather than to everyone.",
    navGroup: "Delivery",
    // No permission gate, matching the page: the list is scoped to the projects somebody is a
    // stakeholder on, so gating the link on projects.manage hid it from exactly the people it is for.
    navItems: [{ href: "/projects", label: "Projects", icon: FolderKanban }],
  },
  {
    key: "vault",
    label: "Credential Vault",
    description:
      "The company's own logins — registrars, hosting panels, partner portals, tax accounts. Encrypted at rest, opened with your own password, every access recorded and reported to the owner. Records belong to a person and are shared deliberately.",
    navGroup: "My work",
    navItems: [{ href: "/vault", label: "Credential vault", icon: KeyRound, permission: "vault.use" }],
  },
  {
    key: "helpdesk",
    viewPermission: "tickets.view",
    label: "Helpdesk / Tickets",
    description:
      "Support tickets linked to a company and contact, with priority, an SLA target, agent assignment, and a comment thread.",
    navGroup: "Support",
    navItems: [
      { href: "/tickets", label: "Tickets", icon: Ticket },
      // Which customers take the most support against what they pay — src/lib/support/load.ts.
      { href: "/tickets/load", label: "Support load", icon: Gauge },
    ],
  },
  {
    key: "reports",
    requires: ["workspace"],
    label: "Reports",
    description:
      "Any figure in the system broken down by anything else — month, salesperson, team, brand, product family, category, tag, lead source, industry, city. One screen rather than a list of fixed reports, because the useful question is always the one nobody wrote a page for.",
    navGroup: "Performance",
    navItems: [{ href: "/reports", label: "Reports", icon: BarChart4 }],
  },
];

/**
 * The order the sidebar shows the groups in.
 *
 * Stated here because the alternative is the order the modules happen to be declared in, which is
 * what it was: sixteen groups, nine of them holding a single link, arranged by whoever last appended
 * to the registry. Nobody decided that, and nothing made it visible — a sidebar's order is the one
 * piece of a product people navigate by muscle memory, so it should be a decision in one place
 * rather than a side effect of an array.
 *
 * Narrow groups that each mean one thing, rather than a few broad ones. That is a trade the
 * accordion made affordable: a collapsed group costs a single row, so a group you never open is
 * nearly free — whereas before, every extra heading was permanent height on everybody's screen.
 *
 * The sequence follows the work: who you are selling to, what you quoted them, what you sell, what
 * they ordered, what you bought to fill it, what you were paid, and what the books made of it.
 * Then the things that serve customers after the sale, then the people and lists that are yours.
 * * A group missing from this list still renders — it goes to the end rather than disappearing, so
 * adding a module with a new group name is never a link that silently vanishes.
 */
export const NAV_GROUP_ORDER = [
  "Sales",
  "Prospecting",
  "Quotes & Invoices",
  "Catalog & Stock",
  "Orders & Renewals",
  "Purchase",
  "Payments",
  "Accounting",
  "Support",
  "Delivery",
  "Field & Expenses",
  "IT Assets",
  "Directory",
  "Marketing",
  "People",
  "My work",
  "Performance",
] as const;

export function navGroupRank(group: string): number {
  const i = (NAV_GROUP_ORDER as readonly string[]).indexOf(group);
  return i === -1 ? NAV_GROUP_ORDER.length : i;
}

export function getModuleDefinition(key: string) {
  return MODULE_REGISTRY.find((m) => m.key === key);
}

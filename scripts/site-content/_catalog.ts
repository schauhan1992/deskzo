/**
 * Every page the website seed links to, with its label and its one-line tagline — one list, so the
 * header's menus, the footer, the hub pages' maps and every "related" card say the same thing.
 * A tagline is at most 80 characters (a header menu's line); a summary is the hub card's line.
 */

export type CatalogEntry = { path: string; label: string; tagline: string; summary: string };
export type CatalogGroup = { title: string; entries: CatalogEntry[] };

const entry = (path: string, label: string, tagline: string, summary: string): CatalogEntry => ({ path, label, tagline, summary });

export const PRODUCT_GROUPS: CatalogGroup[] = [
  {
    title: "Sell & serve",
    entries: [
      entry("/product/crm", "CRM", "Companies, contacts, leads, field visits and calls", "Companies and contacts, a lead pipeline from new to won, field visits with check-in, and calls logged against the record."),
      entry("/product/quotes-invoices", "Quotes & invoices", "Proposals, GST invoices, e-invoices and e-way bills", "Proposals, proformas, GST tax invoices, credit notes and delivery challans, with e-invoices (IRN) and e-way bills from the government portals."),
      entry("/product/subscriptions-renewals", "Subscriptions & renewals", "Orders, renewals, add-ons and AMCs", "Order punching with approvals, subscription start and expiry dates, renewals coming up, add-ons and AMC cover."),
      entry("/product/payments-receivables", "Payments & receivables", "Payments, ageing, statements and customer credit", "Payments received and allocated to invoices, ageing from due dates, customer statements, and who is safe to give credit to."),
      entry("/product/helpdesk", "Helpdesk", "Tickets with SLAs, a customer portal and feedback", "Support tickets with priority, an SLA target and assignment, a portal for customers, and feedback after the work is done."),
      entry("/product/marketing", "Marketing", "Campaigns, journeys, forms and events, with consent checks", "Campaigns and triggered journeys built from your records, forms and events with RSVPs, and every send checked against consent."),
      entry("/product/projects", "Projects", "Milestones, billing stages, risks and weekly updates", "Delivery projects for customers: milestones and billing stages, agreements, risks and weekly updates, visible to the people on them."),
    ],
  },
  {
    title: "Run the business",
    entries: [
      entry("/product/accounting-gst", "Accounting & GST", "The ledger, GST returns, TDS, banking and the period close", "A double-entry ledger that posts itself, financial statements, bank reconciliation, GST and TDS returns, and periods you close."),
      entry("/product/purchases-payables", "Purchases & payables", "Purchase orders, vendor bills and what you owe", "Purchase orders to vendors, the bills that come back and their reconciliation, and payables aged from each bill's due date."),
      entry("/product/inventory", "Inventory", "Goods, services and subscriptions, with stock for goods", "One catalogue of goods, services and subscriptions, with brands and product families, and stock tracking for goods."),
      entry("/product/expenses", "Expenses", "Claims with approval and reimbursement", "Expense claims, travel claimed against field visits, manager approval and reimbursement tracking."),
      entry("/product/assets", "Assets", "Fixed assets with depreciation, and IT assets by serial", "A fixed asset register with depreciation, and every machine and licence tracked with custody, warranty and AMC cover."),
      entry("/product/reports", "Reports & forecast", "Any figure by any dimension, and the forecast", "Any figure broken down by month, person, brand or city, and a forecast built from each stage's real win rate."),
    ],
  },
  {
    title: "People",
    entries: [
      entry("/product/hr", "HR", "Employee records, joining, holidays and self-service", "Employee records, joining, the holiday calendar and celebrations, with a self-service page for every employee."),
      entry("/product/payroll", "Payroll", "Salary runs and payslips with PF, ESI and professional tax", "Salary structures, the monthly payroll run and payslips, with PF, ESI and professional tax, and loss of pay from attendance."),
      entry("/product/attendance", "Attendance", "Daily attendance, biometric devices and field visits", "Daily attendance with biometric devices, work from home and field visits, feeding loss of pay into payroll."),
      entry("/product/leave", "Leave", "Leave types, balances and approvals", "Leave types with balances, requests and approvals, and the holiday calendar they work around."),
      entry("/product/recruitment", "Recruitment", "Candidates from first conversation to joining", "Candidate records and statuses, numbered offer letters, a details form for the candidate, and one step from accepted to employee."),
      entry("/product/targets-incentives", "Targets & incentives", "Targets, incentive schemes and a sales wins wall", "Targets measured against the records, incentive schemes with bands and caps paid through payroll, and a wins wall."),
    ],
  },
  {
    title: "Advanced",
    entries: [
      entry("/product/revenue-close", "Revenue & close", "Ind AS 115 revenue recognition and a month-end close", "Revenue recognised as it is earned, deferred revenue and its waterfall, prepaid and accrual schedules, and a month-end close checklist."),
      entry("/product/ai-copilot", "AI copilot", "Questions about your data, with the AI provider you choose", "Ask questions of your own records in plain language, with the AI provider and key your company chooses."),
      entry("/product/security", "Security & access", "Roles, two-factor sign-in, data-loss controls and a vault", "Roles and permissions, two-factor sign-in, device and network rules, data-loss controls, a credential vault and audit logs."),
      entry("/product/multi-branch-gst", "Multi-branch GST", "Branches with their own GSTINs, numbering and returns", "Each branch with its own GSTIN, address and document numbering, and GST worked out from the branch that supplies."),
      entry("/product/linked-workspaces", "Linked workspaces", "Switch between your group companies' workspaces in one click", "Group companies each keep a workspace of their own; people who work in several link their accounts and switch in one click."),
      entry("/product/import-migration", "Import & migration", "Bring your data in, and take all of it out", "Import companies, contacts, items and more from spreadsheets, and export everything, whenever you like."),
    ],
  },
];

export const SOLUTION_GROUPS: CatalogGroup[] = [
  {
    title: "By role",
    entries: [
      entry("/solutions/founders", "Founders & owners", "The whole company on one screen", "Sales, cash, people and support in one workspace, so the numbers you ask for are already there."),
      entry("/solutions/finance-teams", "Finance teams", "Books that post themselves, GST and TDS, a close that checks", "Invoices, bills, payments and payroll post to the ledger as they happen, with GST and TDS returns and a month-end close."),
      entry("/solutions/sales-teams", "Sales teams", "Pipeline, quotes, visits, calls and targets", "A lead pipeline, quotes and invoices, field visits and calls, with targets and incentives measured from the records."),
      entry("/solutions/hr-teams", "HR teams", "Hiring to payslips, with attendance and leave", "Hiring, joining, attendance with biometric devices, leave and payroll with PF, ESI and professional tax."),
      entry("/solutions/operations", "Operations", "Orders, purchasing, stock, assets and delivery", "Orders approved and sourced, purchases reconciled, stock and IT assets tracked, and projects delivered."),
      entry("/solutions/it-admins", "IT admins", "Access control, audit logs and data you can export", "Roles and permissions, two-factor sign-in, device and network rules, audit logs, a credential vault and full exports."),
    ],
  },
  {
    title: "By company size",
    entries: [
      entry("/solutions/small-business", "Small businesses", "Start with a few modules, add more as you grow", "GST invoicing, a CRM and payments to begin with, and the ledger, payroll and support when you need them."),
      entry("/solutions/growing-companies", "Growing companies", "Approvals, roles and a close that keeps up", "Approvals, roles and team targets for more people, and books that keep up with more transactions."),
      entry("/solutions/multi-branch-enterprises", "Multi-branch companies", "Branches, GSTINs and group companies", "Branches with their own GSTINs and numbering, linked workspaces for group companies, and access by role."),
    ],
  },
  {
    title: "By industry",
    entries: [
      entry("/solutions/it-services-resellers", "IT services & resellers", "Renewals, AMCs, IT assets and resellers", "Licences and hardware with renewals and AMCs, IT assets by serial, resellers and their end customers, and support."),
      entry("/solutions/professional-services", "Professional services & agencies", "Projects, billing stages and recurring fees", "Proposals, projects with milestones and billing stages, recurring retainers and revenue recognised as work is done."),
      entry("/solutions/trading-distribution", "Trading & distribution", "Orders, stock, e-way bills and credit control", "Orders, purchasing and stock, e-way bills for every consignment, and credit control for customers on terms."),
      entry("/solutions/saas-subscriptions", "SaaS & subscriptions", "Subscriptions, deferred revenue and renewals", "Subscriptions and renewals, invoices in each customer's currency, and revenue recognised month by month."),
    ],
  },
];

/** W3's comparison pages (their content is scripts/site-content/compare.ts). */
export const COMPARE_ENTRIES: CatalogEntry[] = [
  entry("/compare/zoho-one", "Zoho One", "How {siteName} and Zoho One compare", "Suite beside suite: CRM, finance, payroll and support for an Indian company."),
  entry("/compare/tally", "Tally", "How {siteName} and TallyPrime compare", "Desktop accounting beside a cloud workspace that also runs sales and people."),
  entry("/compare/odoo", "Odoo", "How {siteName} and Odoo compare", "Two sets of modules, side by side, for an Indian company."),
  entry("/compare/salesforce", "Salesforce", "How {siteName} and Salesforce compare", "A CRM platform beside a workspace with CRM, GST invoicing and the books."),
  entry("/compare/hubspot", "HubSpot", "How {siteName} and HubSpot compare", "Marketing and CRM hubs beside a workspace that also bills and pays."),
  entry("/compare/freshworks", "Freshworks", "How {siteName} and Freshworks compare", "Support and CRM products beside one workspace for the whole company."),
];

export const RESOURCE_ENTRIES: CatalogEntry[] = [
  entry("/blog/category/guides", "Guides", "E-invoicing, e-way bills, TDS, payroll and the close", "Step-by-step guides to e-invoicing, e-way bills, TDS, the month-end close, revenue recognition and payroll."),
  entry("/resources/glossary", "Glossary", "GST, accounting and payroll terms, defined", "Plain-language definitions of GST, TDS, payroll, accounting and CRM terms, with links to the official sources."),
  entry("/blog", "Blog", "News and articles from the {siteName} team", "Articles on running sales, finance and people in one workspace."),
];

/** The six starter guides (posts in the Guides category: guides.ts). */
export const GUIDE_ENTRIES: CatalogEntry[] = [
  entry("/blog/e-invoicing-under-gst", "E-invoicing under GST", "Who must e-invoice, the IRN and QR code, and the time limits", "Who must e-invoice, how the IRN and signed QR code are issued, the reporting time limit, and cancelling within 24 hours."),
  entry("/blog/e-way-bill-rules", "E-way bill rules", "When an e-way bill is needed, Part A and B, and validity", "When goods need an e-way bill, who raises it, Part A and Part B, validity by distance, extension and cancellation."),
  entry("/blog/tds-on-business-payments", "TDS on business payments", "Deducting, depositing and reporting TDS on vendor payments", "The basics of TDS on payments to contractors, professionals, landlords and suppliers: deducting, depositing and reporting it."),
  entry("/blog/month-end-close-checklist", "Month-end close checklist", "The tasks that close a month's books, in order", "The tasks that close a month's books: reconciliations, accruals, revenue, depreciation, payroll and the review before the lock."),
  entry("/blog/revenue-recognition-ind-as-115", "Revenue recognition for subscriptions", "Ind AS 115 rules for subscription and service businesses", "How Ind AS 115 applies to subscriptions and services: performance obligations, deferred revenue and recognising it over time."),
  entry("/blog/pf-esi-professional-tax-payroll", "PF, ESI and professional tax", "The statutory deductions in an Indian payroll", "Who PF, ESI and professional tax apply to, how the contributions are worked out, and when they are due."),
];

/** The hubs, and built-in pages the seed's content links to. */
export const SITE_ENTRIES: CatalogEntry[] = [
  entry("/product", "Product", "Every module, grouped by the work it runs", "Every module, grouped by the work it runs: sell and serve, run the business, people, and advanced."),
  entry("/solutions", "Solutions", "By role, company size and industry", "How {siteName} fits each role, each size of company and four industries."),
  entry("/resources", "Resources", "Guides and a glossary", "Guides to GST, TDS, payroll and the close, and a glossary of the terms you meet in them."),
  entry("/compare", "Compare", "How {siteName} compares", "How {siteName} compares with other products an Indian company considers."),
  entry("/pricing", "Pricing", "Plans and prices for your country", "Plans and prices for your country, in the currency you pay in, with a free trial to start."),
  entry("/security", "Security", "How each company's data is kept apart", "How each company's data is kept apart: its own database, its own keys, two-factor sign-in and audit logs."),
  entry("/contact", "Contact", "Plans, pricing, or help with your workspace", "Ask about plans and pricing, book a demo, or get help with your workspace."),
  entry("/partners", "Become a partner", "Sell {siteName} and earn a recurring commission", "Sell {siteName} to the companies you work with and earn a recurring commission."),
];

export const ALL_ENTRIES: CatalogEntry[] = [...PRODUCT_GROUPS, ...SOLUTION_GROUPS].flatMap((g) => g.entries).concat(COMPARE_ENTRIES, RESOURCE_ENTRIES, GUIDE_ENTRIES, SITE_ENTRIES);

/** A catalogue entry by its path; a mistake in the data throws, rather than publishing a card with no words. */
export function byPath(path: string): CatalogEntry {
  const found = ALL_ENTRIES.find((e) => e.path === path);
  if (!found) throw new Error(`No catalogue entry for ${path}.`);
  return found;
}

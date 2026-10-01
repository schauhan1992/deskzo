import { solutionPage } from "./_build";
import type { SeedPage } from "./types";

/** Solutions by role: founders, finance, sales, HR, operations and IT. Every claim is a module's (see the product pages). */

const founders = solutionPage({
  slug: "solutions/founders",
  name: "Founders & owners",
  seo: {
    title: "Business management software for founders",
    description: "Business management software for founders and owners: sales, cash, receivables, people and support in one workspace, with a forecast and an AI copilot.",
    keywords: ["business management software for founders", "one view of the business", "sales and cash forecast"],
  },
  eyebrow: "For founders and owners",
  h1: "Business management software for founders who want one view of the business",
  lead: "The whole business in one workspace: sales, invoices, cash, people and support. The question you ask on a Monday morning is answered from the records, not from five spreadsheets and three people.",
  answer: {
    question: "What should business management software give a founder?",
    answer:
      "Business management software for founders is one system that shows the whole company without anyone assembling it. In {siteName}, every module writes to one set of records, so the pipeline, the invoices, the money owed and the payroll all describe the same company.",
    more: [
      "The forecast weighs open deals by the rate each stage has actually won at, and adds renewals and the cash customers are likely to pay, given how late each one usually pays. The finance dashboard reads the ledger. Reports break any figure down by salesperson, customer, brand or month. When a question doesn't fit a report, the AI copilot answers it in plain language, with the AI provider your company chooses.",
    ],
  },
  problems: {
    heading: "What founders ask, and where the answer is",
    intro: "Founders ask the same few questions every week. Each has an answer on a page that reads the records directly.",
    items: [
      { icon: "chart", title: "How much will we sell this quarter?", body: "The sales and cash forecast weighs open deals by each stage's real win rate, beside targets and last year." },
      { icon: "rupee", title: "Who owes us, and who can we trust?", body: "Receivables are aged from each invoice's due date, and every customer has a credit rating with suggested terms and a limit." },
      { icon: "users", title: "Is the team hitting its numbers?", body: "Targets are measured from invoices, collections, calls and visits as they happen, so nobody reports their own figures." },
      { icon: "shield", title: "Can I trust who sees what?", body: "Roles decide what each person can see and do, reps see their own accounts, and every sign-in and export is logged." },
    ],
  },
  modules: {
    heading: "The modules founders use most",
    intro: "Switch on what the company needs now; the rest is there when it grows.",
    groups: [
      { title: "See the business", paths: ["/product/reports", "/product/ai-copilot", "/product/targets-incentives"] },
      { title: "Run the money", paths: ["/product/quotes-invoices", "/product/payments-receivables", "/product/accounting-gst"] },
      { title: "Keep it safe", paths: ["/product/security", "/product/import-migration"] },
    ],
  },
  workflow: {
    heading: "How a founder's week looks in {siteName}",
    intro: "The questions stay the same each week; the answers come from the records.",
    steps: [
      "Monday: read the forecast and the pipeline, and see which deals slipped last week.",
      "Wednesday: check receivables ageing and the customers who are past their terms.",
      "Friday: look at targets against achievement, and the wins wall for the week.",
      "Month end: read the profit and loss, cash flow and the month-end close checklist.",
    ],
  },
  faqHeading: "Questions founders ask",
  faq: [
    ["Do I have to switch on every module at once?", "No. Start with the modules you need, often the CRM and quotes and invoices, and add accounting, payroll or the helpdesk later. They read the records already there."],
    ["Can I ask questions without building a report?", "Yes, with the AI copilot. It answers from your records, respecting what you are allowed to see, with the AI provider and key your company sets up."],
    ["Is my company's data kept apart from other companies'?", "Yes. Each workspace has a database of its own and encryption keys of its own, and our support staff can open it only when your super admin grants access."],
  ],
  related: ["/solutions/small-business", "/solutions/growing-companies", "/product/reports", "/product/ai-copilot", "/pricing", "/solutions"],
  cta: { heading: "See your company on one screen", body: "Set up a workspace, bring in your customers and this month's invoices, and read the dashboard. Every workspace starts with a {trialDays}-day free trial." },
});

const finance = solutionPage({
  slug: "solutions/finance-teams",
  name: "Finance teams",
  seo: {
    title: "Accounting software for finance teams",
    description: "Accounting software for finance teams: books that post themselves, GSTR-1 and GSTR-3B per GSTIN, TDS, bank reconciliation and a month-end close checklist.",
    keywords: ["accounting software for finance teams", "month-end close software", "GST compliance"],
  },
  eyebrow: "For finance teams",
  h1: "Accounting software for finance teams that close the month on time",
  lead: "Invoices, bills, payments, expense claims and payroll post to the ledger as they happen. GST returns are prepared per GSTIN, bank statements are matched, and the month-end close checks itself.",
  heroPreview: "invoice",
  answer: {
    question: "Why do finance teams lose days at month end?",
    answer:
      "Finance teams lose days at month end re-keying invoices, chasing bills and tying the ledger to sub-ledgers kept elsewhere. Accounting software for finance teams is the fix when the documents are the source: in {siteName}, the ledger is written from the invoices, bills and payments themselves.",
    more: [
      "Month-end close software then checks what can be checked. With Revenue & Close, a checklist of tasks is due on the third working day, and eleven of them tick themselves: bank accounts reconciled, no draft invoices, revenue recognised, depreciation run, payroll posted, and receivables and payables ageing agreeing with the ledger to the rupee. A month closes in order, and reopening one reopens every month after it.",
    ],
  },
  problems: {
    heading: "Month-end problems, and how {siteName} handles them",
    intro: "Each of these costs a finance team hours every month. Each is handled where the transaction is recorded.",
    items: [
      { icon: "book", title: "Invoices keyed in twice", body: "Issuing an invoice, a credit note or a vendor bill posts its own entry in the same transaction, and cancelling it posts the reversal." },
      { icon: "file-text", title: "GST figures that don't agree", body: "GSTR-1 and GSTR-3B are prepared per GSTIN from the ledger, with output tax checked against it and errors the portal would reject listed first." },
      { icon: "building", title: "Bank reconciliation by hand", body: "Import statements as CSV, accept the suggested matches, and save each reconciliation with its difference." },
      { icon: "lock", title: "Figures that move after filing", body: "Lock a period, and nothing dated inside it can be posted. Moving the lock needs its own permission and is logged." },
      { icon: "rupee", title: "Sub-ledgers that drift", body: "Receivables and payables ageing are rebuilt as at month end and tied to the ledger, with the likely causes listed when they differ." },
      { icon: "calendar", title: "Revenue billed a year in advance", body: "Annual invoices wait in deferred revenue and move into sales month by month, with a waterfall of what is still to come." },
    ],
  },
  modules: {
    heading: "The modules finance teams use",
    intro: "The ledger is in Accounting & GST; the close and revenue recognition are the Revenue & Close add-on.",
    groups: [
      { title: "The books", paths: ["/product/accounting-gst", "/product/revenue-close", "/product/assets"] },
      { title: "The sub-ledgers", paths: ["/product/payments-receivables", "/product/purchases-payables", "/product/expenses", "/product/payroll"] },
    ],
  },
  workflow: {
    heading: "How the month closes",
    intro: "GST compliance and the close run from the same postings.",
    body: [
      "Through the month, documents post themselves and bank statements are matched. At month end, the close checklist shows which checks have passed. Prepare GSTR-1 and GSTR-3B for each GSTIN, clear the checks before filing, and file on the GST portal. Explain the large movements the flux review flags, then close the month, which moves the lock date so nothing inside it can change.",
    ],
    bullets: ["Eleven checks that tick themselves", "Large movements flagged against last month and last year", "Open tasks block the close unless a written reason is given"],
    preview: "invoice",
  },
  faqHeading: "Questions finance teams ask",
  faq: [
    ["Does {siteName} file GST returns?", "No. It prepares GSTR-1 and GSTR-3B for each GSTIN, with checks that catch what the portal would reject. You file them on the GST portal."],
    ["Can the auditor see who changed what?", "Yes. Postings are never edited: corrections are dated reversals. The audit log records creates, updates and deletes, and who made them."],
    ["Can we close the month with tasks still open?", "Only with a written reason, and the override is recorded. Months close in order."],
  ],
  related: ["/product/accounting-gst", "/product/revenue-close", "/resources/glossary", "/solutions/multi-branch-enterprises", "/solutions/saas-subscriptions"],
  cta: { heading: "Close next month in fewer days", body: "Set up a workspace and let this month's invoices post themselves. Every workspace starts with a {trialDays}-day free trial." },
});

const sales = solutionPage({
  slug: "solutions/sales-teams",
  name: "Sales teams",
  seo: {
    title: "Sales management software with CRM and quotes",
    description: "Sales management software for Indian teams: a scored lead pipeline, calls and field visits, quotes with approvals, and targets and incentives from the records.",
    keywords: ["sales management software", "sales team CRM", "sales incentive tracking"],
  },
  eyebrow: "For sales teams",
  h1: "Sales management software for teams that sell, visit and renew",
  lead: "A lead pipeline with scores that explain themselves, calls and field visits logged against the record, quotes and invoices in the same place, and targets and incentives measured from what was actually sold.",
  heroPreview: "pipeline",
  answer: {
    question: "What does a sales team need from its software?",
    answer:
      "A sales team needs its software to hold every lead, call and visit, and to turn a won deal into an invoice without retyping it. Sales management software is the system that does both: in {siteName}, the whole sale stays on one record, from enquiry to payment.",
    more: [
      "The sales team CRM shares new leads out by rules: round robin, fewest open leads, the account manager or a named person, matched on brand, product, source or state. Each lead has a score out of 100 points, with its reasons. Reps dial from the record, log the call and set a callback. Field visits are planned, checked into and written up, and the travel is claimed against the visit.",
    ],
  },
  problems: {
    heading: "Where deals get lost, and how {siteName} holds on to them",
    intro: "Deals get lost between people: a lead nobody owns, a callback nobody made, a quote nobody approved.",
    items: [
      { icon: "gauge", title: "Leads nobody followed up", body: "Assignment rules give every lead an owner at once, and a lead that goes quiet loses score, so it rises to the top of the list." },
      { icon: "headset", title: "Callbacks promised and forgotten", body: "Every logged call can set a callback, and callbacks land on the caller's worklist." },
      { icon: "file-text", title: "Quotes that take a day", body: "Proposals are priced from the catalogue, and large discounts go to an approver instead of an email thread." },
      { icon: "rupee", title: "Incentives argued over", body: "Sales incentive tracking works from invoices and collections, and each earning keeps its workings in words." },
      { icon: "calendar", title: "Renewals left to the last week", body: "Renewals due in the next 90 days are listed with a stage, and a renewal proposal is one click." },
    ],
  },
  modules: {
    heading: "The modules sales teams use",
    intro: "Most sales teams start with the CRM and quotes, then add targets and renewals.",
    groups: [
      { title: "Find and win", paths: ["/product/crm", "/product/quotes-invoices", "/product/marketing"] },
      { title: "Keep and grow", paths: ["/product/subscriptions-renewals", "/product/targets-incentives", "/product/reports"] },
    ],
  },
  workflow: {
    heading: "How a lead becomes revenue",
    intro: "The pipeline is one board, and each step leaves a record for the next.",
    body: [
      "A web enquiry arrives through the lead capture key and goes to the rep the rules choose. The rep calls, logs the outcome and books a visit. After the visit, a proposal is priced from the catalogue and sent as a PDF from the rep's own Microsoft 365 mailbox. When the deal is won, the invoice is raised from the proposal, and the value counts towards the rep's target the moment it is issued.",
    ],
    bullets: ["Stages from new to won, with reasons for every loss", "Targets, incentives and a wins wall from the same records", "A forecast weighted by each stage's real win rate"],
    preview: "pipeline",
  },
  faqHeading: "Questions sales teams ask",
  faq: [
    ["Is there a mobile app for field sales?", "There is no separate app. {siteName} runs in the phone's browser, where reps log calls and visits. Visit check-in records the time, without GPS."],
    ["Can the calls feature record calls?", "No. The phone icon dials from the rep's device and times the call; the rep logs the outcome. There is no telephony integration."],
    ["Can reps see each other's accounts?", "Not unless their role allows it. A rep sees their own accounts, and a manager sees their team's."],
  ],
  related: ["/product/crm", "/product/targets-incentives", "/product/quotes-invoices", "/solutions/founders", "/solutions/it-services-resellers"],
  cta: { heading: "Give every lead an owner today", body: "Import your leads and customers, set your assignment rules, and start calling. Every workspace starts with a {trialDays}-day free trial." },
});

const hrTeams = solutionPage({
  slug: "solutions/hr-teams",
  name: "HR teams",
  seo: {
    title: "HR and payroll software for HR teams",
    description: "HR and payroll software for Indian HR teams: records, joining, biometric attendance, leave, payroll with PF, ESI and PT, HR letters and hiring in one place.",
    keywords: ["HR and payroll software", "attendance and leave management", "HRMS software"],
  },
  eyebrow: "For HR teams",
  h1: "HR and payroll software that runs from joining to full and final",
  lead: "Employee records, joining checklists and HR letters, biometric attendance, leave with approvals, and payroll with PF, ESI and professional tax, where each step reads the one before it.",
  answer: {
    question: "Why keep HR and payroll in one system?",
    answer:
      "HR and payroll software in one system means payroll reads attendance and leave instead of a spreadsheet someone exported. In {siteName}, an approved leave marks the days in attendance, unpaid leave becomes loss of pay, and the payroll run picks it up.",
    more: [
      "In HRMS software built for India, attendance and leave management starts at the door. eSSL and ZKTeco terminals push punches straight to the workspace, the first and last punch become the day's check-in and check-out, and a missed punch never marks anyone absent. Staff apply for leave on My HR, their manager approves, and balances run from April to March.",
    ],
  },
  problems: {
    heading: "HR's monthly problems, and how {siteName} handles them",
    intro: "Each of these turns into an argument on payday. Each is handled where the record is made.",
    items: [
      { icon: "fingerprint", title: "Punches in one system, payroll in another", body: "Biometric punches become attendance days, and payroll counts absent days and unpaid leave as loss of pay." },
      { icon: "calendar", title: "Leave balances kept in a sheet", body: "Balances by financial year, requests that skip weekends and holidays, and approval by the reporting manager." },
      { icon: "rupee", title: "PF, ESI and PT worked out by hand", body: "PF and ESI contributions, and professional tax slabs for six states, worked out on every payslip." },
      { icon: "file-text", title: "Letters typed from old templates", body: "Offer, appointment, confirmation, relieving and experience letters among 23 types, numbered and frozen when issued." },
      { icon: "check", title: "Joiners without a sign-in on day one", body: "Converting an accepted candidate creates their sign-in, their profile and six joining tasks." },
    ],
  },
  modules: {
    heading: "The modules HR teams use",
    intro: "Payroll is a separate module, so who earns what stays behind its own permission.",
    groups: [
      { title: "People", paths: ["/product/hr", "/product/recruitment", "/product/attendance", "/product/leave"] },
      { title: "Pay", paths: ["/product/payroll", "/product/targets-incentives", "/product/expenses"] },
    ],
  },
  workflow: {
    heading: "How HR's month runs",
    intro: "Attendance, leave and payroll follow one another; nothing is exported between them.",
    body: [
      "Punches arrive from the terminals through the month, and staff ask for corrections to days they missed. Managers approve leave, which marks the days in attendance. At month end HR settles the attendance grid, runs payroll as a draft, checks the flagged payslips, and locks the run. Employees read their payslips on My HR, and the salary journal posts to the books.",
    ],
    bullets: ["Present, from home, half day, on leave, absent, week off, holiday", "Corrections requested by staff, decided by managers", "Payslips visible once the run is locked"],
    preview: "attendance",
    side: "left",
  },
  faqHeading: "Questions HR teams ask",
  faq: [
    ["Does payroll calculate income tax on salary?", "Not yet. HR enters each person's monthly TDS figure; {siteName} keeps it on the payslip and posts it to TDS payable. There is no Form 16 or tax regime choice in the product."],
    ["Which biometric devices can we use?", "eSSL and ZKTeco terminals that push over the iclock (ADMS) protocol. Other devices' logs can be imported from an eTimeTrackLite export."],
    ["Do shifts and late marks work?", "Not today. Attendance records each day's status and first and last punch; shift rosters, late marks and overtime aren't calculated."],
  ],
  related: ["/product/payroll", "/product/attendance", "/product/hr", "/blog/pf-esi-professional-tax-payroll", "/solutions/growing-companies"],
  cta: { heading: "Run next month's payroll from attendance", body: "Payroll is offered to companies in India. Set up a workspace and connect a terminal during the {trialDays}-day free trial." },
});

const operations = solutionPage({
  slug: "solutions/operations",
  name: "Operations",
  seo: {
    title: "Operations management software for orders",
    description: "Operations management software for Indian companies: order approvals, purchasing, stock counts, IT assets and consignments, e-way bills and delivery projects.",
    keywords: ["operations management software", "order approval workflow", "procurement and stock"],
  },
  eyebrow: "For operations",
  h1: "Operations management software from order to delivery",
  lead: "Orders punched by sales, approved by accounts and sourced by purchasing. Purchase orders and bills, stock counts, every machine by serial, consignments with their challans and e-way bills, and projects delivered on milestones.",
  answer: {
    question: "What does operations management software cover?",
    answer:
      "Operations management software is the record of the work between a signed order and a delivered one: approving it, buying for it, moving goods and tracking what was delivered. In {siteName}, each step is recorded on the order, so sales can see where their customer's order stands.",
    more: [
      "The order approval workflow has four steps. Sales punches the order, accounts approves the payment terms, purchasing sets the vendor, the cost and our PO number, and the order is fulfilled. Nobody approves their own. Margin is worked out from the sell price and the purchase price, less commission, freight and installation.",
    ],
  },
  problems: {
    heading: "Operational gaps, and how {siteName} closes them",
    intro: "Operations gaps are usually steps that happen outside the system. Each of these happens on the order or the item.",
    items: [
      { icon: "check", title: "Orders approved over WhatsApp", body: "Accounts approves payment terms on the order itself, and a customer whose rating doesn't support the terms needs an override with a reason." },
      { icon: "truck", title: "Distributor bills nobody checks", body: "Distributor statements are matched line by line with what was sold, so seat counts and unit costs that don't match stand out." },
      { icon: "package", title: "Stock known only to the storekeeper", body: "Procurement and stock meet on the item: tracked items carry a count and a log of every movement with its reason." },
      { icon: "server", title: "Machines lost track of", body: "Every unit by serial, with custody, warranty and AMC cover, and consignments that raise the delivery challan." },
      { icon: "calendar", title: "Projects that overrun unseen", body: "Milestones, billing stages, risks and a weekly health status for every delivery project." },
    ],
  },
  modules: {
    heading: "The modules operations teams use",
    intro: "Operations reads the same orders and items that sales and finance do.",
    groups: [
      { title: "Buy and supply", paths: ["/product/subscriptions-renewals", "/product/purchases-payables", "/product/inventory"] },
      { title: "Deliver and support", paths: ["/product/assets", "/product/projects", "/product/helpdesk"] },
    ],
  },
  workflow: {
    heading: "How an order is delivered",
    intro: "One order record follows the goods from approval to delivery.",
    steps: [
      "Sales punches the order with its items, price and terms.",
      "Accounts approves the payment terms, and purchasing raises the purchase order on the vendor.",
      "The goods arrive; the vendor bill is entered and stock is received on the tracked items.",
      "A consignment dispatches the machines, raises the delivery challan and flags whether an e-way bill is needed.",
      "The order is marked fulfilled, and the invoice is raised.",
    ],
  },
  faqHeading: "Questions operations teams ask",
  faq: [
    ["Does fulfilling an order reduce stock?", "No. Stock changes when a movement is recorded on the item, so the count stays under your storekeeper's control."],
    ["Can we run several warehouses?", "Not today. Each item has one stock figure, with no godowns, bins or transfers between locations."],
    ["Is there a three-way match?", "No. There is no goods receipt step. Distributor statements are checked against sales instead."],
  ],
  related: ["/product/purchases-payables", "/product/assets", "/product/inventory", "/solutions/trading-distribution", "/solutions/it-services-resellers"],
  cta: { heading: "Put every order on one record", body: "Set up a workspace and punch your first order with its approval. Every workspace starts with a {trialDays}-day free trial." },
});

const itAdmins = solutionPage({
  slug: "solutions/it-admins",
  name: "IT admins",
  seo: {
    title: "ERP access control and audit logs for IT",
    description: "ERP access control for IT admins: roles and permissions, two-factor sign-in, Microsoft single sign-on, device and network rules, audit logs and a vault.",
    keywords: ["ERP access control", "audit logs", "single sign-on with Microsoft"],
  },
  eyebrow: "For IT admins",
  h1: "ERP access control that IT can set, see and prove",
  lead: "Roles and permissions, record-level scope, two-factor sign-in, single sign-on with Microsoft, device and network rules, audit logs and a credential vault, in a workspace with its own database and keys.",
  answer: {
    question: "What does an IT admin control in {siteName}?",
    answer:
      "ERP access control is the set of rules deciding who can sign in, from where, and what each person can see and do. In {siteName} it works at three levels: the role's permissions, the person's own grants or denials, and the accounts a person manages or their team manages.",
    more: [
      "Sign-in can require an authenticator code for everyone, or go through Microsoft Entra ID, with password sign-in switched off for all but admins. Rules for each role allow or refuse phones, tablets and computers, require device approval, and treat an unknown network as allowed, alerted, held or blocked. IP allow and block lists work per role, for single addresses and ranges.",
    ],
  },
  problems: {
    heading: "IT's concerns, and how {siteName} answers them",
    intro: "A security review asks these questions, and each answer is a setting an admin can show.",
    items: [
      { icon: "users", title: "Everyone sees every customer", body: "Record-level scope limits reps to their own accounts, and managers to their team's, unless a role says otherwise." },
      { icon: "fingerprint", title: "Passwords alone", body: "Authenticator-app two-factor sign-in that admins can require of everyone, and single sign-on with Microsoft." },
      { icon: "globe", title: "Access from anywhere", body: "Allow the office network and block the rest, per role, with alerts for a new device, a new network or impossible travel." },
      { icon: "scroll", title: "No trail when something goes wrong", body: "Audit logs record sign-ins, exports, blocked events, permission denials and every create, update and delete." },
      { icon: "key", title: "Shared passwords in spreadsheets", body: "A credential vault encrypted per workspace, opened with your own password, with every reveal logged." },
      { icon: "database", title: "Data you can't take with you", body: "Export any area as CSV or Excel, and download a sealed backup of the whole workspace." },
    ],
  },
  modules: {
    heading: "The modules IT admins use",
    intro: "Security settings are part of every workspace; the vault and exports have their own permissions.",
    groups: [
      { title: "Control", paths: ["/product/security", "/product/linked-workspaces"] },
      { title: "Data", paths: ["/product/import-migration", "/product/ai-copilot"] },
    ],
  },
  workflow: {
    heading: "How to lock a workspace down",
    intro: "Most companies set these once, in the first week.",
    steps: [
      "Review the built-in roles, rename them and adjust their permissions, or create your own.",
      "Require two-factor sign-in, or connect Microsoft Entra ID and enforce single sign-on.",
      "Add the office's IP ranges, and set unknown networks to alert or block for each role.",
      "Decide whether the data-loss deterrents, the watermark and copy and print blocking, apply to each role.",
      "Read the activity log weekly, and set how long it is kept.",
    ],
  },
  faqHeading: "Questions IT admins ask",
  faq: [
    ["Can you stop screenshots?", "No software can. {siteName} counts screenshot attempts, logs them and can watermark screens with the viewer's name. The data-loss controls are deterrents, and we say so."],
    ["Which single sign-on providers work?", "Microsoft Entra ID. Google sign-in, SAML and automatic user provisioning aren't available."],
    ["Can your support team open our workspace?", "Only when your super admin grants access, read-only or admin, for a time they choose up to 72 hours, with a reason. Each visit is logged."],
  ],
  related: ["/product/security", "/security", "/product/import-migration", "/product/linked-workspaces", "/solutions/multi-branch-enterprises"],
  cta: { heading: "Answer your security questionnaire", body: "Book a demo and we will walk your IT team through roles, sign-in rules and the logs." },
});

export const ROLE_PAGES: SeedPage[] = [founders, finance, sales, hrTeams, operations, itAdmins];

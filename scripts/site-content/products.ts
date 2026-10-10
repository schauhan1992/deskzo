import { ADD_ONS, PRODUCT_FAMILY, PRODUCTS, type Product } from "../../src/lib/products";
import { pageMap, productLinePage, type Feature } from "./_build";
import { PRODUCT_GROUP_TITLES, PRODUCT_LINE_GROUPS } from "./_catalog";
import { ADD_ON_PAGES, baseModulesLine, moduleCards, product, shortName } from "./_products";
import type { SeedPage, SeedSection } from "./types";

/**
 * A page for each product in src/lib/products.ts, at its own path (/one, /crm, /books…): what it
 * runs, the modules in it (each linked to its module page where the site has one), the products it
 * works with, the questions buyers ask, and a trial or a word with sales.
 *
 * Names, paths and taglines are read from products.ts and never typed here; the brand in running
 * text is the {siteName} token. Every claim is the module pages' (_product-*.ts) or the code's —
 * src/lib/modules.ts, src/actions/vault.ts and src/lib/vault/** for the vault — and no price or
 * seat count is stated: prices aren't public yet, so the pages link to /pricing.
 */

const one = product("one");
const crm = product("crm");
const books = product("books");
const people = product("people");
const desk = product("desk");
const inventory = product("inventory");
const subscriptions = product("subscriptions");
const projects = product("projects");
const campaigns = product("campaigns");
const analytics = product("analytics");
const vault = product("vault");
const cards = product("cards");

/** "Deskzo CRM: leads, pipeline, calls…" — the name, then the tagline as the rest of the sentence. */
function headline(p: Product): string {
  const t = p.tagline;
  const lowered = /^[A-Z][a-z]/.test(t) ? t[0]!.toLowerCase() + t.slice(1) : t;
  return `${p.name}: ${lowered}`;
}

const base = baseModulesLine();
const contentsIntro = (p: Product, extra = "") =>
  `${p.modules.length === 1 ? "One module" : `${p.modules.length} modules`}, each with its own page where the site has one.${extra} Every {siteName} product also comes with ${base}.`;
const pair = (p: Product, description: string) => ({ path: p.path, label: p.name, description });

const trial = "Every workspace starts with a {trialDays}-day free trial.";

// ─── Deskzo One ──────────────────────────────────────────────────────────────────────────────────

const products = PRODUCTS.filter((p) => p.key !== "one");
const shortNames = products.map((p) => shortName(p, PRODUCT_FAMILY));
const listOfShortNames = `${shortNames.slice(0, -1).join(", ")} and ${shortNames[shortNames.length - 1]}`;

const addOnCards: Feature[] = ADD_ONS.map((a) => {
  const page = ADD_ON_PAGES[a.key];
  const on = a.onProduct ? product(a.onProduct) : null;
  const body =
    a.key === "revenue_close"
      ? `${a.tagline}, for the books kept in ${on?.name ?? "the ledger"}, and included in ${product("one").name}. Offered to companies in India.`
      : a.key === "copilot"
        ? `${a.tagline}. It reads only what each person may see, and drafts tasks and notes for them to save.`
        : `${a.tagline}, added to any product.`;
  return {
    icon: a.key === "revenue_close" ? "calendar" : a.key === "copilot" ? "bot" : "users",
    title: a.name,
    body,
    link: page ? { label: `${a.name} in detail`, href: page } : { label: "See pricing", href: "/pricing" },
  };
});

const onePage = productLinePage({
  slug: one.path.slice(1),
  name: one.name,
  seo: {
    title: `${one.name}: all-in-one business software`,
    description: `${one.name} is all-in-one business software: CRM, GST invoicing and accounting, HR and payroll, helpdesk, inventory and more, in one workspace.`,
    keywords: [one.name, "all-in-one business software", "one workspace"],
  },
  eyebrow: PRODUCT_GROUP_TITLES.suite,
  h1: headline(one),
  lead: `${listOfShortNames}, switched on together for one company. One set of companies, contacts and items, one sign-in, and every record any product makes is there for the others to read.`,
  heroPreview: "pipeline",
  answer: {
    question: `What is ${one.name}?`,
    answer: `${one.name} is the all-in-one business software suite: every {siteName} product in one workspace, from the CRM and GST invoicing to payroll, the helpdesk and the credential vault. A sale, its invoice, its payment and its support ticket are one company's records, not four systems' copies.`,
    more: [
      `Every module is switched on, and each person sees what their role allows: the sidebar shows only the modules someone can open, and a salesperson sees the accounts they manage. Accounting, Revenue & Close and payroll follow Indian rules, so they are offered to companies in India; every other module works anywhere.`,
    ],
  },
  extra: [
    pageMap(
      `${one.path.slice(1)}-map`,
      `Every product in ${one.name}`,
      `${products.length} products, each a set of modules for one kind of work, grouped by the work they run. Every {siteName} product also comes with ${base}.`,
      PRODUCT_LINE_GROUPS.filter((g) => !g.entries.some((e) => e.path === one.path)),
    ),
    {
      id: "one-why",
      type: "featureGrid",
      props: {
        heading: "Why does one workspace matter?",
        intro: "Because the work doesn't stop at a product's edge. One workspace means each record is entered once and read everywhere it is needed.",
        columns: 2,
        items: [
          { icon: "database", title: "One set of records", body: "A company, its contacts and the items you sell are entered once. The quote, the invoice, the payment, the ticket and the renewal all belong to the same company, so its page shows the whole relationship." },
          { icon: "book", title: "Books that post themselves", body: "Issuing an invoice, approving an expense claim or locking a payroll run writes its own journal entry, so the ledger is never keyed in from another system." },
          { icon: "fingerprint", title: "One sign-in, one set of roles", body: "Each person has one account, one role and one two-factor setting for every product, and one activity log records what they did." },
          { icon: "layers", title: "Products added later, without moving data", body: "A workspace can start with one product and add others. A product switched on later works with the records already there: nothing is exported, imported or keyed in twice." },
        ],
      },
    },
    {
      id: "one-add-ons",
      type: "featureGrid",
      props: { anchor: "add-ons", heading: "The add-ons", intro: `Bought alongside a product when a company needs them. ${one.name} already includes ${ADD_ONS.filter((a) => a.includedIn.includes("one")).map((a) => a.name).join(" and ")}.`, columns: 3, items: addOnCards },
    },
  ],
  how: [
    {
      heading: "How a sale moves through one workspace",
      intro: "Each step reads the record the step before it wrote.",
      steps: [
        `A lead arrives in ${crm.name}, is scored and assigned, and becomes a customer.`,
        `The proposal and the GST invoice are raised in ${books.name}, and the invoice posts itself to the ledger.`,
        `The order and its subscription are tracked in ${subscriptions.name}, with the renewal date ready.`,
        `A support ticket in ${desk.name} names the subscription it concerns, and ${analytics.name} reports on all of it.`,
      ],
    },
  ],
  faqHeading: `Questions about ${one.name}`,
  faq: [
    [`Can we start with one product and move to ${one.name} later?`, `Yes. A workspace can hold one product or several, and ${one.name} is all of them. A product switched on later works with the records already in the workspace, so nothing is moved or typed in again.`],
    [`Is everything in ${one.name} available outside India?`, "Accounting, Revenue & Close and payroll follow Indian rules, so they are offered to companies in India only, and the e-invoice and e-way bill features use India's government systems. Every other module works anywhere."],
    ["Does everyone in the company see every product?", "No. Each person sees what their role allows. A module's records need its view permission, the sidebar shows only what someone can open, and record-level scope keeps a salesperson to the accounts they manage."],
    ["Can group companies share one workspace?", "Each company with its own PAN keeps a workspace of its own, with its own database and keys. People who work in several link their accounts and switch between them in one click."],
  ],
  related: ["/product", "/pricing", "/security", "/product/linked-workspaces", "/product/import-migration", "/solutions/founders"],
  cta: { heading: `Run the whole company in ${one.name}`, body: `Set up a workspace with every product switched on, or talk to sales about where to start. ${trial}` },
});

// ─── Deskzo CRM ──────────────────────────────────────────────────────────────────────────────────

const crmPage = productLinePage({
  slug: crm.path.slice(1),
  name: crm.name,
  seo: {
    title: `${crm.name}: sales CRM for leads and field teams`,
    description: `${crm.name} is a sales CRM for Indian companies: companies and contacts, a lead pipeline with scores, calls, field visits, targets and incentives.`,
    keywords: [crm.name, "sales CRM", "lead pipeline"],
  },
  eyebrow: PRODUCT_GROUP_TITLES.sell,
  h1: headline(crm),
  lead: "Every company you sell to, its contacts and its leads, worked through a pipeline from new to won. Calls and field visits are logged against the record, and targets and incentives are measured from what the team actually did.",
  heroPreview: "pipeline",
  answer: {
    question: `What is ${crm.name}?`,
    answer: `${crm.name} is a sales CRM: the record of every company you sell to, its contacts and the deals you are working. Leads move through a lead pipeline from new to won, each with a score out of 100 that says why, and every call and visit is logged against the company.`,
    more: [
      "Enquiries reach it through a lead capture API with a key for each website, and assignment rules share them out by brand, product, source or state. Targets for people and teams are measured from the records themselves, incentive schemes turn achievement into earnings, and a wins wall celebrates the month's deals.",
    ],
  },
  contents: { heading: `What's in ${crm.name}`, intro: contentsIntro(crm), items: moduleCards(crm) },
  how: [
    {
      heading: "How a lead moves through the sales CRM",
      intro: "One board, and every move leaves a record.",
      steps: [
        "An enquiry arrives through your website's lead capture key, and the assignment rules give it to a rep with a score.",
        "The rep calls from the record, logs the outcome and sets a callback, which lands on their worklist.",
        "A field visit is planned with its purpose, checked in on the day and written up.",
        "The lead is won or lost with a reason, and the win counts towards the rep's target.",
      ],
    },
  ],
  worksWith: {
    heading: `What ${crm.name} works with`,
    intro: "Other products that read the same companies and contacts, in the same workspace.",
    links: [
      pair(books, "Proposals, GST invoices and payments raised for the companies and deals the CRM keeps."),
      pair(desk, "Support tickets raised against the same companies and contacts, with SLA targets."),
      pair(campaigns, "Journeys and campaigns sent to your contacts, with every send checked against consent."),
      pair(analytics, "Leads and visits broken down any way you like, and a forecast from each stage's win rate."),
      pair(cards, "Digital business cards whose share-backs arrive as leads in the card holder's name."),
    ],
  },
  faqHeading: `Questions about ${crm.name}`,
  faq: [
    [`Can ${crm.name} raise quotes and invoices?`, `Quotes and invoices are in ${books.name}. With both in one workspace, a proposal is raised for the company the lead belongs to, with its contacts and history already there.`],
    ["Can my website send enquiries straight into the CRM?", "Yes. Your website posts each enquiry to the lead capture API with its own key, and the lead is created and assigned. A retried request with the same reference doesn't create a duplicate."],
    ["Does the calls feature record or route phone calls?", "No. The phone icon dials from the device you are on and times the call on screen, and the rep logs the outcome. There is no telephony integration, recording or call routing."],
    ["Can reps see each other's customers?", "Not unless their role allows it. A rep sees the accounts they manage, and a manager sees their team's, down the reporting line."],
    ["Can incentives be paid through payroll?", `Yes, with ${people.name} in the same workspace: approved earnings are added to the next payroll run's payslips and marked paid. Payroll is offered to companies in India.`],
  ],
  related: ["/product/crm", "/product/targets-incentives", "/product/import-migration", "/solutions/sales-teams", "/pricing"],
  cta: { heading: `Work your pipeline in ${crm.name}`, body: `Import your companies and contacts from a spreadsheet and start working your leads today. ${trial}` },
});

// ─── Deskzo Books ────────────────────────────────────────────────────────────────────────────────

const booksPage = productLinePage({
  slug: books.path.slice(1),
  name: books.name,
  seo: {
    title: `${books.name}: GST invoicing and accounting`,
    description: `${books.name} is GST invoicing and accounting: invoices that post themselves, payments and receivables, vendor bills, expense claims, GSTR-1 and GSTR-3B.`,
    keywords: [books.name, "GST invoicing and accounting", "online accounting software"],
  },
  eyebrow: PRODUCT_GROUP_TITLES.run,
  h1: headline(books),
  lead: "Quotes and GST invoices, the money customers owe, the bills you pay and the claims your staff make, all posting to one double-entry ledger as they happen. GSTR-1 and GSTR-3B are prepared from those postings for each GSTIN.",
  heroPreview: "invoice",
  answer: {
    question: `What is ${books.name}?`,
    answer: `${books.name} is GST invoicing and accounting in one: proposals, tax invoices and credit notes, payments, vendor bills, expense claims and the ledger they all post to. Nobody re-keys an invoice into the books, because issuing it writes the journal entry in the same step.`,
    more: [
      "As online accounting software for Indian companies, it works out CGST and SGST or IGST from the place of supply, posts TDS and TCS to their own accounts, reconciles bank statements imported as CSV, and locks a period once it is filed. The accounting follows Indian rules, so it is offered to companies in India.",
    ],
  },
  contents: { heading: `What's in ${books.name}`, intro: contentsIntro(books), items: moduleCards(books) },
  how: [
    {
      heading: "How an invoice moves through the books",
      intro: "The invoice is the source: the ledger, the return and the receivable all read from it.",
      steps: [
        "A proposal priced from the item catalogue becomes a proforma or a tax invoice in one step.",
        "Issuing the tax invoice locks it, gives it the next number in the branch's series, works out its GST and posts it to the ledger.",
        "A payment is allocated against it, and the receivables ageing shows what is still open.",
        "GSTR-1 lists the invoice and GSTR-3B counts its tax. Once the month is filed, lock it.",
      ],
    },
  ],
  worksWith: {
    heading: `What ${books.name} works with`,
    intro: "Other products whose records reach the ledger, or start the invoice.",
    links: [
      pair(crm, "The companies, contacts and deals your invoices are raised for."),
      pair(subscriptions, "Orders, renewals and add-on seats, invoiced from the same catalogue."),
      pair(people, "Payroll runs that post salaries and PF, ESI, PT and TDS payable to the ledger."),
      pair(projects, "Billing stages that raise their invoice from the project, and follow it until paid."),
    ],
  },
  faqHeading: `Questions about ${books.name}`,
  faq: [
    [`Does ${books.name} file my GST returns?`, "No. It prepares GSTR-1 and GSTR-3B for each GSTIN, with checks that catch what the portal would reject, such as an invalid GSTIN or a line without an HSN or SAC code. You file them on the GST portal."],
    ["Can customers pay invoices online?", "Not through {siteName}. Customers pay by bank transfer, UPI, cheque, card or cash, and you record the payment. The invoice prints your bank details and UPI ID."],
    ["Can we have GSTINs in several states?", "Yes, as long as they share the company's PAN. Each registration has its own branches, invoice numbering and returns, and the branch on a document decides the seller's GSTIN and the tax."],
    ["Can we import past invoices?", "No. Lists such as companies, contacts, items, vendors and the chart of accounts are imported from Excel or CSV; invoices, payments and journals are made in {siteName}. Opening balances go in as a journal."],
    ["What does the Revenue & Close add-on add?", `Revenue recognised as it is earned under Ind AS 115, a revenue waterfall, prepaid and accrual schedules, and a month-end close checklist that checks itself. It is an add-on to ${books.name}, and included in ${one.name}.`],
  ],
  related: ["/product/accounting-gst", "/product/quotes-invoices", "/product/payments-receivables", "/product/multi-branch-gst", "/solutions/finance-teams", "/pricing"],
  cta: { heading: `Issue your first invoice in ${books.name}`, body: `Add your items, issue a test invoice and watch it post to the ledger. ${trial}` },
});

// ─── Deskzo People ───────────────────────────────────────────────────────────────────────────────

const peoplePage = productLinePage({
  slug: people.path.slice(1),
  name: people.name,
  seo: {
    title: `${people.name}: HR, payroll and attendance software`,
    description: `${people.name} is HR and payroll software: employee records, attendance from biometric devices, leave, payroll with PF, ESI and PT, hiring and visitors.`,
    keywords: [people.name, "HR and payroll software", "attendance and leave"],
  },
  eyebrow: PRODUCT_GROUP_TITLES.people,
  h1: headline(people),
  lead: "One record for each employee from offer letter to exit, attendance from biometric devices, leave with balances, and a monthly payroll run with PF, ESI and professional tax. Reception signs visitors in on a tablet, and staff can speak up anonymously.",
  heroPreview: "attendance",
  answer: {
    question: `What is ${people.name}?`,
    answer: `${people.name} is the HR and payroll software in {siteName}, for the whole employee lifecycle: hiring, joining, records, attendance and leave, payroll and exit. Attendance and unpaid leave feed loss of pay into payroll, so each month's salaries come from the records rather than a spreadsheet.`,
    more: [
      `Each person has a self-service page, My HR, where they clock in, apply for leave and read their payslips. ${people.name} is offered to companies in India, because its payroll follows Indian rules.`,
    ],
  },
  contents: { heading: `What's in ${people.name}`, intro: contentsIntro(people, " HR covers employee records, attendance, leave and hiring, each with a page of its own."), items: moduleCards(people) },
  how: [
    {
      heading: "How a month runs in HR and payroll",
      intro: "Each step reads the record the step before it settled.",
      steps: [
        "Punches arrive from the biometric terminals, and people without one clock in from My HR.",
        "Approved leave writes itself into attendance, and managers settle corrections.",
        "The payroll run reads the month's attendance and unpaid leave, and works out PF, ESI and professional tax.",
        "Locking the run freezes the figures, shows staff their payslips and posts the salary journal.",
      ],
    },
  ],
  worksWith: {
    heading: `What ${people.name} works with`,
    intro: "Other products that read the same people.",
    links: [
      pair(books, "The salary journal, employer contributions and statutory payables posted to the ledger."),
      pair(crm, "Sales incentives approved in the CRM and paid on the next payslip."),
      pair(vault, "A leaver's stored logins handed to a colleague and flagged for a change."),
      pair(cards, "Digital cards issued from the employee record, and dark the day after a leaver's last day."),
    ],
  },
  faqHeading: `Questions about ${people.name}`,
  faq: [
    [`Is ${people.name} available outside India?`, `No. ${people.name} is offered to companies in India: its payroll follows Indian rules — PF, ESI, professional tax and TDS on salary. ${crm.name}, ${desk.name} and the other products work anywhere.`],
    ["Which biometric devices does it work with?", "eSSL and ZKTeco terminals that push punches over the iclock (ADMS) protocol connect straight to the workspace. If a device can't push, export its log from eTimeTrackLite and import the file."],
    ["Does it calculate income tax (TDS) on salary?", "Not yet. You enter each person's monthly TDS figure; it is kept across re-runs, printed on the payslip and posted to TDS payable. There is no tax regime choice, investment declaration or Form 16."],
    ["Can staff use it on their phones?", "There is no separate app. My HR works in a phone's browser, where staff clock in and out, apply for leave and read their payslips. There is no GPS or geo-fencing on clock-in."],
    ["How does visitor sign-in work?", "A tablet at reception runs a full-screen sign-in with no address bar. Visitors pick a purpose and who they are seeing, leave their details and a photo, and the host is told the moment they arrive."],
  ],
  related: ["/product/hr", "/product/payroll", "/product/attendance", "/product/leave", "/product/recruitment", "/solutions/hr-teams"],
  cta: { heading: `Bring your team into ${people.name}`, body: `Import your employees from a spreadsheet, connect a biometric terminal and run next month's payroll from the records. ${trial}` },
});

// ─── Deskzo Desk ─────────────────────────────────────────────────────────────────────────────────

const deskPage = productLinePage({
  slug: desk.path.slice(1),
  name: desk.name,
  seo: {
    title: `${desk.name}: helpdesk with SLAs and a portal`,
    description: `${desk.name} is a customer support helpdesk: tickets with SLA targets and owners, a customer portal opened from a link, and feedback after the work.`,
    keywords: [desk.name, "customer support helpdesk", "SLA targets"],
  },
  eyebrow: PRODUCT_GROUP_TITLES.sell,
  h1: headline(desk),
  lead: "Every customer request becomes a ticket with an owner, a priority and an SLA deadline, tied to the company, contact, subscription or machine it concerns. Customers get a portal of their own, and a rating link once the work is done.",
  answer: {
    question: `What is ${desk.name}?`,
    answer: `${desk.name} is a customer support helpdesk: a queue of tickets, each with a type, a priority, an SLA target and an assigned agent, and a portal where customers see their subscriptions, invoices and ticket status. A one-time link asks how it went once the work is done.`,
    more: [
      "Each priority has its SLA target: urgent tickets within 4 hours, high within 24, medium within 72 and low within 168. A ticket shows when it is due, or how long it has been overdue, and the support load page sets each customer's tickets against what they are billed.",
    ],
  },
  contents: { heading: `What's in ${desk.name}`, intro: contentsIntro(desk), items: moduleCards(desk) },
  how: [
    {
      heading: "How the customer portal works",
      intro: "The portal needs no password: each contact gets a personal link from your team.",
      steps: [
        "Create a portal link for the contact, with an expiry date if you want one.",
        "The customer opens it and sees their subscriptions, invoices and tickets.",
        "They ask for a renewal, more seats or an answer, which lands in customer requests.",
        "Your team works the request, and the link can be revoked at any time.",
      ],
    },
  ],
  worksWith: {
    heading: `What ${desk.name} works with`,
    intro: "Other products whose records a ticket can name.",
    links: [
      pair(crm, "The companies and contacts tickets are raised against."),
      pair(subscriptions, "The subscription a ticket concerns, and renewal requests from the portal."),
      pair(inventory, "The machine a ticket concerns, with its warranty and AMC cover."),
      pair(books, "Invoices in the portal, and support load set against what each customer is billed."),
    ],
  },
  faqHeading: `Questions about ${desk.name}`,
  faq: [
    ["Can customers raise tickets by email?", "Not yet. Tickets are raised by your team. In the portal, customers can send a question, a renewal request or a request for more seats, which reach your team as customer requests."],
    ["Can we change the SLA targets?", "Not today. The targets are fixed for each priority: 4 hours, 24 hours, 72 hours and 168 hours from creation."],
    ["Do customers need a password for the portal?", "No. Each contact gets a personal link from your team, which can carry an expiry date and can be revoked at any time. What the portal shows is one setting for everybody."],
    ["How is feedback collected?", "A one-time link asks the customer to rate the person who helped and the product, from one to five. Every answer is kept whatever the score, and a happy one can be offered your public review page."],
  ],
  related: ["/product/helpdesk", "/product/assets", "/product/subscriptions-renewals", "/solutions/it-services-resellers", "/pricing"],
  cta: { heading: `Answer every ticket on time with ${desk.name}`, body: `Set up a workspace and raise your first ticket against a customer today. ${trial}` },
});

// ─── Deskzo Inventory ────────────────────────────────────────────────────────────────────────────

const inventoryPage = productLinePage({
  slug: inventory.path.slice(1),
  name: inventory.name,
  seo: {
    title: `${inventory.name}: items, stock, orders and assets`,
    description: `${inventory.name} keeps items and stock, sales orders from punch to fulfilment, purchase orders and vendor bills, and IT assets by serial number.`,
    keywords: [inventory.name, "stock and order management", "IT asset tracking"],
  },
  eyebrow: PRODUCT_GROUP_TITLES.run,
  h1: headline(inventory),
  lead: "One catalogue of everything you sell, with stock counts for goods, orders approved and sourced, purchase orders to vendors, and every machine and licence tracked by serial number.",
  answer: {
    question: `What is ${inventory.name}?`,
    answer: `${inventory.name} is the stock and order management product for what a company sells and holds: the item master with SKUs, HSN or SAC codes and GST rates, stock counts with a movement log, sales orders from punch to fulfilment, purchase orders, and IT assets by serial.`,
    more: [
      "Stock moves only when a movement is recorded: received, sold, adjusted, returned or damaged, each with a reason and the person who recorded it. Invoices and bills don't change the count, which keeps it under your control, and stock can't go below zero.",
    ],
  },
  contents: { heading: `What's in ${inventory.name}`, intro: contentsIntro(inventory), items: moduleCards(inventory) },
  how: [
    {
      heading: "How an order is approved and sourced",
      intro: "Three people, three decisions, and nobody approves their own.",
      steps: [
        "Sales punches the order against the customer, priced from the catalogue.",
        "Accounts approves the payment terms.",
        "Purchasing sets the vendor, the cost and the PO number, and the order's margin is worked out.",
        "The order is fulfilled, and the stock count moves when someone records the movement.",
      ],
    },
  ],
  worksWith: {
    heading: `What ${inventory.name} works with`,
    intro: "Other products that read the same catalogue.",
    links: [
      pair(books, "Invoices and vendor bills priced from the same items, posted to the ledger."),
      pair(subscriptions, "Orders that start subscriptions, and AMCs on the machines they cover."),
      pair(desk, "Tickets that name the machine they concern."),
    ],
  },
  faqHeading: `Questions about ${inventory.name}`,
  faq: [
    ["Does issuing an invoice reduce stock?", "No. Invoices, bills and delivery challans don't change stock. The count moves when someone records a movement, which keeps it under your control."],
    ["Can I run several warehouses?", "Not today. Each item has one stock figure, with no godowns, bins or transfers between locations, and no batches or expiry dates."],
    ["Can I track serial numbers?", "Yes, through IT asset tracking: each unit is registered with its own serial number and linked to the catalogue item, with custody, warranty and AMC cover."],
    ["Is stock valued in the books?", "No. There is no FIFO or weighted-average costing, and stock movements don't post to the ledger."],
  ],
  related: ["/product/inventory", "/product/assets", "/product/purchases-payables", "/solutions/trading-distribution", "/solutions/operations"],
  cta: { heading: `Put your catalogue in ${inventory.name}`, body: `Import your items from a spreadsheet and start punching orders against them. ${trial}` },
});

// ─── Deskzo Subscriptions ────────────────────────────────────────────────────────────────────────

const subscriptionsPage = productLinePage({
  slug: subscriptions.path.slice(1),
  name: subscriptions.name,
  seo: {
    title: `${subscriptions.name}: renewals, add-ons and AMCs`,
    description: `${subscriptions.name} tracks recurring orders and renewals: each subscription's expiry, add-on seats priced to end with it, AMCs, and renewals due in 90 days.`,
    keywords: [subscriptions.name, "subscription renewal tracking", "add-on seats"],
  },
  eyebrow: PRODUCT_GROUP_TITLES.sell,
  h1: headline(subscriptions),
  lead: "Orders that start each subscription, add-on seats priced to end with their parent, AMCs, and a renewals list of what is due in the next 30 days, 60 days or 90 days, with a stage for each.",
  answer: {
    question: `What is ${subscriptions.name}?`,
    answer: `${subscriptions.name} is a product for subscription renewal tracking, built on your orders: each subscription's start and expiry dates, the add-ons it gathers, and a stage for each renewal worked out from what has happened. The renewal order is punched from the list in one click.`,
    more: [
      "The stages follow the activity: a task raised, the customer contacted, a quote sent, negotiating, on hold, lost or renewed. A rep can pin a stage by hand when they know more than the records do, and renewal tasks can be raised in bulk for a whole window.",
    ],
  },
  contents: { heading: `What's in ${subscriptions.name}`, intro: contentsIntro(subscriptions), items: moduleCards(subscriptions) },
  how: [
    {
      heading: "How a renewal is won back",
      intro: "Renewal tracking starts ninety days before the expiry date.",
      steps: [
        "The subscription appears in the 90-day window, and a renewal task is raised.",
        "The rep contacts the customer, and the stage moves as calls and quotes are logged.",
        "The renewal order is punched, approved and fulfilled.",
        "The new term starts, with every add-on seat renewed beside it.",
      ],
    },
  ],
  worksWith: {
    heading: `What ${subscriptions.name} works with`,
    intro: "Other products that read the same orders.",
    links: [
      pair(books, "Renewal proposals at the full-term price, invoices and the payments against them."),
      pair(inventory, "AMCs linked to the IT assets they cover, so each machine shows its cover."),
      pair(campaigns, "Journeys that start themselves when a renewal comes due."),
      pair(desk, "Tickets that name the subscription, and renewal requests from the portal."),
    ],
  },
  faqHeading: `Questions about ${subscriptions.name}`,
  faq: [
    ["What happens when a customer adds seats mid-term?", "The add-on ends on the same day as the parent subscription and is priced for the time left, by day or by month. At renewal, all seats are quoted at the full-term price."],
    ["Do subscriptions renew or invoice automatically?", "No. Renewals are raised from the renewals list, and invoicing is a step someone takes. Fulfilling an order doesn't create an invoice by itself."],
    ["Can we track AMCs on hardware?", `Yes. An AMC is a subscription; with ${inventory.name} in the workspace it is linked to the IT assets it covers, so each machine shows warranty, AMC, both or none.`],
  ],
  related: ["/product/subscriptions-renewals", "/product/revenue-close", "/solutions/saas-subscriptions", "/solutions/it-services-resellers", "/pricing"],
  cta: { heading: `Never miss a renewal with ${subscriptions.name}`, body: `Import your subscriptions with their expiry dates and see the next 90 days. ${trial}` },
});

// ─── Deskzo Projects ─────────────────────────────────────────────────────────────────────────────

const projectsPage = productLinePage({
  slug: projects.path.slice(1),
  name: projects.name,
  seo: {
    title: `${projects.name}: client projects and billing stages`,
    description: `${projects.name} is client project management: milestones, billing stages, agreements, encrypted client logins, risks, weekly updates and tasks.`,
    keywords: [projects.name, "client project management", "delivery milestones"],
  },
  eyebrow: PRODUCT_GROUP_TITLES.run,
  h1: headline(projects),
  lead: "Website builds, migrations and implementations, each with delivery milestones, billing stages, an agreement and NDA store, encrypted client credentials, risks and weekly updates, visible to the people on the project.",
  answer: {
    question: `What is ${projects.name}?`,
    answer: `${projects.name} is a client project management product for work you deliver to customers. Each project has milestones from templates, billing stages as an amount or a share of the value, documents, risks and a weekly health update, and only its stakeholders can see it.`,
    more: [
      "A project moves from proposed through discovery, planning, in progress, UAT, go-live and handover to completed, with a health of on track, at risk or off track. Tasks with due dates and reminders keep the work moving between updates.",
    ],
  },
  contents: { heading: `What's in ${projects.name}`, intro: contentsIntro(projects), items: moduleCards(projects) },
  how: [
    {
      heading: "How billing stages follow the work",
      intro: "A billing stage ties the invoice to the work that earned it.",
      steps: [
        "Set the project's billing stages, each an amount or a share of the value.",
        `When a stage falls due, raise its invoice from the project, with ${books.name} in the workspace.`,
        "The stage follows the invoice: invoiced, then paid, or back to due if it is cancelled.",
        "With Revenue & Close, a milestone's revenue is recognised in the month it is delivered.",
      ],
    },
  ],
  worksWith: {
    heading: `What ${projects.name} works with`,
    intro: "Other products a project reads from or writes to.",
    links: [
      pair(books, "Invoices raised from billing stages, followed until they are paid."),
      pair(crm, "The customer companies and contacts a project is delivered for."),
      pair(desk, "Support tickets once the project has gone live."),
    ],
  },
  faqHeading: `Questions about ${projects.name}`,
  faq: [
    ["Are there Gantt charts or timesheets?", "No. Projects track milestones, billing stages, documents, risks and weekly updates; there are no Gantt charts or timesheets."],
    ["Can a sales rep see every project?", "No. A project is visible to its stakeholders, and to people whose role can see all projects."],
    ["Can customers see their project?", "Not yet. Customer stakeholders are named on the project as contacts, but the customer portal doesn't show projects."],
    ["How are client credentials kept?", "Client logins are encrypted at rest on the project. Revealing one needs your own password, and every reveal is logged."],
  ],
  related: ["/product/projects", "/product/revenue-close", "/solutions/professional-services", "/solutions/operations", "/pricing"],
  cta: { heading: `Deliver your next project in ${projects.name}`, body: `Add your current projects with their milestones and billing stages. ${trial}` },
});

// ─── Deskzo Campaigns ────────────────────────────────────────────────────────────────────────────

const campaignsPage = productLinePage({
  slug: campaigns.path.slice(1),
  name: campaigns.name,
  seo: {
    title: `${campaigns.name}: email journeys, forms and events`,
    description: `${campaigns.name} sends B2B email journeys and campaigns with consent checked first, and runs enquiry forms and events with RSVPs and attendance.`,
    keywords: [campaigns.name, "B2B email journeys", "forms and events"],
  },
  eyebrow: PRODUCT_GROUP_TITLES.sell,
  h1: headline(campaigns),
  lead: "Campaigns and journeys that start from what your records already know, such as a renewal coming up or a proposal with no reply, and forms and events that collect enquiries, RSVPs and attendance. Every message is checked against consent first.",
  answer: {
    question: `What is ${campaigns.name}?`,
    answer: `${campaigns.name} is the {siteName} product for B2B email journeys and campaigns to your own contacts, and for the forms and events that bring people in. A journey starts from one of 19 triggers, and each step sends an email or a WhatsApp template, or gives one of your team a task.`,
    more: [
      "Consent is recorded by topic, renewals, offers, product news, events, newsletter and service, with where it came from. Before any message goes, it is checked: an unsubscribed or unverified address, a hard bounce, a reseller's customer, an open complaint, an overdue invoice or a ticket past its SLA holds it back.",
    ],
  },
  contents: { heading: `What's in ${campaigns.name}`, intro: contentsIntro(campaigns), items: moduleCards(campaigns) },
  how: [
    {
      heading: "How a journey runs",
      intro: "A journey reads the same records your sales team works from.",
      steps: [
        "Choose a trigger, such as a subscription due for renewal in 60 days.",
        "Add steps: an email now, a WhatsApp template a week later, and a task for the account manager if there is no reply.",
        "Before each step, the message is checked against consent, complaints, overdue invoices and quiet hours.",
        "The journey stops for a customer once the renewal is won.",
      ],
    },
  ],
  worksWith: {
    heading: `What ${campaigns.name} works with`,
    intro: "Other products whose records start a journey or hold a message back.",
    links: [
      pair(crm, "The contacts you mail, and the leads an enquiry form creates."),
      pair(cards, "Business cards for the stand, where whoever shares back becomes a lead."),
      pair(subscriptions, "Renewals coming due, the trigger for a renewal journey."),
      pair(desk, "Complaints and tickets past their SLA, which hold a message back."),
      pair(books, "Overdue invoices, which keep a customer out of a promotion."),
    ],
  },
  faqHeading: `Questions about ${campaigns.name}`,
  faq: [
    ["Which email providers can send our campaigns?", "Resend, Elastic Email, Amazon SES or Microsoft 365, with your own account. Transactional and marketing mail can go through different providers, with failover."],
    ["Can we send WhatsApp messages?", "Journeys and campaigns can send pre-approved WhatsApp templates through Meta's Cloud API. You need your own WhatsApp Business account and approved templates."],
    ["Can the forms be embedded on our website?", "Forms are shared as links to their own pages, by public link or personal invitation. They can't be embedded in a frame on another website."],
    ["Can an enquiry form create leads?", "Yes. Enquiry forms can create leads in the workspace's lead pipeline, where the assignment rules pick them up."],
  ],
  related: ["/product/marketing", "/product/crm", "/solutions/sales-teams", "/pricing"],
  cta: { heading: `Build your first journey in ${campaigns.name}`, body: `Import your contacts with their consent and start a renewal journey. ${trial}` },
});

// ─── Deskzo Analytics ────────────────────────────────────────────────────────────────────────────

const analyticsPage = productLinePage({
  slug: analytics.path.slice(1),
  name: analytics.name,
  seo: {
    title: `${analytics.name}: business reports and the forecast`,
    description: `${analytics.name} is business reporting by any dimension: orders, leads, tickets, invoices, payments and visits, plus a forecast from real win rates.`,
    keywords: [analytics.name, "business reporting", "forecast from win rates"],
  },
  eyebrow: PRODUCT_GROUP_TITLES.run,
  h1: headline(analytics),
  lead: "Any figure from your orders, leads, tickets, invoices, payments and visits, broken down by salesperson, customer, city, brand or month, and a forecast that weighs open deals by the rate each stage has actually won at.",
  heroPreview: "pipeline",
  answer: {
    question: `What is ${analytics.name}?`,
    answer: `${analytics.name} is the business reporting product over the records your workspace keeps. Choose a measure, such as order value or amount collected, break it down by one or two dimensions or by a period, and read it as a chart and a table. The forecast looks ahead at deals, renewals and cash.`,
    more: [
      "Each person sees only the accounts they can see elsewhere, so a report never shows more than the screens do. Results can be printed or exported as CSV, and the date a report runs on is yours to choose, such as the day an order was punched or the day it expires.",
    ],
  },
  contents: { heading: `What's in ${analytics.name}`, intro: contentsIntro(analytics), items: moduleCards(analytics) },
  how: [
    {
      heading: "How the forecast from win rates works",
      intro: "The forecast uses the rates your own pipeline has achieved, not fixed guesses.",
      body: [
        "Each stage's weight is its win rate over the last twelve months, once at least ten deals have closed from it. Until then a default applies, and managers can set their own. Deals past their expected close date are shown as slipped, so the forecast doesn't count them as if they were on time.",
      ],
      bullets: ["Open deals weighted by each stage's own win rate", "Renewals at each brand's own renewal rate", "Cash expected from each customer's usual lateness", "Machines coming out of warranty with no AMC"],
    },
  ],
  worksWith: {
    heading: `What ${analytics.name} works with`,
    intro: "Reports read what the other products record.",
    links: [
      pair(crm, "Leads and field visits, and the pipeline the forecast weighs."),
      pair(books, "Invoices and payments, and the cash customers are expected to pay."),
      pair(subscriptions, "Orders by brand, family or month, and renewals coming due."),
      pair(desk, "Tickets by customer, type or month."),
    ],
  },
  faqHeading: `Questions about ${analytics.name}`,
  faq: [
    [`Does ${analytics.name} work on its own?`, `It reports on the records in your workspace. Leads are in every workspace; orders, invoices, payments, tickets and visits come from the products that keep them, such as ${crm.name}, ${books.name} and ${desk.name}.`],
    ["Can I see revenue by brand by quarter?", "Yes. Choose orders as the source, order value as the measure, brand as the breakdown and quarter as the period."],
    ["Can reports be scheduled or emailed?", "Not yet. Reports run when you open them, and you can export them as CSV or print them."],
    ["Do reports include the ledger?", `The report builder reads orders, leads, tickets, invoices, payments and visits. Ledger figures are in the accounting statements in ${books.name}.`],
  ],
  related: ["/product/reports", "/product/ai-copilot", "/product/targets-incentives", "/solutions/founders", "/pricing"],
  cta: { heading: `Ask your own questions in ${analytics.name}`, body: `Set up a workspace and build your first breakdown in a minute. ${trial}` },
});

// ─── Deskzo Vault ────────────────────────────────────────────────────────────────────────────────

const vaultPage = productLinePage({
  slug: vault.path.slice(1),
  name: vault.name,
  seo: {
    title: `${vault.name}: a shared password manager for teams`,
    description: `${vault.name} is a shared password manager for a company's own logins: owners, shares, rotation reminders, every opening logged, and an archive.`,
    keywords: [vault.name, "shared password manager", "password rotation"],
  },
  eyebrow: PRODUCT_GROUP_TITLES.people,
  h1: headline(vault),
  lead: "The company's own logins, registrars, hosting panels, partner portals and tax accounts, encrypted at rest and opened with your own password. Every record has an owner, is shared deliberately, and says when its password is due for a change.",
  answer: {
    question: `What is ${vault.name}?`,
    answer: `${vault.name} is a shared password manager for a company's own logins. Each record belongs to a person, is shared with a colleague or a department to open or to manage, and is opened only with the viewer's own password, every time. Every opening is logged, and the owner is told.`,
    more: [
      "Admins can open any record. That is a deliberate choice, paid for openly: when an admin uses the override, it is recorded as one and the owner is notified, so the access can be reviewed. A record can also be held on a client's behalf, linked to that client, and listed with everything else you hold for them.",
    ],
  },
  contents: { heading: `What's in ${vault.name}`, intro: contentsIntro(vault, " The vault is also described with roles and sign-in rules on the security and access page."), items: moduleCards(vault) },
  extra: [
    {
      id: "vault-features",
      type: "featureGrid",
      props: {
        heading: "What the vault does",
        intro: "Each record says who owns it, who can open it, when it was last changed and who has opened it.",
        columns: 3,
        items: [
          { icon: "users", title: "Owners and shares", body: "Every record belongs to a person. Share it with a colleague or a department, to open or to open, edit and share, and optionally until a date." },
          { icon: "lock", title: "Your own password, every time", body: "A password is shown only after the viewer enters their own password, every time, never remembered for a session. Nothing is copied to the clipboard unless they press Copy." },
          { icon: "history", title: "Every opening logged", body: "Who opened what, when, and how they were entitled: their own, shared, through their department, or an admin override. The owner is told whenever someone else opens it." },
          { icon: "calendar", title: "Password rotation", body: "Set how many days a password may stay unchanged. It shows as due a fortnight ahead and overdue after, and a changed password is dated." },
          { icon: "check", title: "Pins and reuse", body: "Each person pins their own shortlist to the top. A record shows when the same password is on other records you can see, and a generator makes a new one." },
          { icon: "scroll", title: "An archive, not a delete", body: "A deleted record is kept for 60 days, where an admin can restore it with its owner and shares intact, and is destroyed after that." },
          { icon: "mail", title: "Billing expiry reminders", body: "A login with a billing expiry, such as a domain or a hosting plan, sends its owner reminders every five days through the month before it lapses." },
          { icon: "door", title: "Handover when someone leaves", body: "The logins a leaver owns move to a colleague, and each is flagged for a password change within 15 days, because the leaver still knows it." },
        ],
      },
    },
  ],
  how: [
    {
      heading: "How a shared password is kept current",
      intro: "Password rotation is a date on the record, not a reminder somebody has to remember.",
      steps: [
        "Store the login with its address and username, and generate a password in the same box.",
        "Share it with the people or the department that need it, to open or to manage.",
        "Set it to rotate after a number of days; it shows as due two weeks before.",
        "Whoever manages it changes the password, the record is dated again, and the owner is told if it wasn't them.",
      ],
    },
  ],
  worksWith: {
    heading: `What ${vault.name} works with`,
    intro: "Other products that hold or hand over credentials.",
    links: [
      pair(people, "Exits that start a handover, so a leaver's logins move on and are changed."),
      pair(projects, "Client logins stored on each project, encrypted and logged the same way."),
      pair(one, "Every product in one workspace, the vault included."),
    ],
  },
  faqHeading: `Questions about ${vault.name}`,
  faq: [
    ["Can an admin open anyone's passwords?", "Yes. Admins can open any record. Each time, it is recorded as an admin override and the owner is notified, so the access can be reviewed rather than hidden."],
    ["What happens when someone deletes a record?", "It moves to the archive for 60 days, where an admin can restore it with its owner and shares intact. After that it is destroyed. Destroying one early is a separate, permanent action."],
    ["Can the vault fill passwords in my browser?", "No. There is no browser extension or autofill. A password is opened in {siteName} with your own password, and copied with the Copy button when you need it."],
    ["What happens to a leaver's passwords?", "A handover moves the logins they own to a colleague, or several, and flags each for a password change within 15 days."],
  ],
  related: ["/product/security", "/security", "/solutions/it-admins", "/pricing"],
  cta: { heading: `Move your team's passwords into ${vault.name}`, body: `Store your first shared logins, share them with the right people and set their rotation. ${trial}` },
});

// ─── Deskzo Cards ────────────────────────────────────────────────────────────────────────────────

const cardsPage = productLinePage({
  slug: cards.path.slice(1),
  name: cards.name,
  seo: {
    title: `${cards.name}: digital business cards for teams`,
    description: `${cards.name} gives your people digital business cards in the company's design, with a QR code, one-tap Save contact, and leads from whoever shares back.`,
    keywords: [cards.name, "digital business cards for teams", "QR code business card"],
  },
  eyebrow: PRODUCT_GROUP_TITLES.sell,
  h1: headline(cards),
  lead: "A business card that never runs out: the person's photo, title and work numbers from their record, the company's colours and logo, a QR code and a link. Whoever they meet saves the contact in one tap, and can send their own details back.",
  answer: {
    question: `What is ${cards.name}?`,
    answer: `${cards.name} gives the people a company chooses a digital business card on the company's own address. HR or an admin issues the cards and designs them; each card shows what the person's record says and the design allows, and works in any phone's browser, with no app and no sign-in.`,
    more: [
      "Nobody has a card until somebody issues one. When a person leaves, their card stops showing them the day after their last day and shows the company's details instead, and the people who shared back stay with the company.",
    ],
  },
  contents: { heading: `What's in ${cards.name}`, intro: contentsIntro(cards), items: moduleCards(cards) },
  extra: [
    {
      id: "cards-features",
      type: "featureGrid",
      props: {
        heading: "What a card does",
        intro: "One card per person, in a design the company sets.",
        columns: 3,
        items: [
          { icon: "users", title: "Issued, not self-made", body: "Issue cards to one person, a department, a branch, a role or everyone at once. Switch one off, and its link shows the company instead." },
          { icon: "layers", title: "Templates and locked fields", body: "The colour, layout and logo, the fields every card shows, and the ones a person can't leave off. Change a template and every card on it changes." },
          { icon: "check", title: "Kept in step with the record", body: "Name, photo, job title, work phone, email and office address come from the person's record, so a new title is on the card the moment it changes." },
          { icon: "card", title: "QR code and link", body: "A QR code with the company logo in it, a link that stays the same for the life of the card, and a page that works on any phone." },
          { icon: "file-text", title: "Save contact in one tap", body: "The contact, with the photo, goes straight into an iPhone or Android phone's contacts. Saving never asks for anything in return." },
          { icon: "mail", title: "Leads from sharing back", body: "Under the card, an optional form: name, email or phone, and up to five questions of your own. With the CRM, it is a lead in the card holder's name." },
          { icon: "chart", title: "Views, saves and taps", body: "Each card counts its views, saves, link taps and share-backs, this week and in all. Counts only — nothing about who." },
          { icon: "door", title: "When somebody leaves", body: "The card goes dark after their last working day, and the people they met move to whoever takes over their accounts." },
          { icon: "calendar", title: "Trade shows and events", body: "An event with its dates, team, goal and cost. While it runs, everybody the team meets through their cards is counted against it." },
          { icon: "building", title: "A booth form for the stand", body: "Each card's form opens first at the stand, with the event's own questions, and clears itself for the next visitor." },
          { icon: "gauge", title: "Scans and results", body: "The team scans visitors' cards from a phone; the event shows who was met, by person and by day, against the goal and the cost." },
          { icon: "lock", title: "Nothing personal by default", body: "A card shows a work number and a work email. A personal number is on it only if the person adds it themselves." },
        ],
      },
    },
  ],
  how: [
    {
      heading: "How a team gets its cards",
      intro: "A company's cards are one design, issued from one list.",
      steps: [
        "Design the card: colour, layout, logo, and which fields every card shows.",
        "Issue cards to the people who meet customers, one by one or a department at a time.",
        "Each person opens My card, adds their LinkedIn or WhatsApp if they like, and saves the QR to their phone.",
        "The people they meet save the contact, and those who share back arrive as leads or card contacts.",
      ],
    },
  ],
  worksWith: {
    heading: `What ${cards.name} works with`,
    intro: "A card reads the person's record and hands what it collects to the products that use it.",
    links: [
      pair(crm, "Share-backs become leads in the card holder's name, with the source Digital card."),
      pair(people, "Job titles, photos and exits from the HR record, so a leaver's card goes dark on time."),
      pair(one, "Every product in one workspace, cards included."),
    ],
  },
  faqHeading: `Questions about ${cards.name}`,
  faq: [
    ["Does the person I meet need an app?", "No. The card is a web page on your company's own address. It opens in any phone's browser, and Save contact works on iPhone and Android."],
    ["Who decides who gets a card?", "Whoever manages cards in your workspace, usually HR or an admin. Nobody has one until it is issued, and it can be switched off at any time."],
    [`Do I need ${crm.name} to collect leads?`, `No. Without it, whoever shares back is kept as a card contact with their details and answers. With ${crm.name}, each one is also a lead.`],
    ["Can a card work with an NFC tag?", "Yes. Write the card's link to any NFC card or sticker with a free NFC app, and a tap on a phone opens the card. Nothing to buy from us."],
    ["Can the team use cards at a trade show?", "Yes. Make an event with its dates, team, goal and cost. Each card gets a booth form for the stand, with the event's own questions; the team can scan visitors' cards; and everybody met is counted against the event, by person and by day, with the cost per person."],
    ["Are Apple Wallet and Google Wallet supported?", "Not yet. Today a card is its link and its QR code; on a phone it can be added to the home screen to open in one tap."],
  ],
  related: ["/product/crm", "/product/hr", "/pricing"],
  cta: { heading: `Give your team ${cards.name}`, body: `Design the card, issue it to the people who meet customers, and see who saved it. ${trial}` },
});

export const PRODUCT_LINE_PAGES: SeedPage[] = [onePage, crmPage, booksPage, peoplePage, deskPage, inventoryPage, subscriptionsPage, projectsPage, campaignsPage, analyticsPage, vaultPage, cardsPage];

// Every product in products.ts has its page here, at its own path: a product added there and not here fails the seed.
const missing = PRODUCTS.filter((p) => !PRODUCT_LINE_PAGES.some((page) => `/${page.slug}` === p.path));
if (missing.length) throw new Error(`No page for ${missing.map((p) => p.name).join(", ")} in scripts/site-content/products.ts.`);

export const section: SeedSection = { name: "Products", pages: PRODUCT_LINE_PAGES };

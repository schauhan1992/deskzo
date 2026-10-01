import { productPage } from "./_build";
import type { SeedPage } from "./types";

/**
 * The "Run the business" column: accounting and GST, purchases and payables, inventory, expenses,
 * assets, reports and the forecast. Checked against src/lib/ledger/**, src/lib/receivables.ts,
 * src/lib/reconcile/**, src/actions/{item,expense,asset,consignment,analytics,forecast}.ts and their
 * check scripts. Returns are prepared, not filed; stock moves only when a movement is recorded.
 */

const accounting = productPage({
  slug: "product/accounting-gst",
  name: "Accounting & GST",
  seo: {
    title: "GST accounting software that posts itself",
    description: "GST accounting software for Indian companies: a ledger that posts itself, GSTR-1 and GSTR-3B per GSTIN, TDS, bank reconciliation and locked periods.",
    keywords: ["GST accounting software", "GSTR-1 and GSTR-3B", "bank reconciliation"],
  },
  eyebrow: "Run the business",
  h1: "GST accounting software with books that keep themselves up to date",
  lead: "A double-entry ledger that posts itself as you invoice, bill, pay and run payroll. Financial statements, bank reconciliation, GSTR-1 and GSTR-3B prepared for each GSTIN, TDS and TCS, and periods you lock once they are filed.",
  answer: {
    question: "What is GST accounting software?",
    answer:
      "GST accounting software is the system that keeps a company's books and works out the GST it owes and can claim. In {siteName}, every tax invoice, credit note, vendor bill, payment, expense claim and payroll run posts its own journal entry, and GSTR-1 and GSTR-3B are prepared from those postings.",
    more: [
      "Nobody re-keys an invoice into the books. Issuing it writes the entry in the same transaction, split into sales and output CGST and SGST, or IGST, by the place of supply. Cancelling it writes the reversal. A mistake is never edited away: it is corrected by a dated reversing entry, so the trail stays whole.",
    ],
  },
  features: {
    heading: "What the accounting module covers",
    intro: "The accounting module covers the ledger, the statements built from it, and the tax returns and bank checks that depend on it.",
    items: [
      { icon: "book", title: "A ledger that posts itself", body: "An Indian chart of accounts, seeded and editable, with input and output GST, TDS, TCS, PF, ESI and PT accounts. Postings come from invoices, bills, payments, expense claims, payroll and depreciation." },
      { icon: "scroll", title: "Financial statements", body: "Trial balance, profit and loss (by branch if you like), balance sheet, cash flow by the indirect method, and a drill-down ledger for any account." },
      { icon: "file-text", title: "GSTR-1 and GSTR-3B", body: "Prepared for each GSTIN for a month: B2B invoice by invoice, B2C by place of supply and rate, an HSN/SAC summary, and the summary return with input credit." },
      { icon: "check", title: "Checks before you file", body: "An invalid GSTIN, a missing place of supply or a line without an HSN or SAC code is listed before you file, and output tax is checked against the ledger." },
      { icon: "rupee", title: "TDS and TCS", body: "Tax deducted on vendor bills and withheld by customers is posted to its own accounts. A monthly TDS page shows what is due and warns when a party has no PAN." },
      { icon: "building", title: "Bank reconciliation", body: "Import bank statements as CSV, accept the suggested matches or match by hand, and save each reconciliation with its difference." },
      { icon: "globe", title: "Fourteen currencies", body: "Documents post in rupees at their own rate, and each payment books its realised exchange gain or loss." },
      { icon: "lock", title: "Periods you close", body: "A lock date refuses any posting on or before it, and the year-end close moves profit into retained earnings. Both need their own permission." },
    ],
  },
  how: [
    {
      heading: "How an invoice reaches the ledger",
      intro: "The invoice is the source: the ledger, the return and the receivable all read from it.",
      body: [
        "Issuing a GST tax invoice posts the receivable, the sale and the output tax in one step. GST accounting software that works this way has no end-of-month data entry: GSTR-1 lists the invoice, GSTR-3B counts its tax, and the receivables ageing shows it until a payment is allocated against it. When the month is filed, lock it, and nothing dated inside it can change.",
      ],
      bullets: ["CGST and SGST within a state, IGST between states", "Credit notes reverse their share of the sale and the tax", "Payments clear the receivable and book any exchange difference"],
      preview: "invoice",
    },
    {
      heading: "How bank reconciliation works",
      intro: "Bank reconciliation compares your bank's statement with your books, line by line.",
      steps: [
        "Import the month's statement as a CSV file; importing the same file twice adds nothing.",
        "{siteName} suggests a match where exactly one book entry has the same reference and amount, or the same amount within five days.",
        "Accept the suggestions, match the rest by hand, and post anything missing, such as bank charges, as a journal.",
        "Save the reconciliation with the statement balance, the book balance and the difference.",
      ],
    },
  ],
  faq: [
    ["Does {siteName} file my GST returns?", "No. It prepares GSTR-1 and GSTR-3B for each GSTIN, with checks that catch what the portal would reject. You file them on the GST portal."],
    ["Can I reconcile my input credit against GSTR-2B?", "Not yet. Input credit on GSTR-3B comes from your vendor bills and expense claims in the ledger. Matching it with GSTR-2B is done on the portal."],
    ["Which bank statement formats can I import?", "CSV, in the layouts most Indian banks export: columns are found by name, with one amount column or separate debit and credit columns. There are no live bank feeds."],
    ["Can anyone change a month after it is filed?", "Not while it is locked. Moving the lock needs the permission to lock periods, which is separate from the permission to post journals, and every change is in the audit log."],
  ],
  related: ["/product/quotes-invoices", "/product/payments-receivables", "/product/purchases-payables", "/product/revenue-close", "/product/multi-branch-gst", "/solutions/finance-teams"],
  cta: { heading: "See your invoices post themselves", body: "Accounting is offered to companies in India. Set up a workspace and issue a test invoice during the {trialDays}-day free trial." },
});

const purchases = productPage({
  slug: "product/purchases-payables",
  name: "Purchases & payables",
  seo: {
    title: "Purchase order software and payables",
    description: "Purchase order software with vendor bills, GST and TDS posted to the books, accounts payable ageing, and distributor statements checked against sales.",
    keywords: ["purchase order software", "accounts payable", "vendor statement reconciliation"],
  },
  eyebrow: "Run the business",
  h1: "Purchase order software from order to payment",
  lead: "Purchase orders to vendors, the bills that come back with GST and TDS worked out, payments allocated against them, and what you owe aged from each bill's due date. Distributor statements are checked against what you sold.",
  answer: {
    question: "What does purchase order software do?",
    answer:
      "Purchase order software is the record of what you ordered from a vendor, followed to the bill and the payment. In {siteName}, a purchase order converts into a vendor bill, the bill posts to the ledger with its input GST, and payments are allocated against it.",
    more: [
      "Accounts payable is the other side of the same records. The payables ageing groups what you owe as not yet due, then up to 30 days, up to 60 days, up to 90 days and over 90 days late, from each bill's due date. A vendor statement shows the bills and payments over any period, so a vendor's reminder can be answered in a minute.",
    ],
  },
  features: {
    heading: "What purchases and payables cover",
    intro: "Purchases and payables cover everything from the order you place to the payment that settles it.",
    items: [
      { icon: "file-text", title: "Purchase orders to bills", body: "Raise a purchase order on a vendor, then convert it into the bill when it arrives." },
      { icon: "receipt", title: "Vendor bills with GST and TDS", body: "GST worked out per line, within a state or between states, and TDS or TCS where it applies. Issuing a bill posts purchases, input tax and the payable." },
      { icon: "rupee", title: "Payments against bills", body: "Allocate each payment to the bills it settles. A foreign-currency bill is paid at the day's rate, with the exchange difference booked." },
      { icon: "gauge", title: "Accounts payable ageing", body: "What you owe in five age buckets, and a statement of account for each vendor over any dates." },
      { icon: "check", title: "Distributor statement checks", body: "Upload a distributor's statement as CSV or Excel. Each line is matched with the period's sales orders and marked matched, quantity or price mismatch, billed not sold, sold not billed, or unknown." },
      { icon: "truck", title: "A vendors directory", body: "Vendors, OEMs, distributors and partners, kept apart from customers, each with its onboarding status." },
    ],
  },
  how: [
    {
      heading: "How vendor statement reconciliation works",
      intro: "Vendor statement reconciliation finds a distributor's charges that don't match what you sold.",
      steps: [
        "Upload the distributor's statement, or paste its lines. The column mapping is guessed and remembered for that vendor.",
        "{siteName} compares each line with the period's sales orders by SKU, customer, quantity and price.",
        "Every line gets a result, so seat counts, unit costs and subscriptions billed with no live order stand out.",
        "Raise the differences with the distributor before you pay the bill.",
      ],
    },
  ],
  faq: [
    ["Is there a three-way match of order, receipt and bill?", "No. {siteName} has no goods receipt step, so a purchase order's quantities aren't matched with its bill. Its reconciliation checks a distributor's statement against your sales."],
    ["Does the GST on bills reach GSTR-3B?", "Yes. Input GST on vendor bills posts to the input tax accounts, and GSTR-3B takes its input credit from the ledger."],
    ["Can I record debit notes to vendors?", "Not yet. Credit notes exist on the sales side only. A vendor's credit is recorded with a journal entry for now."],
    ["Does a vendor bill add to stock?", "No. Bills post to purchases in the ledger. Stock is changed by recording a stock movement on the item."],
  ],
  related: ["/product/accounting-gst", "/product/inventory", "/product/subscriptions-renewals", "/solutions/operations", "/solutions/trading-distribution"],
  cta: { heading: "Know what you owe, and to whom", body: "Set up a workspace and enter this month's vendor bills. Every workspace starts with a {trialDays}-day free trial." },
});

const inventory = productPage({
  slug: "product/inventory",
  name: "Inventory",
  seo: {
    title: "Inventory management software for items",
    description: "Inventory management software for a catalogue of goods, services, subscriptions and licences, with HSN/SAC codes, brands, product families and stock counts.",
    keywords: ["inventory management software", "item master with HSN codes", "stock tracking"],
  },
  eyebrow: "Run the business",
  h1: "Inventory management software for everything you sell",
  lead: "Inventory starts with one catalogue of goods, services, subscriptions and perpetual licences, with SKUs, HSN or SAC codes, GST rates, brands and product families. Goods can carry a stock count, with every movement recorded.",
  answer: {
    question: "What does the inventory module manage?",
    answer:
      "Inventory management software is the record of what a company sells and holds. In {siteName} it starts with the item master: every item you sell, with its SKU, HSN or SAC code, unit, prices and GST rate. Quotes, invoices, orders and renewals all pick items from it.",
    more: [
      "Stock tracking is switched on item by item. A tracked item has an on-hand quantity and a movement log: received, sold, adjusted, returned or damaged, each with a reason and the person who recorded it. Stock can't go below zero, and the item page shows its reorder level.",
    ],
  },
  features: {
    heading: "What the item master holds",
    intro: "The item master holds everything a quote or an invoice needs to know about what you sell.",
    items: [
      { icon: "package", title: "Four kinds of item", body: "Goods, services, subscriptions and perpetual licences, each with a unique SKU and an item number." },
      { icon: "file-text", title: "Item master with HSN codes", body: "An HSN or SAC code of four, six or eight digits on each item, checked as it is entered, with its GST rate and unit." },
      { icon: "layers", title: "Brands and product families", body: "Items grouped by brand and family, which reports break figures down by." },
      { icon: "calendar", title: "Billing cycles", body: "Monthly, quarterly, annual or one-time, so a subscription item carries its cycle into orders and renewals." },
      { icon: "history", title: "Stock movements", body: "On-hand quantity and a log of every movement with its reason, for the items you track." },
      { icon: "database", title: "Import and export", body: "Bring the catalogue in from a CSV file, with missing brands and families created, and export it again unchanged." },
    ],
  },
  how: [
    {
      heading: "How stock tracking works",
      intro: "Stock tracking in {siteName} is a count per item that changes only when a movement is recorded.",
      steps: [
        "Switch on stock tracking for the goods you hold.",
        "Record goods received, sold, returned or damaged as movements, each with a reason.",
        "Adjust the count after a physical check, and the adjustment is logged with who made it.",
        "Watch the reorder level on each item's page.",
      ],
    },
  ],
  faq: [
    ["Does issuing an invoice reduce stock?", "No. Invoices, bills and delivery challans don't change stock. The count moves when someone records a movement, which keeps it under your control."],
    ["Can I run several warehouses?", "Not today. Each item has one stock figure, with no godowns, bins or transfers between locations, and no batches or expiry dates."],
    ["Can I track serial numbers?", "Yes, through IT assets: each unit is registered with its own serial number and linked to the catalogue item."],
    ["Is stock valued in the books?", "No. There is no FIFO or weighted-average costing, and stock movements don't post to the ledger."],
  ],
  related: ["/product/quotes-invoices", "/product/purchases-payables", "/product/assets", "/product/import-migration", "/solutions/trading-distribution"],
  cta: { heading: "Put your catalogue in one place", body: "Import your items from a spreadsheet and start quoting from them. Every workspace starts with a {trialDays}-day free trial." },
});

const expenses = productPage({
  slug: "product/expenses",
  name: "Expenses",
  seo: {
    title: "Expense management software with approvals",
    description: "Expense management software: claims with receipts and GST, travel claimed against field visits, manager approval, reimbursement and postings to the ledger.",
    keywords: ["expense management software", "expense claim approval", "employee reimbursement"],
  },
  eyebrow: "Run the business",
  h1: "Expense management software from claim to reimbursement",
  lead: "Staff claim what they spent, with a receipt and any GST on it. Their manager approves, accounts reimburses, and the ledger posts the expense on approval.",
  answer: {
    question: "How does expense claim approval work?",
    answer:
      "Expense claim approval in {siteName} takes one decision. The approver is fixed when the claim is submitted: the claimant's manager, or someone with the expense approval permission. Nobody approves their own claim, and a rejection needs a reason.",
    more: [
      "Expense management software is the place staff claim what they spent and managers approve it, and it is only useful if claims arrive with what accounts needs. Each claim has a category, a payment mode, the amount, any GST on the bill, a receipt image and whether it is reimbursable. A claim can be tied to a field visit, a company or a lead, so travel is claimed against the visit it was for.",
    ],
  },
  features: {
    heading: "What expense claims carry",
    intro: "Each expense claim carries what accounts needs to approve, post and reimburse it.",
    items: [
      { icon: "layers", title: "Sixteen categories", body: "Travel, fuel, mileage, tolls and parking, accommodation, meals, client entertainment, courier, phone, supplies, software, marketing, training, repairs, professional fees and other." },
      { icon: "card", title: "How it was paid", body: "Cash, a personal card, a company card, UPI or a bank transfer, and whether the company owes the claimant." },
      { icon: "map-pin", title: "Claims against visits", body: "Travel is claimed against the field visit, and the visit lists what it cost." },
      { icon: "check", title: "Draft to reimbursed", body: "Draft, submitted, approved or rejected, then reimbursed, with both sides told at each step." },
      { icon: "rupee", title: "Employee reimbursement", body: "Reimburse approved claims in bulk, with the payment reference and date." },
      { icon: "book", title: "Posted on approval", body: "An approved claim posts the expense and its input GST to the ledger, and the reimbursement posts the payment." },
    ],
  },
  how: [
    {
      heading: "How a claim becomes a posting",
      intro: "The claim is the record accounts works from, from submission to payment.",
      steps: [
        "The employee adds the claim with its receipt and submits it.",
        "Their manager approves it, or rejects it with a reason.",
        "On approval, the expense and its GST post to the ledger, owed to the employee.",
        "Accounts reimburses approved claims in a batch, and the payment posts.",
      ],
    },
  ],
  faq: [
    ["When does an expense reach the profit and loss?", "On approval, before it is reimbursed. The claim posts to its category's expense account and the amount owed to the employee."],
    ["Can GST on staff bills be claimed as input credit?", "The GST recorded on a claim goes to the input tax accounts and shows on GSTR-3B as credit from expense claims. It is treated as within the state."],
    ["Is there multi-level approval or spending limits?", "No. Approval is a single step, and there are no policy limits or daily allowances. Receipts are attached as images, not read automatically."],
  ],
  related: ["/product/crm", "/product/accounting-gst", "/product/hr", "/solutions/sales-teams", "/solutions/finance-teams"],
  cta: { heading: "Stop chasing receipts", body: "Set up a workspace and let your team claim their expenses this month. Every workspace starts with a {trialDays}-day free trial." },
});

const assets = productPage({
  slug: "product/assets",
  name: "Assets",
  seo: {
    title: "Fixed asset management software and IT assets",
    description: "Fixed asset management software with monthly depreciation and disposals, plus IT asset management by serial, with custody, warranty and AMC cover.",
    keywords: ["fixed asset management software", "IT asset management", "depreciation"],
  },
  eyebrow: "Run the business",
  h1: "Fixed asset management software, and every machine by serial",
  lead: "A fixed asset register that depreciates itself each month and books disposals, and an IT asset register for every machine and licence you own, deploy or look after for a client.",
  answer: {
    question: "What is fixed asset management software?",
    answer:
      "Fixed asset management software is the register of what a company owns, with the depreciation worked out. In {siteName}, each asset has its cost, salvage value, useful life and method, and a monthly run posts the depreciation to the ledger.",
    more: [
      "IT asset management sits beside it, for the machines and licences themselves. Each unit has a serial number, an owner and a custodian, and a movement history that is only ever added to. A client's machine you maintain is tracked the same way, and it can never reach your balance sheet.",
    ],
  },
  features: {
    heading: "What the two registers track",
    intro: "The two registers track the value of what you own and the whereabouts of every unit.",
    items: [
      { icon: "book", title: "Depreciation, monthly", body: "Straight line, or written down value at a rate, chosen per asset. Each asset is charged at most once a month, and the last charge lands on its salvage value." },
      { icon: "rupee", title: "Disposals", body: "Record the sale proceeds and the gain or loss is worked out and posted." },
      { icon: "server", title: "Every machine and licence", body: "Eleven kinds of asset, from laptops to software licences, owned internally, deployed at a client, or owned by the client." },
      { icon: "users", title: "Custody with acknowledgement", body: "Each handover is acknowledged by the person receiving it, and everyone sees what they are holding." },
      { icon: "shield", title: "Warranty and AMC cover", body: "Warranty end dates and AMCs linked to their order, with one status saying whether an asset is covered." },
      { icon: "truck", title: "Consignments", body: "Deliveries, repairs, returns and transfers dispatched and delivered, raising a delivery challan and flagging when an e-way bill is needed." },
    ],
  },
  how: [
    {
      heading: "How an IT asset moves",
      intro: "{siteName} follows each unit through custody, cover and movement, from the day it is registered.",
      steps: [
        "Register the unit with its serial number, its catalogue item and who owns it.",
        "Hand it over; the receiving employee or client contact acknowledges it.",
        "Link its AMC to the order that bills it, so renewals and tickets follow.",
        "Move it with a consignment, which raises the delivery challan and checks whether an e-way bill is needed.",
      ],
    },
  ],
  faq: [
    ["Which depreciation methods are supported?", "Straight line and written down value, chosen for each asset. There is one method per asset, so parallel Companies Act and income-tax registers aren't kept."],
    ["Are Schedule II useful lives built in?", "No. You set each asset's useful life or rate yourself. There is no built-in table and no income-tax block of assets."],
    ["Can we track client machines we maintain?", "Yes. Client-owned assets are tracked with their serials, custody and AMC cover, and never reach your fixed asset register."],
  ],
  related: ["/product/accounting-gst", "/product/subscriptions-renewals", "/product/helpdesk", "/product/inventory", "/solutions/it-services-resellers"],
  cta: { heading: "Know where every asset is", body: "Set up a workspace and register your assets this week. Every workspace starts with a {trialDays}-day free trial." },
});

const reports = productPage({
  slug: "product/reports",
  name: "Reports & forecast",
  seo: {
    title: "Custom report builder and sales forecasting",
    description: "A custom report builder for orders, leads, tickets, invoices, payments and visits by any dimension, finance cards from the ledger, and sales forecasting.",
    keywords: ["custom report builder", "sales forecasting", "finance dashboard"],
  },
  eyebrow: "Run the business",
  h1: "A custom report builder, and sales forecasting from real win rates",
  lead: "Any figure broken down by anything else: salesperson, customer, city, brand, product family, month or quarter. Finance cards read from the ledger, and the forecast weighs open deals by the rate each stage has actually won at.",
  heroPreview: "pipeline",
  answer: {
    question: "What can the custom report builder show?",
    answer:
      "A custom report builder is a tool for asking your own questions of the data. The one in {siteName} reads six sources: orders, leads, tickets, invoices, payments and field visits. Choose a measure, such as order value or amount collected, then break it down by one or two dimensions or by a period.",
    more: [
      "Each person sees only the accounts they can see elsewhere, so a report never shows more than the screens do. Results come as a chart and a table, which can be printed or exported as CSV. The date a report runs on is yours to choose, such as the day an order was punched or the day it expires.",
    ],
  },
  features: {
    heading: "What reports and the forecast cover",
    intro: "Reports and the forecast cover what has happened, broken down any way you like, and what is likely to happen next.",
    items: [
      { icon: "chart", title: "Breakdowns by anything", body: "Salesperson, team, account manager, customer, industry, tag, lead source, city, state, product, SKU, brand, family, new or renewal, vendor and place of supply." },
      { icon: "calendar", title: "Across time", body: "Days, weeks, months, quarters or years, crossed with a second breakdown." },
      { icon: "gauge", title: "A finance dashboard", body: "Income and expense on an accrual or cash basis, top expenses, cash flow, receivables and payables, read from the ledger." },
      { icon: "sparkles", title: "Sales forecasting", body: "Open deals weighted by each stage's win rate over the last year, with pipeline, best case, commit and weighted figures." },
      { icon: "history", title: "Renewals and cash", body: "Renewals at each brand's own renewal rate, and cash expected with due dates pushed back by each customer's usual lateness." },
      { icon: "shield", title: "Cover running out", body: "Machines coming out of warranty with no AMC, beside targets, last year and each salesperson's commit." },
    ],
  },
  how: [
    {
      heading: "How sales forecasting weighs a deal",
      intro: "Sales forecasting in {siteName} uses the rates your own pipeline has achieved, not fixed guesses.",
      body: [
        "Each stage's weight is its win rate over the last twelve months, once at least ten deals have closed from it. Until then a default applies, and managers can set their own. Deals past their expected close date are shown as slipped, so the forecast doesn't count them as if they were on time.",
      ],
      bullets: ["Pipeline, best case, commit and weighted totals", "By month, quarter or financial year", "Beside the period's targets and last year's figures"],
      preview: "pipeline",
      side: "left",
    },
  ],
  faq: [
    ["Can I see revenue by brand by quarter?", "Yes. Choose orders as the source, order value as the measure, brand as the breakdown and quarter as the period."],
    ["Can reports be scheduled or emailed?", "Not yet. Reports run when you open them, and you can export them as CSV or print them."],
    ["Do reports include the ledger?", "The report builder reads orders, leads, tickets, invoices, payments and visits. Ledger figures are on the finance dashboard and in the accounting statements."],
  ],
  related: ["/product/crm", "/product/accounting-gst", "/product/targets-incentives", "/product/ai-copilot", "/solutions/founders"],
  cta: { heading: "Ask the question nobody built a report for", body: "Set up a workspace and build your first breakdown in a minute. Every workspace starts with a {trialDays}-day free trial." },
});

export const RUN_PAGES: SeedPage[] = [accounting, purchases, inventory, expenses, assets, reports];

import { productByKey } from "../../src/lib/products";
import { productPage } from "./_build";
import type { SeedPage } from "./types";

/**
 * The "Advanced" column: Revenue & Close, the AI copilot, security and access, multi-branch GST,
 * linked workspaces, import and migration. Checked against src/lib/revenue/**, src/lib/close/**,
 * src/lib/copilot/**, src/lib/access/**, src/lib/security/**, src/lib/vault/**, src/lib/branches/**,
 * src/lib/platform/linked/**, src/lib/portability/** and their check scripts. Each page says what the
 * module does not do where a buyer would assume it (a contract model, consolidation, screenshots).
 */

const revenue = productPage({
  slug: "product/revenue-close",
  name: "Revenue & close",
  seo: {
    title: "Revenue recognition software and the close",
    description: "Revenue recognition software: deferred revenue recognised month by month, a revenue waterfall, prepaid and accrual schedules, and a month-end close.",
    keywords: ["revenue recognition software", "deferred revenue", "month-end close checklist"],
  },
  eyebrow: "Advanced",
  h1: "Revenue recognition software and a month-end close that checks itself",
  lead: "Revenue recognised as it is earned rather than when it is invoiced, prepaid and accrual schedules, and a month-end close checklist that ticks off what it can check, before the month is locked.",
  heroPreview: "invoice",
  answer: {
    question: "What is revenue recognition software?",
    answer:
      "Revenue recognition software is the system that moves money you have invoiced into revenue as you earn it. In {siteName}, an invoice line whose service runs past the month of issue waits in deferred revenue and moves into sales month by month, the way Ind AS 115 rules describe.",
    more: [
      "Each line is spread by day, or evenly by month, and every spread adds up to the paisa. A line that bills a project milestone is recognised in the month the milestone is delivered. Revenue for a month already closed is caught up in the first open month. A nightly run posts recognition as the workspace's Automation account, and a run can also be started by hand.",
    ],
  },
  features: {
    heading: "What Revenue & Close does",
    intro: `Revenue & Close is an add-on to ${productByKey("books")!.name}, included in ${productByKey("one")!.name}, and offered to companies in India.`,
    items: [
      { icon: "calendar", title: "Deferred revenue, month by month", body: "Subscriptions and services invoiced ahead wait in deferred revenue and move into sales as each month is delivered." },
      { icon: "chart", title: "A revenue waterfall", body: "What is still to be recognised, by customer or item, over the next 12 months or 24 months, with a roll-forward checked against the ledger." },
      { icon: "check", title: "A second person approves changes", body: "A schedule changed by hand goes back for approval by someone else with the revenue permission. The maker can't approve it." },
      { icon: "history", title: "Opening deferred revenue", body: "A wizard sets up schedules for service and subscription lines on the last 24 months of invoices, with one adjusting entry." },
      { icon: "layers", title: "Prepaids and accruals", body: "Schedules of one to sixty months: a prepaid amortised monthly, an accrual booked at month end and reversed on the first." },
      { icon: "lock", title: "Months closed in order", body: "Closing a month moves the books lock. Reopening one reopens every month after it, and a month in a closed year stays shut." },
    ],
  },
  how: [
    {
      heading: "How the month-end close checklist works",
      intro: "The month-end close checklist starts with fourteen tasks, due on the third working day of the next month, each with an owner.",
      body: [
        "Eleven of the tasks check themselves: bank accounts reconciled with no difference, no draft invoices, revenue recognised with none waiting for approval, prepaids and accruals posted, depreciation run, payroll posted, expense claims posted, receivables and payables ageing agreeing with the ledger, no delivered milestone left unbilled, and every flagged movement explained. A task ticked automatically is unticked if its check later fails.",
      ],
      bullets: ["Owners reminded before a task is due and when it is late", "Large movements flagged against last month and last year", "An open task blocks the close unless someone writes down why"],
    },
  ],
  faq: [
    ["We bill annual support upfront. Will it reach the P&L monthly?", "Yes. The invoice line is deferred and moves into revenue each month, spread by day or evenly by month, whichever the workspace is set to."],
    ["Is revenue recognition based on contracts?", "It follows each issued invoice line. There is no contract-level model: prices aren't re-allocated by standalone selling price, usage-based revenue isn't modelled, and unbilled revenue isn't booked. Your auditor decides whether that fits your contracts."],
    ["Can one person quietly change a schedule?", "No. A changed schedule goes back to pending until a different person with the revenue permission approves it, and a changed amount posts only after it is confirmed."],
    ["Can we close a month with tasks still open?", "Only with a written reason, and that override is recorded. Months close in order."],
  ],
  related: ["/product/accounting-gst", "/product/subscriptions-renewals", "/product/projects", "/solutions/saas-subscriptions", "/solutions/professional-services", "/solutions/finance-teams", "/blog/revenue-recognition-ind-as-115"],
  cta: { heading: "Recognise revenue as you earn it", body: "Revenue & Close is offered to companies in India. Book a demo to see your own deferred revenue and close checklist." },
});

const copilot = productPage({
  slug: "product/ai-copilot",
  name: "AI copilot",
  seo: {
    title: "AI copilot for your business data",
    description: "An AI copilot that answers questions about your own records, with charts and tables, using Anthropic, OpenAI or Google Gemini with your own API key.",
    keywords: ["AI copilot", "AI assistant for CRM", "bring your own AI key"],
  },
  eyebrow: "Advanced",
  h1: "An AI copilot that answers from your own records",
  lead: "Ask about your pipeline, customers, orders, renewals or tickets in plain language, and get the answer with a chart or a table. The copilot reads only what you are allowed to see, with the AI provider and key your company chooses.",
  heroPreview: "pipeline",
  answer: {
    question: "What is the AI copilot?",
    answer:
      "The AI copilot is an assistant inside {siteName} that answers questions about your company's records. It looks things up through the same actions the screens use, so it sees only what you can see, and it can draft a task or a note for you to save.",
    more: [
      "It can search companies, list leads, orders, renewals and tickets, read your tasks, summarise the dashboard, run a report and find a colleague. It shows results as a chart or a table in the conversation. It never changes a record on its own: a task or a note it drafts is saved only when you press the button, as you.",
    ],
  },
  features: {
    heading: "What the copilot can do",
    intro: "The copilot has thirteen tools, each reading records the way the app's own screens do.",
    items: [
      { icon: "bot", title: "Answers from your records", body: "Companies, leads, orders, renewals, tickets, tasks and the dashboard, looked up for you in plain language." },
      { icon: "chart", title: "Charts and tables", body: "Reports run on orders, leads, invoices, payments, tickets and visits, shown in the conversation." },
      { icon: "check", title: "Drafts, never changes", body: "The copilot drafts tasks and private notes as cards. Nothing is saved until you press Create or Save." },
      { icon: "key", title: "Bring your own AI key", body: "Anthropic's Claude, OpenAI's ChatGPT or Google's Gemini, with your company's own API key, encrypted with the workspace's key." },
      { icon: "gauge", title: "Limits you set", body: "A daily allowance for each person, a monthly allowance from your plan, and each person's use over the last 30 days." },
      { icon: "lock", title: "Private by design", body: "Conversations are private to their owner, and the copilot is switched off while an admin is viewing the app as someone else." },
    ],
  },
  how: [
    {
      heading: "How the AI assistant for CRM answers a question",
      intro: "An AI assistant for CRM is only safe if it can't see more than the person asking.",
      body: [
        "A salesperson asks which of their leads are likely to close this month. The copilot calls the tool that lists leads, through the same action the leads page uses, so it reads only that person's accounts. It answers with the leads and a short table, and offers to draft a follow-up task, which is created only when the salesperson presses the button.",
      ],
      bullets: ["Record text treated as data, never as instructions", "At most eight tool steps for each message", "Tools offered only for modules switched on for that person"],
      preview: "pipeline",
      side: "left",
    },
  ],
  faq: [
    ["Can a sales rep use it to see colleagues' accounts?", "No. The copilot runs as the person asking, through the same scoped actions the screens use, so it sees exactly what they can."],
    ["Which AI does it use?", "Whichever of Anthropic, OpenAI or Google Gemini your admin sets up, with your company's own API key. Without a key, the copilot is off."],
    ["Where does our data go?", "Only to the AI provider you configure, as part of each question. How that provider keeps or uses data is set by your agreement with them."],
    ["Can it send emails or change records?", "No. It can't change or delete records, export files or send messages. It drafts tasks and notes for you to save."],
  ],
  related: ["/product/reports", "/product/crm", "/product/security", "/solutions/founders", "/solutions/sales-teams"],
  cta: { heading: "Ask your data a question", body: "Set up a workspace, add your AI provider's key, and ask the copilot about your pipeline. Every workspace starts with a {trialDays}-day free trial." },
});

const security = productPage({
  slug: "product/security",
  name: "Security & access",
  seo: {
    title: "Role-based access control, DLP and a vault",
    description: "Role-based access control: custom roles, record-level scope, two-factor sign-in, Microsoft SSO, device and IP rules, DLP deterrents and a vault.",
    keywords: ["role-based access control", "data loss prevention", "credential vault"],
  },
  eyebrow: "Advanced",
  h1: "Role-based access control, sign-in rules and a credential vault",
  lead: "Roles and permissions you can change, record-level scope for sales teams, two-factor sign-in, single sign-on with Microsoft, device and network rules, data-loss deterrents, a credential vault and activity logs, in a workspace with its own database.",
  answer: {
    question: "What is role-based access control?",
    answer:
      "Role-based access control is the practice of granting permissions to roles, and roles to people, instead of to each person one by one. In {siteName}, each person has a role, individual grants or denials can override it, and managers inherit some permissions of the people who report to them.",
    more: [
      "Eight roles come built in, from admin to sales, support, accounts and purchase, and each can be renamed and changed. You can add your own. Record-level scope then decides which records a person sees: a salesperson sees the accounts they manage, a manager sees their team's, and a readable address such as a lead's number refuses anyone else.",
    ],
  },
  features: {
    heading: "What security and access cover",
    intro: "Security and access settings apply to every module in the workspace.",
    items: [
      { icon: "fingerprint", title: "Two-factor sign-in", body: "Authenticator-app codes, which an admin can require of everyone. Eight failed attempts in ten minutes lock the account for fifteen minutes." },
      { icon: "key", title: "Single sign-on with Microsoft", body: "Microsoft Entra ID sign-in for each workspace, with password sign-in switched off for all but admins if you choose." },
      { icon: "globe", title: "Device and network rules", body: "Per role: allow or refuse phones, tablets and computers, require device approval, and allow, alert, hold or block unknown networks and IP ranges." },
      { icon: "shield", title: "Data loss prevention", body: "Deterrents you switch on per role: a watermark with the viewer's name, copy and print blocking, an export row cap, and alerts on bulk reading." },
      { icon: "lock", title: "A credential vault", body: "The company's own logins, encrypted per workspace, opened with your own password, shared deliberately, with every reveal logged." },
      { icon: "scroll", title: "Activity and audit logs", body: "Sign-ins, exports, blocked events and permission denials, and every create, update and delete, with who was really at the keyboard." },
    ],
  },
  how: [
    {
      heading: "How support access works",
      intro: "Our support staff can't open your workspace unless your super admin lets them in.",
      steps: [
        "Your super admin grants access, read-only or admin, for between one and 72 hours, with a reason.",
        "The support person signs in under their own name, and never uses one of your seats.",
        "The grant is checked again on every request, and can be ended at any time.",
        "Every visit is recorded in your workspace's own activity log.",
      ],
    },
  ],
  faq: [
    ["Can you stop screenshots?", "No software can stop a phone camera. {siteName} counts screenshot attempts, logs them and can watermark screens with the viewer's name. The data-loss controls are deterrents, and we say so."],
    ["Can we allow access only from the office?", "Yes. Add the office's IP ranges as allowed for a role, and set unknown networks to block."],
    ["Which single sign-on providers are supported?", "Microsoft Entra ID. Google sign-in, SAML and automatic user provisioning aren't available, and two-factor sign-in uses authenticator apps."],
    ["Is our data kept apart from other companies'?", "Yes. Each workspace has its own database and database login, and its own encryption keys, sealed under a platform key."],
  ],
  related: ["/security", "/solutions/it-admins", "/product/linked-workspaces", "/product/import-migration", "/product/ai-copilot"],
  cta: { heading: "Set your access rules in the first week", body: "Book a demo, and we will walk your IT team through roles, sign-in rules and the logs." },
});

const multiBranch = productPage({
  slug: "product/multi-branch-gst",
  name: "Multi-branch GST",
  seo: {
    title: "Multi-GSTIN billing for branches",
    description: "Multi-GSTIN billing for companies with branches in several states: tax from the branch that supplies, numbering per GSTIN, and GSTR-1 and GSTR-3B for each.",
    keywords: ["multi-GSTIN billing", "branch-wise GST", "multiple GST registrations"],
  },
  eyebrow: "Advanced",
  h1: "Multi-GSTIN billing for every branch and state",
  lead: "Several GST registrations under one PAN, each branch with its own address, bank details and invoice series, tax worked out from the branch that supplies, and returns prepared for each GSTIN.",
  heroPreview: "invoice",
  answer: {
    question: "What is multi-GSTIN billing?",
    answer:
      "Multi-GSTIN billing is the invoicing a company does when it is registered for GST in more than one state, where each invoice must carry the right registration. In {siteName}, the branch on a document decides the seller's GSTIN, the tax and the number series.",
    more: [
      "Multiple GST registrations sit under the company's PAN. Each GSTIN's checksum is verified, and the PAN inside it must match the company's. Branches, whether an office, a shop, a factory or a warehouse, belong to a registration, and one of them is the head office. A branch can print its own address, bank details, UPI ID, logo, signature and invoice terms.",
    ],
  },
  features: {
    heading: "What branch-wise GST covers",
    intro: "Branch-wise GST starts from the branch, and everything after follows from it.",
    items: [
      { icon: "building", title: "Branches and registrations", body: "Offices, shops, factories and warehouses, each linked to a GSTIN, with one head office." },
      { icon: "rupee", title: "Tax from the branch", body: "The branch's state against the place of supply decides CGST and SGST or IGST. Conversions and credit notes keep the branch." },
      { icon: "file-text", title: "Numbering per GSTIN or branch", body: "Series with GSTIN, branch and financial-year tokens, kept within the sixteen characters an invoice number may have." },
      { icon: "scroll", title: "Returns per GSTIN", body: "Ledger lines tagged with the branch and GSTIN, and GSTR-1 and GSTR-3B prepared for each registration." },
      { icon: "truck", title: "E-invoice and e-way per GSTIN", body: "Each GSTIN has its own e-invoice and e-way bill credentials and its own intra-state e-way bill threshold." },
      { icon: "users", title: "A default branch per person", body: "Each person's branch fills in on their new documents, and the profit and loss can be read by branch." },
    ],
  },
  how: [
    {
      heading: "How a branch invoice is numbered and taxed",
      intro: "The branch on the document decides the seller, the tax and the number.",
      steps: [
        "A salesperson at the Bengaluru branch raises an invoice, and their branch fills in.",
        "The Karnataka GSTIN becomes the seller, and the place of supply decides the tax.",
        "The invoice takes the next number in the Bengaluru series for the financial year.",
        "It posts tagged with the branch and GSTIN, and appears in that GSTIN's GSTR-1.",
      ],
    },
  ],
  faq: [
    ["Can we have GSTINs in several states in one workspace?", "Yes, as long as they share the company's PAN. Each registration has its own branches, numbering and returns."],
    ["Does {siteName} file each GSTIN's returns?", "No. GSTR-1 and GSTR-3B are prepared for each registration, as reports to file from. You file them on the GST portal."],
    ["Can we see the balance sheet by branch?", "The profit and loss can be filtered by branch. The balance sheet and trial balance are for the whole company."],
    ["What about group companies with different PANs?", "Each PAN needs its own workspace. People who work across them can link their accounts and switch in one click."],
  ],
  related: ["/product/quotes-invoices", "/product/accounting-gst", "/product/linked-workspaces", "/solutions/multi-branch-enterprises", "/solutions/trading-distribution"],
  cta: { heading: "Bring every GSTIN into one workspace", body: "Book a demo, and we will set up your registrations, branches and number series with you." },
});

const linked = productPage({
  slug: "product/linked-workspaces",
  name: "Linked workspaces",
  seo: {
    title: "Multi-company access for group companies",
    description: "Multi-company access for group companies: each company keeps its own workspace, and people who work in several link their accounts and switch in one click.",
    keywords: ["multi-company access", "group companies", "switch between workspaces"],
  },
  eyebrow: "Advanced",
  h1: "Multi-company access for group companies, one click apart",
  lead: "Group companies each keep a workspace of their own, with their own database, keys and plan. People who work in several link their accounts once, and switch between them from the header.",
  answer: {
    question: "What are linked workspaces?",
    answer:
      "Linked workspaces are a person's own accounts in several {siteName} workspaces, joined so they can switch between them without signing in again. Multi-company access here means switching; each company's data stays in its own workspace.",
    more: [
      "A person can link up to twenty workspaces. The workspace being entered always decides: it checks the account again, and can ask for a two-factor code or a Microsoft sign-in. An account that can manage users or security is switched in only when it has two-factor sign-in on. Each switch is recorded as a sign-in in the workspace entered.",
    ],
  },
  features: {
    heading: "What linking controls",
    intro: "Each workspace's admins decide what linking may do in their workspace.",
    items: [
      { icon: "layers", title: "Switch between workspaces", body: "One click from the header takes a linked person into another group company's workspace." },
      { icon: "shield", title: "The entered workspace decides", body: "The entered workspace's own sign-in rules apply on every switch, including two-factor sign-in and Microsoft sign-in." },
      { icon: "users", title: "Admins in control", body: "Admins choose whether switching in is allowed, see which of their people are linked, and can remove one of their people from a link." },
      { icon: "lock", title: "Privacy between companies", body: "An admin sees whether their people are linked, never which other workspaces they are linked to." },
      { icon: "history", title: "Links that end themselves", body: "A deactivated account or a changed password ends the link, the person is told, and a nightly sweep catches anything else." },
      { icon: "mail", title: "Find my workspaces", body: "Anyone can ask the public sign-in page to email them a link to every workspace they belong to." },
    ],
  },
  how: [
    {
      heading: "How to link your group companies",
      intro: "Linking is done by each person, once, for the workspaces they belong to.",
      steps: [
        "Each group company has its own workspace, with its own plan, admins and data.",
        "An admin in each workspace allows switching in, in the security settings.",
        "A person who works in several signs in to one and links their account in another.",
        "From then on, the header's switcher takes them across in one click.",
      ],
    },
  ],
  faq: [
    ["Do linked workspaces share records or consolidate accounts?", "No. Each company's customers, documents and books stay in its own workspace. There are no consolidated reports or inter-company entries."],
    ["Can our admin see which other companies a person belongs to?", "No. An admin sees whether their people are linked, never to which other workspaces."],
    ["Does a 'view as' or support session carry across a switch?", "No. Each switch is a new sign-in in the workspace entered, by the person themselves."],
  ],
  related: ["/product/security", "/product/multi-branch-gst", "/solutions/multi-branch-enterprises", "/solutions/it-admins"],
  cta: { heading: "Run each group company in its own workspace", body: "Book a demo, and we will show you how group companies link their people." },
});

const importMigration = productPage({
  slug: "product/import-migration",
  name: "Import & migration",
  seo: {
    title: "Data migration: import from Excel and CSV",
    description: "Data migration into {siteName}: import companies, contacts, items and more from Excel or CSV with a preview, and export all your data.",
    keywords: ["data migration", "import from Excel", "export your data"],
  },
  eyebrow: "Advanced",
  h1: "Data migration from Excel and CSV, and every record out again",
  lead: "Import companies, contacts, items, vendors, people and more from Excel or CSV files, with a preview before anything is written. Export any of it, or the whole workspace, whenever you like.",
  answer: {
    question: "What does data migration into {siteName} cover?",
    answer:
      "Data migration is the move of your existing records into {siteName} from spreadsheets or another system's exports. Seventeen areas can be imported from Excel or CSV, including companies and customers, contacts, items, vendors, tickets, IT assets, people and the chart of accounts.",
    more: [
      "Each import starts with a template for its area and a preview of what will be created and what will be updated. Rows are matched on their natural keys, so importing the same file twice changes nothing, and importing a file you exported changes nothing either. Imports and exports each have their own permission for each area.",
    ],
  },
  features: {
    heading: "What import and export cover",
    intro: "Import from Excel or CSV area by area, and export the same way, or everything at once.",
    items: [
      { icon: "database", title: "Seventeen import areas", body: "Companies, customers, vendors, resellers and commission parties, contacts, items, tickets, suppressions, visits, IT assets, lists, expenses, the chart of accounts, people, candidates and users." },
      { icon: "file-text", title: "Import from Excel", body: "Excel or CSV files up to 5 MB, with a template for each area, and brands and families created as items arrive." },
      { icon: "check", title: "A preview first", body: "See what will be created and updated before anything is written. The import then reads the file again." },
      { icon: "history", title: "Safe to run twice", body: "Rows match on natural keys, so a second import of the same file changes nothing and creates no duplicates." },
      { icon: "scroll", title: "Export your data", body: "Every area as CSV or Excel, limited to what the person can see, and logged. One customer's records in one workbook." },
      { icon: "lock", title: "The whole workspace", body: "A sealed backup of the entire workspace, downloaded by someone with the backup permission." },
    ],
  },
  how: [
    {
      heading: "How to move from spreadsheets",
      intro: "Most companies move their lists first, then start transacting in {siteName}.",
      steps: [
        "Download the template for companies and fill it from your current list.",
        "Import it, read the preview, and commit it.",
        "Do the same for contacts, items and vendors.",
        "Enter opening balances as a journal, and start issuing new documents in {siteName}.",
      ],
    },
  ],
  faq: [
    ["Can we import past invoices, orders or payments?", "No. Transactions such as invoices, orders, payments and journal entries aren't imported; documents are made in {siteName} itself. Opening balances go in as a journal."],
    ["Can we import directly from Tally or Zoho?", "Not with a dedicated importer. Export your lists from the other system as Excel or CSV, and import them with the templates."],
    ["Can we take all our data with us if we leave?", "Yes. Export each area as CSV or Excel, and download a sealed backup of the whole workspace."],
    ["Will a second import create duplicates?", "No. Rows match on their natural keys, so re-importing the same file changes nothing."],
  ],
  related: ["/product/crm", "/product/inventory", "/product/security", "/solutions/small-business", "/solutions/growing-companies", "/solutions/it-admins"],
  cta: { heading: "Bring your lists across this week", body: "Set up a workspace and import your companies and contacts with a preview first. Every workspace starts with a {trialDays}-day free trial." },
});

export const ADVANCED_PAGES: SeedPage[] = [revenue, copilot, security, multiBranch, linked, importMigration];

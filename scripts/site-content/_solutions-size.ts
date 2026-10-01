import { solutionPage } from "./_build";
import type { SeedPage } from "./types";

/** Solutions by company size: small, growing, multi-branch. */

const small = solutionPage({
  slug: "solutions/small-business",
  name: "Small businesses",
  seo: {
    title: "ERP for small business in India",
    description: "ERP for small business in India: start with GST billing, a CRM and payments, and add accounting, payroll and support as you grow, in one workspace.",
    keywords: ["ERP for small business", "GST billing for small business", "small business CRM"],
  },
  eyebrow: "For small businesses",
  h1: "ERP for small business: start with billing, grow into the rest",
  lead: "Most small businesses start with three things: a list of customers, GST invoices and knowing who has paid. Start there, and switch on accounting, payroll and support in the same workspace when you need them.",
  heroPreview: "invoice",
  answer: {
    question: "Does a small business need an ERP?",
    answer:
      "An ERP for small business is one system for customers, invoices, payments and, later, the books and payroll. A small business doesn't need all of it on day one. It needs software it won't have to leave when it grows, and {siteName} lets you switch modules on one at a time.",
    more: [
      "GST billing for small business comes first. Add your items with their HSN or SAC codes and GST rates, and raise proposals and tax invoices with CGST and SGST or IGST worked out from the place of supply. Payments are recorded against invoices, so the receivables list always shows who owes you. When invoices and bills are flowing, switch on accounting, and they post to the ledger from then on.",
    ],
  },
  problems: {
    heading: "Small-business headaches, and what fixes them",
    intro: "Small businesses lose time to the same few jobs. Each of these is handled in the workspace you start with.",
    items: [
      { icon: "receipt", title: "Invoices made in a spreadsheet", body: "Numbered GST tax invoices from your item catalogue, with the tax worked out and a PDF sent from your own mailbox." },
      { icon: "rupee", title: "Not knowing who has paid", body: "Payments allocated to invoices, with ageing from each due date and a statement for every customer." },
      { icon: "users", title: "Customers in a phone and a notebook", body: "A small business CRM with every company, contact and lead, and every call and visit logged against them." },
      { icon: "database", title: "Moving from Excel", body: "Import customers, contacts and items from CSV or Excel files, with a preview before anything is written." },
    ],
  },
  modules: {
    heading: "Where small businesses start",
    intro: "Start with the first group; add the second when you are ready.",
    groups: [
      { title: "Day one", paths: ["/product/crm", "/product/quotes-invoices", "/product/payments-receivables"] },
      { title: "When you grow", paths: ["/product/accounting-gst", "/product/payroll", "/product/helpdesk"] },
    ],
  },
  workflow: {
    heading: "How to get started in an afternoon",
    intro: "A small business can issue its first GST invoice on the day it signs up.",
    body: [
      "Set up a workspace with your company's name and address. Import your customers and items from a spreadsheet, or add them as you go. Raise a proposal, convert it into a tax invoice when the customer agrees, and email the PDF. Record the payment when it arrives, and the invoice shows as paid. Everything you enter stays when you switch on more modules.",
    ],
    bullets: ["Numbering that resets each financial year", "CGST and SGST or IGST from the place of supply", "Customers, items and invoices kept when you add modules"],
    preview: "invoice",
  },
  faqHeading: "Questions small businesses ask",
  faq: [
    ["What does it cost?", "Plans are priced for your country, in the currency you pay in, and every workspace starts with a {trialDays}-day free trial without a card. See the pricing page for today's plans."],
    ["Can I start small and add modules later?", "Yes. Modules are switched on as you need them, and each one works with the records you already have."],
    ["Do I need an accountant to use it?", "Not to bill and track payments. When you switch on accounting, your accountant can work in the same workspace with their own sign-in and permissions."],
  ],
  related: ["/product/quotes-invoices", "/product/crm", "/pricing", "/solutions/growing-companies", "/solutions/founders", "/product"],
  cta: { heading: "Send your first GST invoice today", body: "Set up a workspace in a few minutes. Every workspace starts with a {trialDays}-day free trial, with no card needed to start." },
});

const growing = solutionPage({
  slug: "solutions/growing-companies",
  name: "Growing companies",
  seo: {
    title: "ERP for growing companies in India",
    description: "ERP for growing companies: approvals for documents, orders and expenses, roles and reporting lines, team targets, and books that close every month on time.",
    keywords: ["ERP for growing companies", "approval workflows", "roles and permissions"],
  },
  eyebrow: "For growing companies",
  h1: "ERP for growing companies that have outgrown spreadsheets",
  lead: "A growing company has more people, customers and transactions: approvals so the right person signs off, roles so people see what they should, targets for every team, and books that keep up.",
  answer: {
    question: "What changes when a company grows?",
    answer:
      "What changes is who decides. An ERP for growing companies is the system that moves decisions from one person's inbox into rules everyone can see. In {siteName}, approval workflows, roles and reporting lines decide who signs off on what, and every decision is recorded.",
    more: [
      "Approval workflows appear wherever money moves. A proposal or invoice above a value, or with a discount above a percentage you set, waits for an approver. An order's payment terms are approved by accounts. Expense claims go to the claimant's manager. A large marketing send needs a second person. Nobody approves their own, and the approver is named on the record.",
    ],
  },
  problems: {
    heading: "Growing pains, and how {siteName} handles them",
    intro: "Growing companies hit the same walls: too many people doing things one way, and too few seeing the whole.",
    items: [
      { icon: "check", title: "Every decision goes to the founder", body: "Approval rules for documents, orders, expenses and campaigns, decided by role, by name or by the maker's manager." },
      { icon: "users", title: "Everyone sees everything", body: "Roles and permissions, and record-level scope, so reps see their own accounts and managers see their team's." },
      { icon: "gauge", title: "Targets tracked in a sheet", body: "Targets for people, teams and the company, measured from the records, with pace against the time left." },
      { icon: "book", title: "Books a month behind", body: "Documents post to the ledger as they are issued, and the month-end close checklist ticks itself where it can." },
    ],
  },
  modules: {
    heading: "The modules growing companies add",
    intro: "Most growing companies already sell and bill; these are what they add next.",
    groups: [
      { title: "Control", paths: ["/product/security", "/product/accounting-gst", "/product/revenue-close"] },
      { title: "Scale the team", paths: ["/product/targets-incentives", "/product/hr", "/product/payroll", "/product/reports"] },
    ],
  },
  workflow: {
    heading: "How to set up approvals and roles",
    intro: "Set these once, and every new joiner inherits them.",
    steps: [
      "Set up departments and reporting lines, so managers see and approve for their teams.",
      "Adjust the built-in roles, or create your own, and give each person theirs.",
      "Add approval rules for proposals and invoices above a value or a discount.",
      "Set targets for the quarter, for each person and each team.",
      "Switch on the month-end close, and give each task an owner.",
    ],
  },
  faqHeading: "Questions growing companies ask",
  faq: [
    ["Can approvals have more than one level?", "Each approval is a single decision by a named approver, a role or the maker's manager. Different rules can apply to different document types and values."],
    ["Can we move from our current software without losing history?", "Customers, contacts, items, vendors and many other lists import from CSV or Excel. Past invoices, orders and payments aren't imported; opening balances go in as a journal."],
    ["Will it slow down as we add people?", "Each company has a database of its own, so another company's busy day doesn't slow yours."],
  ],
  related: ["/product/security", "/product/targets-incentives", "/solutions/small-business", "/solutions/multi-branch-enterprises", "/solutions/finance-teams"],
  cta: { heading: "Put your rules into the software", body: "Book a demo, and we will set up approvals and roles for your team with you." },
});

const multiBranch = solutionPage({
  slug: "solutions/multi-branch-enterprises",
  name: "Multi-branch companies",
  seo: {
    title: "Multi-branch ERP for Indian companies",
    description: "Multi-branch ERP for companies with several GSTINs: branch-wise numbering and tax, GSTR-1 per GSTIN, a P&L by branch, and linked workspaces for group companies.",
    keywords: ["multi-branch ERP", "multiple GSTIN software", "group company software"],
  },
  eyebrow: "For multi-branch companies",
  h1: "Multi-branch ERP for companies registered in several states",
  lead: "Every branch with its GSTIN, address, bank details and invoice series. Tax worked out from the branch that supplies, returns prepared for each GSTIN, a P&L by branch, and linked workspaces for group companies.",
  heroPreview: "invoice",
  answer: {
    question: "What does a multi-branch ERP have to handle?",
    answer:
      "A multi-branch ERP is one system for a company with offices, shops, factories or warehouses in several states, each with its own GSTIN. It has to charge the right tax from the right branch, number each branch's invoices separately, and prepare each GSTIN's returns.",
    more: [
      "Multiple GSTIN software in {siteName} starts with the registrations. Each GSTIN's checksum is verified, and the PAN inside it must match the company's. Branches hang off registrations, and one is the head office. A branch can carry its own address, bank details, UPI ID, logo, signature and invoice terms, and they print on its documents.",
    ],
  },
  problems: {
    heading: "Multi-state problems, and how {siteName} handles them",
    intro: "Each state registration adds rules. These are the ones that go wrong without a system that knows the branch.",
    items: [
      { icon: "rupee", title: "The wrong tax on inter-state sales", body: "The branch sets the seller's GSTIN and state, so CGST and SGST or IGST follow from the place of supply." },
      { icon: "file-text", title: "One number series for every branch", body: "Series per GSTIN or per branch, with financial-year tokens, kept within the sixteen characters an invoice number allows." },
      { icon: "scroll", title: "Returns split by hand", body: "GSTR-1 and GSTR-3B prepared for each registration, from ledger lines tagged with the branch and GSTIN." },
      { icon: "chart", title: "No view of each branch's profit", body: "The profit and loss can be filtered by branch, and each user's documents default to the branch they work at." },
    ],
  },
  modules: {
    heading: "The modules multi-branch companies use",
    intro: "Branches are part of the core; linked workspaces are for companies with more than one PAN.",
    groups: [
      { title: "Branches and GST", paths: ["/product/multi-branch-gst", "/product/quotes-invoices", "/product/accounting-gst"] },
      { title: "Group companies", paths: ["/product/linked-workspaces", "/product/security"] },
    ],
  },
  workflow: {
    heading: "How a branch invoice is taxed and numbered",
    intro: "The branch on the document decides the seller, the tax and the number.",
    body: [
      "A salesperson in the Pune office raises an invoice, and their branch is filled in. The Maharashtra GSTIN becomes the seller, the customer's place of supply decides between CGST and SGST or IGST, and the invoice takes the next number in the Pune series. It posts to the ledger tagged with the branch and GSTIN, and appears in that GSTIN's GSTR-1.",
    ],
    bullets: ["Branch letterhead, bank details and terms on the print", "E-invoice and e-way bill credentials per GSTIN", "The intra-state e-way bill threshold set per registration"],
    preview: "invoice",
    side: "left",
  },
  faqHeading: "Questions multi-branch companies ask",
  faq: [
    ["Can we keep companies with different PANs together?", "Each workspace has one PAN. Group company software here means a workspace for each company, and people who work across them link their accounts and switch in one click."],
    ["Are consolidated accounts available?", "No. Each company's books are in its own workspace; there are no consolidated reports or inter-company eliminations."],
    ["Can we see the balance sheet by branch?", "The profit and loss can be filtered by branch. The balance sheet and trial balance are for the whole company."],
  ],
  related: ["/product/multi-branch-gst", "/product/linked-workspaces", "/solutions/trading-distribution", "/solutions/finance-teams", "/solutions/it-admins"],
  cta: { heading: "Bring every branch into one workspace", body: "Book a demo, and we will set up your registrations, branches and number series with you." },
});

export const SIZE_PAGES: SeedPage[] = [small, growing, multiBranch];

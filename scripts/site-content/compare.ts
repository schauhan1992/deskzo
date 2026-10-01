import type { RichInline, RichNode, SiteBlock } from "../../src/components/site/blocks/types";
import type { SeedPage, SeedSection } from "./types";

/**
 * The comparison pages: /compare and one page per competitor the owner chose (decision W-D1) —
 * Zoho One, TallyPrime, Odoo, Salesforce, HubSpot and Freshworks. Published (W-D3).
 *
 * ## The rules these pages keep (the coordinator's safeguards)
 *
 *   · Every statement about another product comes from that vendor's own public website — its
 *     product, pricing, help and documentation pages — and the table links the page each row was read
 *     from (`source`), with the day it was read (`asOf`). Nothing from reviews, forums or summaries.
 *   · Never another vendor's prices: prices change and differ by region, so the pricing row names the
 *     pricing *model* and links the vendor's own pricing page.
 *   · Where a fact couldn't be confirmed on the vendor's site, the row is left out — or, rarely, where
 *     the absence itself matters to an Indian buyer, it says "Not stated on …'s website".
 *   · Every "{siteName}" cell is true of the code today (src/lib/modules.ts and the feature code), and
 *     "partial" where it is partial: professional tax has slabs for six states, projects have no
 *     timesheets, stock is one quantity per item, GST returns are prepared rather than filed.
 *   · No superlatives, and no claims about another product's security, reliability or support. Each
 *     page says where the other product may fit better — that is what keeps it fair.
 *   · A disclaimer under the table and at the foot of each page.
 *
 * Keywords are stored literally and the brand isn't chosen yet, so they carry the competitor's name
 * and never ours: "<X> alternative", "<X> alternative in India" and a third per page. "{siteName} vs <X>"
 * is in each page's title and table heading instead, where the token is filled.
 *
 * Research notes, row by row with the address and date of every source: the W3-COMPARE report.
 */

/** The day the competitors' websites were read. */
export const AS_OF = "2026-09-30";
const AS_OF_WORDS = "30 September 2026";

type Row = { feature: string; us: string; them: string; note?: string; source: string };
type Faq = { question: string; answer: string[] };
type Link = { label: string; href: string; description: string };

type Compare = {
  /** The last part of the address: /compare/<slug>. */
  slug: string;
  /** The product as the table and the text name it ("Zoho One", "TallyPrime"). */
  competitor: string;
  /** Its name in the CMS and in the breadcrumb. */
  navTitle: string;
  /** Whose website the facts come from, as the disclaimer says it ("Zoho's website (zoho.com)"). */
  website: string;
  /** "vs": the H1 is "{siteName} vs X"; "alternative": "A X alternative for Indian businesses". */
  h1: "vs" | "alternative";
  /** The name the H1 uses, when searchers use another than the product's ("Tally" for TallyPrime). */
  h1Name?: string;
  keywords: [string, string, string];
  seoTitle: string;
  seoDescription: string;
  /** Under the H1. */
  subheading: string;
  /** The answer-first summary: a question heading, then who each product fits. */
  summary: { heading: string; paragraphs: RichInline[] };
  tableIntro: string;
  rows: Row[];
  fits: { intro: RichInline; items: RichInline[] };
  theirs: { intro: RichInline; items: RichInline[] };
  switching: { answer: RichInline; steps: RichInline[]; after: RichInline[] };
  faq: Faq[];
  related: Link[];
  /** The trademark line at the foot of the page. */
  trademarks: string;
};

const withLink = (before: string, text: string, href: string, after = ""): RichInline => [{ text: before }, { text, href }, ...(after ? [{ text: after }] : [])];

/** The table's own disclaimer — the "Information about X … as of" line above it is the block's. */
const tableDisclaimer = (competitor: string) =>
  `Product names and trademarks belong to their owners. Features, plans and prices change: check ${competitor}'s own website for current details. We never quote another vendor's prices; the pricing row links to their pricing page.`;

function comparePage(c: Compare): SeedPage {
  const h1 = c.h1 === "vs" ? `{siteName} vs ${c.h1Name ?? c.competitor}` : `A ${c.h1Name ?? c.competitor} alternative for Indian businesses`;
  const blocks: SiteBlock[] = [
    {
      id: "compare-hero",
      type: "hero",
      props: {
        eyebrow: "Compare",
        heading: h1,
        subheading: c.subheading,
        primary: { kind: "signup" },
        secondary: { kind: "link", label: "See the comparison", href: "#compare" },
        note: "Free for {trialDays} days. No card needed to start.",
        noteInviteOnly: "Setting up a workspace is by invitation for now.",
      },
    },
    {
      id: "compare-summary",
      type: "richText",
      props: {
        anchor: "summary",
        content: [{ type: "heading", level: 2, text: c.summary.heading }, ...c.summary.paragraphs.map((text): RichNode => ({ type: "paragraph", text }))],
      },
    },
    {
      id: "compare-table",
      type: "comparisonTable",
      props: {
        anchor: "compare",
        eyebrow: "Comparison",
        heading: `${c.competitor} vs {siteName}, feature by feature`,
        intro: c.tableIntro,
        competitor: c.competitor,
        asOf: AS_OF,
        rows: c.rows,
        disclaimer: tableDisclaimer(c.competitor),
      },
    },
    {
      id: "compare-fit",
      type: "richText",
      props: {
        anchor: "fit",
        content: [
          { type: "heading", level: 2, text: "Where {siteName} fits" },
          { type: "paragraph", text: c.fits.intro },
          { type: "list", items: c.fits.items },
          { type: "heading", level: 2, text: `Where ${c.competitor} may fit better` },
          { type: "paragraph", text: c.theirs.intro },
          { type: "list", items: c.theirs.items },
        ],
      },
    },
    {
      id: "compare-switch",
      type: "richText",
      props: {
        anchor: "switching",
        content: [
          { type: "heading", level: 2, text: `How do you switch from ${c.competitor} to {siteName}?` },
          { type: "paragraph", text: c.switching.answer },
          { type: "list", ordered: true, items: c.switching.steps },
          ...c.switching.after.map((text): RichNode => ({ type: "paragraph", text })),
        ],
      },
    },
    { id: "compare-faq", type: "faq", props: { anchor: "faq", heading: `Questions about switching from ${c.competitor}`, items: c.faq } },
    { id: "compare-related", type: "relatedLinks", props: { heading: "Related pages", links: c.related } },
    {
      id: "compare-cta",
      type: "cta",
      props: {
        heading: `Try {siteName} beside ${c.competitor}`,
        body: "Set up a workspace, bring in a sample of your customers and items, and see how your own month would run. Free for {trialDays} days.",
        primary: { kind: "signup" },
        secondary: { kind: "link", label: "Book a demo", href: "/contact?topic=demo" },
        variant: "panel",
      },
    },
    {
      id: "compare-disclaimer",
      type: "richText",
      props: {
        content: [
          {
            type: "note",
            tone: "info",
            text: `Information about ${c.competitor} on this page is from ${c.website} as of ${AS_OF_WORDS}, and each row of the table links the page it was read from. ${c.trademarks} Check their website for current details.`,
          },
        ],
      },
    },
  ];
  return {
    slug: `compare/${c.slug}`,
    // The title names {siteName} already, so it stands without the site's " · {siteName}" template.
    document: { title: c.navTitle, seo: { title: c.seoTitle, absoluteTitle: true, description: c.seoDescription, keywords: c.keywords }, blocks },
  };
}

// ─── Shared: what {siteName} does (true of the code), switching, the common questions ──────────

/** src/lib/portability: CSV or Excel per area, a dry run before anything is written, natural-key matching. */
const importSteps = (first: RichInline, competitor: string): RichInline[] => [
  first,
  "Download {siteName}'s template for each area — companies, contacts, items, the chart of accounts, employees and more — and match your columns to it.",
  "Import companies before their contacts, then items, open tickets and the rest.",
  "Read the dry run: what each row would create or update, and why any row is refused. Then apply it. Running the same file again updates rather than duplicates.",
  `Enter your opening balances as a journal entry on the day you start, and keep ${competitor}'s exports as your archive.`,
];

/** Orders, renewals, payments and journal entries are export-only (src/lib/portability/areas.ts). */
const IMPORT_AFTER: RichInline[] = [
  withLink(
    "Orders, invoices, payments and journal entries aren't imported: in {siteName} each is the record of work that also posted to the ledger, so they start fresh from your opening balances. See ",
    "import and migration",
    "/product/import-migration",
    " for every area and format.",
  ),
];

const FAQ_TRIAL: Faq = {
  question: "Can I try {siteName} before I switch?",
  answer: ["Yes. Every workspace starts with a free trial of {trialDays} days, and no card is needed to start. Bring in a sample of your customers and items, and run a month's invoices through it."],
};
const FAQ_PRICING: Faq = {
  question: "Is {siteName} priced per user?",
  answer: ["Each plan says how many people it includes, and some plans are priced per person. Add-ons add modules, people or copilot use. The pricing page shows the plans for your country."],
};
const faqHistory = (competitor: string): Faq => ({
  question: `Will my invoices and payments from ${competitor} come across?`,
  answer: [
    `Not as live records. {siteName} doesn't import invoices, orders, payments or journal entries, because each one also posted to the ledger when it was made. Keep ${competitor}'s exports as your record, and start {siteName} from your opening balances.`,
  ],
});

const FIT_BOOKS: RichInline = "Sales, support and the books on one set of records: a GST invoice posts itself to the ledger, and each payment is applied against the invoices it settles.";
const FIT_GST: RichInline = withLink(
  "GST built in: CGST, SGST or IGST from the place of supply, e-invoices (IRN) and e-way bills through the government's portals, and GSTR-1 and GSTR-3B prepared for each GSTIN. See ",
  "quotes and invoices",
  "/product/quotes-invoices",
  ".",
);
const FIT_PEOPLE: RichInline = withLink("People in the same workspace: attendance, leave and payroll with PF, ESI and professional tax. See ", "payroll", "/product/payroll", ".");
const FIT_REVENUE: RichInline = withLink("Revenue recognised as it is earned (Ind AS 115), and a month-end close that checks itself, with the ", "Revenue & Close add-on", "/product/revenue-close", ".");
const FIT_BRANCHES: RichInline = withLink("Several GSTINs as branches of one company, with GST returns prepared for each. See ", "multi-branch GST", "/product/multi-branch-gst", ".");
const FIT_DATABASE: RichInline = withLink("Each company in a workspace and a database of its own. See ", "security", "/security", ".");
const FIT_COPILOT: RichInline = withLink("A copilot that answers from your data with the asking person's own permissions, on the AI provider and key you choose. See ", "the copilot", "/product/ai-copilot", ".");

const REL_HUB: Link = { label: "Every comparison", href: "/compare", description: "{siteName} beside Zoho One, TallyPrime, Odoo, Salesforce, HubSpot and Freshworks." };
const REL_IMPORT: Link = { label: "Import and migration", href: "/product/import-migration", description: "Bring your records in from spreadsheets, with a dry run before anything is written." };
const REL_ACCOUNTING: Link = { label: "Accounting and GST", href: "/product/accounting-gst", description: "The ledger, GST returns, TDS, banking and closing the books." };
const REL_INVOICES: Link = { label: "Quotes and invoices", href: "/product/quotes-invoices", description: "Proposals, GST tax invoices, e-invoices and e-way bills." };
const REL_CRM: Link = { label: "CRM", href: "/product/crm", description: "Companies, contacts, leads, calls and field visits." };
const REL_HELPDESK: Link = { label: "Helpdesk", href: "/product/helpdesk", description: "Tickets with priority, an SLA target and assignment." };
const REL_MARKETING: Link = { label: "Marketing", href: "/product/marketing", description: "Campaigns and journeys, every send checked against consent." };
const REL_PAYROLL: Link = { label: "Payroll", href: "/product/payroll", description: "Salary structures, the monthly run and payslips, with PF, ESI and professional tax." };
const REL_INVENTORY: Link = { label: "Inventory", href: "/product/inventory", description: "Goods, services and subscriptions, with stock tracked for goods." };
const REL_REVENUE: Link = { label: "Revenue and close", href: "/product/revenue-close", description: "Revenue recognised as it is earned, and a month-end close that checks itself." };
const REL_BRANCHES: Link = { label: "Multi-branch GST", href: "/product/multi-branch-gst", description: "Several GSTINs as branches of one company." };

// ─── HubSpot ─────────────────────────────────────────────────────────────────────────────────────

const HUBSPOT = comparePage({
  slug: "hubspot",
  competitor: "HubSpot",
  navTitle: "HubSpot",
  website: "HubSpot's website (hubspot.com)",
  h1: "alternative",
  keywords: ["HubSpot alternative", "HubSpot alternative in India", "compare HubSpot"],
  seoTitle: "HubSpot alternative: {siteName} vs HubSpot",
  seoDescription: "A HubSpot alternative for Indian companies: CRM, helpdesk and campaigns beside GST invoicing, accounting and payroll in one workspace.",
  subheading: "{siteName} keeps CRM, helpdesk and campaigns in one workspace with GST invoicing, the ledger and payroll. Compare HubSpot and {siteName} row by row, from HubSpot's own website.",
  summary: {
    heading: "Is {siteName} a HubSpot alternative for an Indian company?",
    paragraphs: [
      [
        { text: "{siteName} is a HubSpot alternative for companies that want their CRM and their books in one place. HubSpot is a customer platform with hubs for marketing, sales and service, and it " },
        { text: "syncs with accounting tools", href: "https://knowledge.hubspot.com/cpq/manage-end-to-end-revenue-in-hubspot" },
        { text: " such as QuickBooks, Xero and NetSuite. {siteName} keeps CRM, helpdesk and campaigns beside GST invoicing, accounting and payroll." },
      ],
      "If you are looking for a HubSpot alternative in India because your team also raises GST invoices, runs payroll and closes the books each month, {siteName} does that work in the same workspace as the CRM. If marketing is most of your work and your accounts already live elsewhere, HubSpot may fit better: see below.",
    ],
  },
  tableIntro: "What each product offers an Indian company: {siteName} from its own features, HubSpot from its public website. Each HubSpot row links the page it was read from.",
  rows: [
    {
      feature: "CRM: contacts, companies and a deal pipeline",
      us: "yes",
      them: "yes",
      note: "HubSpot: Smart CRM, with a free tier. {siteName}: companies, contacts and a lead pipeline from new to won, with calls and field visits.",
      source: "https://www.hubspot.com/products/crm",
    },
    {
      feature: "Email campaigns and automated journeys",
      us: "yes",
      them: "yes",
      note: "HubSpot: Marketing Hub. {siteName}: campaigns and triggered journeys, each send checked against consent and the suppression list first.",
      source: "https://www.hubspot.com/products/marketing/email",
    },
    {
      feature: "Help desk tickets",
      us: "yes",
      them: "yes",
      note: "HubSpot: Service Hub, with routing and prioritisation. {siteName}: tickets with priority, an SLA target and assignment.",
      source: "https://www.hubspot.com/products/service/help-desk",
    },
    {
      feature: "Shared inbox and knowledge base",
      us: "no",
      them: "yes",
      note: "HubSpot's help desk includes both. In {siteName}, your team logs each ticket; there is no shared inbox or knowledge base.",
      source: "https://www.hubspot.com/products/service/help-desk",
    },
    {
      feature: "Customer portal",
      us: "yes",
      them: "yes",
      note: "{siteName}'s portal shows each customer what they have, what they owe and their open tickets.",
      source: "https://www.hubspot.com/products/service/help-desk",
    },
    {
      feature: "Quotes",
      us: "yes",
      them: "yes",
      note: "HubSpot: in Revenue Hub, formerly Commerce Hub. {siteName}: proposals and proforma invoices.",
      source: "https://www.hubspot.com/products/revenue",
    },
    {
      feature: "Subscriptions and recurring billing",
      us: "partial",
      them: "yes",
      note: "HubSpot's Revenue Hub sends recurring billing. {siteName} tracks subscription terms, co-termed add-ons and renewals, and each invoice is raised by your team: there is no automatic recurring billing.",
      source: "https://www.hubspot.com/products/revenue",
    },
    {
      feature: "GST tax invoices (CGST, SGST, IGST)",
      us: "yes",
      them: "Not stated on HubSpot's website",
      note: "HubSpot's tax settings name US sales tax, Canada's GST and HST, and UK VAT. {siteName} works out CGST, SGST or IGST from the place of supply.",
      source: "https://knowledge.hubspot.com/payments/set-up-automated-tax-and-tax-rates",
    },
    {
      feature: "Accounting: ledger, bank reconciliation, statements",
      us: "yes",
      them: "Through accounting integrations",
      note: "HubSpot describes syncing its revenue data with accounting tools such as QuickBooks, Xero and NetSuite. {siteName} posts invoices, bills, payments and payroll to its own double-entry ledger.",
      source: "https://knowledge.hubspot.com/cpq/manage-end-to-end-revenue-in-hubspot",
    },
    {
      feature: "Payroll with PF, ESI and professional tax",
      us: "partial",
      them: "Not stated on HubSpot's website",
      note: "{siteName} computes PF and ESI, and professional tax for six states; income tax on salary is entered, not computed. HubSpot's page for HR teams talks of connecting existing payroll systems.",
      source: "https://www.hubspot.com/marketing-hub-for-human-resources",
    },
    {
      feature: "Projects",
      us: "partial",
      them: "yes",
      note: "HubSpot: a projects object to organise and track work. {siteName}: projects with milestones and billing stages, and no timesheets.",
      source: "https://knowledge.hubspot.com/records/understand-and-use-projects-object",
    },
    {
      feature: "Roles and permissions",
      us: "yes",
      them: "yes",
      note: "Both set what each person can see and change, and who may export.",
      source: "https://knowledge.hubspot.com/user-management/hubspot-user-permissions-guide",
    },
    {
      feature: "Data export",
      us: "yes",
      them: "yes",
      note: "HubSpot exports records as CSV, XLS or XLSX. {siteName} exports each area as CSV or Excel, and the whole workspace as one sealed backup file.",
      source: "https://knowledge.hubspot.com/import-and-export/export-records",
    },
    {
      feature: "Import from spreadsheets",
      us: "yes",
      them: "yes",
      note: "HubSpot imports CSV, XLSX and XLS files. {siteName} imports CSV and Excel files and shows a dry run of every change before writing it.",
      source: "https://knowledge.hubspot.com/import-and-export/set-up-your-import-file",
    },
    {
      feature: "AI assistant",
      us: "yes",
      them: "yes",
      note: "HubSpot: Breeze, whose agents use HubSpot Credits. {siteName}: a copilot that answers from your data with the person's own permissions, on the AI provider and key you choose.",
      source: "https://www.hubspot.com/products/artificial-intelligence",
    },
    {
      feature: "Pricing model",
      us: "Per plan; some plans per person",
      them: "Per seat, by hub and edition; free tools",
      note: "No prices here: they change and differ by country. See each vendor's pricing page.",
      source: "https://www.hubspot.com/pricing/sales",
    },
    {
      feature: "Where it runs",
      us: "Cloud, a database per company",
      them: "Cloud, in a web browser",
      note: "HubSpot also offers mobile apps for iOS and Android.",
      source: "https://www.hubspot.com/products/crm/mac-windows",
    },
  ],
  fits: {
    intro: "{siteName} suits a company that wants its customer work and its accounts on one set of records.",
    items: [FIT_BOOKS, FIT_GST, FIT_PEOPLE, FIT_REVENUE, FIT_DATABASE],
  },
  theirs: {
    intro: "HubSpot may suit you better if:",
    items: [
      withLink("you want to start with a free CRM: HubSpot offers ", "a free CRM with no expiry date", "https://www.hubspot.com/products/crm", ";"),
      withLink("marketing is most of your work: HubSpot's ", "email tools", "https://www.hubspot.com/products/marketing/email", " cover personalisation, A/B tests and follow-up automation;"),
      withLink("your support team answers from a shared inbox and a knowledge base, both part of ", "HubSpot's help desk", "https://www.hubspot.com/products/service/help-desk", ";"),
      withLink("you rely on many other apps: HubSpot says its CRM connects to ", "over 2,000 business apps", "https://www.hubspot.com/products/crm", ";"),
      withLink("your accounts already live in QuickBooks, Xero or NetSuite, which ", "HubSpot syncs with", "https://knowledge.hubspot.com/cpq/manage-end-to-end-revenue-in-hubspot", "."),
    ],
  },
  switching: {
    answer:
      "Export your HubSpot records as spreadsheets and import them into {siteName} one area at a time — companies, contacts, tickets and more. {siteName} shows every row it would create or update before anything is written, so you can check the result first.",
    steps: importSteps(
      withLink("Export from HubSpot: ", "contacts, companies, tickets and other records", "https://knowledge.hubspot.com/import-and-export/export-records", " download as CSV, XLS or XLSX files, from a link HubSpot emails you."),
      "HubSpot",
    ),
    after: IMPORT_AFTER,
  },
  faq: [
    {
      question: "Can I move my HubSpot contacts and companies to {siteName}?",
      answer: [
        "Yes. Export them from HubSpot as CSV or Excel files, then import them into {siteName}'s Companies and Contacts. You see a dry run of every row before anything is written, and running the file again updates rather than duplicates.",
      ],
    },
    faqHistory("HubSpot"),
    {
      question: "Can I use {siteName} and HubSpot together?",
      answer: ["{siteName} has no HubSpot integration, so the two wouldn't share records. You can run both side by side while you move, keeping the customer list in step with exports and imports."],
    },
    FAQ_TRIAL,
    FAQ_PRICING,
  ],
  related: [REL_CRM, REL_HELPDESK, REL_MARKETING, REL_ACCOUNTING, REL_IMPORT, REL_HUB],
  trademarks: "HubSpot and the names of its products are trademarks of their owner.",
});

// ─── Zoho One ────────────────────────────────────────────────────────────────────────────────────

const ZOHO_ONE = comparePage({
  slug: "zoho-one",
  competitor: "Zoho One",
  navTitle: "Zoho One",
  website: "Zoho's website (zoho.com)",
  h1: "alternative",
  keywords: ["Zoho One alternative", "Zoho One alternative in India", "compare Zoho One"],
  seoTitle: "Zoho One alternative: {siteName} vs Zoho One",
  seoDescription: "A Zoho One alternative for Indian companies: CRM, GST invoicing, accounting, payroll and helpdesk as modules of one workspace, compared row by row.",
  subheading: "{siteName} runs sales, GST invoicing, the books, payroll and support as modules of one workspace. Compare Zoho One and {siteName} row by row, from Zoho's own website.",
  summary: {
    heading: "Is {siteName} a Zoho One alternative for an Indian company?",
    paragraphs: [
      [
        { text: "{siteName} is a Zoho One alternative for companies that want one product rather than a suite of apps. " },
        { text: "Zoho One includes 45+ apps", href: "https://www.zoho.com/one/" },
        { text: " — Zoho Books, Zoho CRM, Zoho Desk, Zoho Payroll and more. {siteName} is one workspace whose modules share one set of records." },
      ],
      "If you are looking for a Zoho One alternative in India because you want CRM, GST invoicing, accounting, payroll and a helpdesk without moving between apps, {siteName} covers that ground in one place. If you need the breadth of Zoho's catalogue, deeper inventory or timesheets, Zoho One may fit better: see below.",
    ],
  },
  tableIntro: "What each offers an Indian company: {siteName} from its own features, Zoho One from the Zoho apps it includes, as Zoho's public website describes them. Each Zoho row links the page it was read from.",
  rows: [
    {
      feature: "GST tax invoices (CGST, SGST, IGST)",
      us: "yes",
      them: "yes",
      note: "Zoho: in Zoho Books. {siteName} works out CGST, SGST or IGST from the place of supply.",
      source: "https://www.zoho.com/in/books/help/settings/taxes.html",
    },
    {
      feature: "GST e-invoices (IRN and QR code)",
      us: "yes",
      them: "yes",
      note: "Zoho Books uploads invoices to the IRP. {siteName} generates the IRN through the NIC e-invoice API, with your own API credentials.",
      source: "https://www.zoho.com/in/books/e-invoicing/",
    },
    {
      feature: "E-way bills",
      us: "yes",
      them: "yes",
      note: "Both raise them from invoices, credit notes and delivery challans.",
      source: "https://www.zoho.com/in/books/help/e-way-bill/",
    },
    {
      feature: "Several GSTINs and branches",
      us: "yes",
      them: "yes",
      note: "Zoho Books links a GSTIN to each branch. {siteName} keeps each GSTIN on a branch, with GST returns prepared for each.",
      source: "https://www.zoho.com/in/books/help/branches/basic-functions.html",
    },
    {
      feature: "GST returns (GSTR-1 and GSTR-3B)",
      us: "partial",
      them: "yes",
      note: "Zoho Books can file GSTR-1 from inside it once API access is enabled on the GST portal. {siteName} prepares GSTR-1 and GSTR-3B for each GSTIN; you file them on the portal.",
      source: "https://www.zoho.com/in/books/help/gst/gstr1-filing.html",
    },
    {
      feature: "TDS on bills and invoices",
      us: "yes",
      them: "yes",
      note: "Zoho Books tracks TDS liabilities and challans. {siteName} records TDS deducted and withheld, with each month's total and its due date; the TDS return is filed outside it.",
      source: "https://www.zoho.com/in/books/help/tds/tds-liabilities.html",
    },
    {
      feature: "Payroll with PF, ESI and professional tax",
      us: "partial",
      them: "yes",
      note: "Zoho Payroll computes EPF, ESI, PT and LWF. {siteName} computes PF and ESI, and professional tax for six states; income tax on salary is entered, not computed.",
      source: "https://www.zoho.com/in/payroll/features/",
    },
    {
      feature: "Attendance and leave",
      us: "yes",
      them: "yes",
      note: "Zoho: in Zoho People. {siteName}: leave with balances and approvals, daily attendance and biometric devices.",
      source: "https://www.zoho.com/people/leave-management-system.html",
    },
    {
      feature: "CRM: leads, contacts and a pipeline",
      us: "yes",
      them: "yes",
      note: "Zoho: Zoho CRM. {siteName}: companies, contacts and a lead pipeline, with calls and field visits.",
      source: "https://www.zoho.com/crm/features.html",
    },
    {
      feature: "Helpdesk tickets",
      us: "yes",
      them: "yes",
      note: "Zoho: Zoho Desk, with routing by skills and workload. {siteName}: tickets with priority, an SLA target and assignment.",
      source: "https://www.zoho.com/desk/",
    },
    {
      feature: "Support conversations from every channel",
      us: "no",
      them: "yes",
      note: "Zoho Desk brings conversations from every channel into one workspace. In {siteName}, your team logs each ticket.",
      source: "https://www.zoho.com/desk/",
    },
    {
      feature: "Projects and timesheets",
      us: "partial",
      them: "yes",
      note: "Zoho Projects logs time on tasks, with timesheet approval. {siteName}: projects with milestones and billing stages, and no timesheets.",
      source: "https://www.zoho.com/projects/features.html",
    },
    {
      feature: "Inventory",
      us: "partial",
      them: "yes",
      note: "Zoho Inventory manages stock across warehouses. {siteName} keeps one stock quantity per item, with its movements.",
      source: "https://www.zoho.com/in/inventory/",
    },
    {
      feature: "Accounting: ledger, bank reconciliation, statements",
      us: "yes",
      them: "yes",
      note: "Zoho: Zoho Books. {siteName} posts invoices, bills, payments and payroll to its own double-entry ledger.",
      source: "https://www.zoho.com/in/books/help/banking/reconciliation.html",
    },
    {
      feature: "Revenue recognition",
      us: "yes",
      them: "In Zoho Billing, on some plans",
      note: "Zoho's help page for it names ASC 606 and IFRS 15. {siteName} recognises revenue as it is earned under Ind AS 115, with the Revenue & Close add-on.",
      source: "https://www.zoho.com/in/billing/help/settings/preferences/revenue-recognition.html",
    },
    {
      feature: "Subscriptions and recurring billing",
      us: "partial",
      them: "yes",
      note: "Zoho: Zoho Billing. {siteName} tracks subscription terms, co-termed add-ons and renewals, and each invoice is raised by your team: there is no automatic recurring billing.",
      source: "https://www.zoho.com/in/billing/",
    },
    {
      feature: "Fixed assets and depreciation",
      us: "yes",
      them: "yes",
      note: "Zoho: in Zoho Books. {siteName}: a fixed asset register with depreciation.",
      source: "https://www.zoho.com/in/books/help/accountant/fixed-assets.html",
    },
    {
      feature: "Email campaigns",
      us: "yes",
      them: "yes",
      note: "Zoho: Zoho Campaigns. {siteName}: campaigns and triggered journeys, each send checked against consent and the suppression list first.",
      source: "https://www.zoho.com/campaigns/",
    },
    {
      feature: "Roles and permissions",
      us: "yes",
      them: "yes",
      note: "Both set what each person can see and change.",
      source: "https://www.zoho.com/in/books/help/settings/users.html",
    },
    {
      feature: "Data export",
      us: "yes",
      them: "yes",
      note: "Zoho Books exports each module as CSV, XLS or XLSX. {siteName} exports each area as CSV or Excel, and the whole workspace as one sealed backup file.",
      source: "https://www.zoho.com/in/books/help/import-export/export.html",
    },
    {
      feature: "Import and migration",
      us: "yes",
      them: "yes",
      note: "Zoho Books imports CSV, TSV and XLS files, with guides for moving from other software. {siteName} imports CSV and Excel files and shows a dry run of every change first.",
      source: "https://www.zoho.com/in/books/help/migration/migrating-to-zoho-books-from-other-software.html",
    },
    {
      feature: "AI assistant",
      us: "yes",
      them: "yes",
      note: "Zoho: Zia, across its apps. {siteName}: a copilot that answers from your data with the person's own permissions, on the AI provider and key you choose.",
      source: "https://www.zoho.com/zia/",
    },
    {
      feature: "Pricing model",
      us: "Per plan; some plans per person",
      them: "Per user, or for all employees",
      note: "Zoho One is licensed per user, or for every employee on the payroll. No prices here: see each vendor's pricing page.",
      source: "https://www.zoho.com/one/pricing/",
    },
  ],
  fits: {
    intro: "{siteName} suits a company that wants its whole operation in one product.",
    items: [
      "One product rather than a suite: sales, support, the books and payroll are modules of one workspace, sharing one set of records.",
      FIT_BOOKS,
      FIT_REVENUE,
      FIT_DATABASE,
      FIT_COPILOT,
    ],
  },
  theirs: {
    intro: "Zoho One may suit you better if:",
    items: [
      withLink("you want a broad catalogue: ", "Zoho One includes 45+ apps", "https://www.zoho.com/one/", " across sales, marketing, service, finance, HR and operations;"),
      withLink("you need stock across warehouses, which ", "Zoho Inventory", "https://www.zoho.com/in/inventory/", " manages, or timesheets, which Zoho Projects keeps;"),
      withLink("you want to file GST returns from your accounting software: ", "Zoho Books files GSTR-1", "https://www.zoho.com/in/books/help/gst/gstr1-filing.html", " once API access is enabled on the GST portal;"),
      withLink("your payroll needs more statutory ground: ", "Zoho Payroll", "https://www.zoho.com/in/payroll/features/", " computes EPF, ESI, PT and LWF, and TDS for contractors;"),
      withLink("you want your data in India: Zoho lists ", "data centres in Mumbai and Chennai", "https://www.zoho.com/know-your-datacenter.html", ";"),
      withLink("your support team works across channels: ", "Zoho Desk", "https://www.zoho.com/desk/", " brings conversations from every channel into one workspace."),
    ],
  },
  switching: {
    answer:
      "Export each Zoho app's records as spreadsheets and import them into {siteName} one area at a time — customers and vendors, contacts, items, the chart of accounts, employees. {siteName} shows every row it would create or update before anything is written.",
    steps: importSteps(
      [
        { text: "Export from Zoho: " },
        { text: "Zoho Books exports each module", href: "https://www.zoho.com/in/books/help/import-export/export.html" },
        { text: " as CSV, XLS or XLSX, and " },
        { text: "Zoho CRM exports its modules", href: "https://help.zoho.com/portal/en/kb/crm/data-administration/export-data/articles/export-crm-data" },
        { text: " as CSV or XLSX." },
      ],
      "Zoho",
    ),
    after: IMPORT_AFTER,
  },
  faq: [
    {
      question: "Can I move from Zoho Books and Zoho CRM to {siteName}?",
      answer: [
        "Yes, as spreadsheets. Export customers, vendors, items and the chart of accounts from Zoho Books, and contacts and accounts from Zoho CRM, then import each into {siteName}. A dry run shows every row before anything is written.",
      ],
    },
    faqHistory("Zoho"),
    {
      question: "Can I keep some Zoho apps and use {siteName} for the rest?",
      answer: ["{siteName} has no Zoho integration, so records wouldn't sync between them. You can run both side by side while you move, keeping lists in step with exports and imports."],
    },
    FAQ_TRIAL,
    FAQ_PRICING,
  ],
  related: [REL_ACCOUNTING, REL_INVOICES, REL_PAYROLL, REL_CRM, REL_BRANCHES, REL_IMPORT, REL_HUB],
  trademarks: "Zoho, Zoho One and the names of Zoho's apps are trademarks of their owner.",
});

// ─── TallyPrime ──────────────────────────────────────────────────────────────────────────────────

const TALLY = comparePage({
  slug: "tally",
  competitor: "TallyPrime",
  navTitle: "TallyPrime",
  website: "Tally Solutions' website (tallysolutions.com)",
  h1: "alternative",
  h1Name: "Tally",
  keywords: ["Tally alternative", "Tally alternative in India", "compare Tally"],
  seoTitle: "Tally alternative: {siteName} vs TallyPrime",
  seoDescription: "A Tally alternative for Indian companies that want the books in a browser, beside CRM, helpdesk and payroll. {siteName} and TallyPrime compared row by row.",
  subheading: "{siteName} keeps GST invoicing and the books in a browser, beside CRM, helpdesk and payroll. Compare Tally and {siteName} row by row, from Tally's own website.",
  summary: {
    heading: "Is {siteName} a Tally alternative for your business?",
    paragraphs: [
      [
        { text: "{siteName} is a Tally alternative for companies that want their accounts in a browser, beside the rest of their work. TallyPrime is business management software for accounting, inventory, GST and payroll that " },
        { text: "runs on Windows computers, offline if needed", href: "https://tallysolutions.com/tally-prime-faq-guide/" },
        { text: ". {siteName} runs in the cloud." },
      ],
      "If you are looking for a Tally alternative in India because sales, support and the books live in separate places, {siteName} keeps them in one workspace. If offline work, deep inventory or a local Tally partner matters most, TallyPrime may fit better: see below. The two are built for different jobs, and the table shows where they meet.",
    ],
  },
  tableIntro: "What each offers an Indian company: {siteName} from its own features, TallyPrime from Tally Solutions' public website. Each TallyPrime row links the page it was read from.",
  rows: [
    {
      feature: "GST tax invoices (CGST, SGST, IGST)",
      us: "yes",
      them: "yes",
      note: "{siteName} works out CGST, SGST or IGST from the place of supply.",
      source: "https://tallysolutions.com/features/invoicing-and-accounting/",
    },
    {
      feature: "GST e-invoices (IRN and QR code)",
      us: "yes",
      them: "yes",
      note: "{siteName} generates the IRN through the NIC e-invoice API, with your own API credentials.",
      source: "https://help.tallysolutions.com/generate-irn-print-qr-code/",
    },
    {
      feature: "E-way bills",
      us: "yes",
      them: "yes",
      note: "{siteName} raises them from invoices, credit notes and delivery challans.",
      source: "https://tallysolutions.com/features/taxation/",
    },
    {
      feature: "Several GSTINs in one company",
      us: "yes",
      them: "yes",
      note: "TallyPrime manages several GST registrations in a single company. {siteName} keeps each GSTIN on a branch.",
      source: "https://tallysolutions.com/features/taxation/",
    },
    {
      feature: "GST returns (GSTR-1 and GSTR-3B)",
      us: "partial",
      them: "yes",
      note: "TallyPrime uploads GSTR-1 and GSTR-3B data and files returns from inside it. {siteName} prepares both for each GSTIN from your documents; you file them on the GST portal.",
      source: "https://tallysolutions.com/features/taxation/",
    },
    {
      feature: "TDS on bills and invoices",
      us: "yes",
      them: "yes",
      note: "TallyPrime manages TDS and TCS. {siteName} records TDS deducted and withheld, with each month's total and its due date; the TDS return is filed outside it.",
      source: "https://tallysolutions.com/features/taxation/",
    },
    {
      feature: "Payroll with PF, ESI and professional tax",
      us: "partial",
      them: "yes",
      note: "TallyPrime generates statutory reports for PF, ESI, professional tax, gratuity and income tax. {siteName} computes PF and ESI, and professional tax for six states; income tax on salary is entered, not computed.",
      source: "https://tallysolutions.com/features/payroll-management/",
    },
    {
      feature: "Attendance and leave",
      us: "yes",
      them: "Attendance types for payroll",
      note: "TallyPrime records attendance types such as present, sick leave and loss of pay for payroll. {siteName} adds leave balances and approvals, daily attendance and biometric devices.",
      source: "https://tallysolutions.com/features/payroll-management/",
    },
    {
      feature: "Inventory",
      us: "partial",
      them: "yes",
      note: "TallyPrime: batches with expiry dates, godowns, bills of materials and several valuation methods. {siteName}: one stock quantity per item, with its movements.",
      source: "https://tallysolutions.com/features/inventory-management/",
    },
    {
      feature: "Accounting: ledger, bank reconciliation, statements",
      us: "yes",
      them: "yes",
      note: "TallyPrime reconciles from imported bank statements. {siteName} matches a statement row only where exactly one entry fits, and leaves the rest to you.",
      source: "https://help.tallysolutions.com/auto-bank-reconciliation/",
    },
    {
      feature: "CRM: leads, contacts and a pipeline",
      us: "yes",
      them: "Through integrations",
      note: "Tally says TallyPrime integrates with CRMs and other apps through APIs. {siteName} has its own CRM: companies, contacts, leads, calls and field visits.",
      source: "https://tallysolutions.com/integration/",
    },
    {
      feature: "Roles and permissions",
      us: "yes",
      them: "yes",
      note: "TallyPrime sets access per feature: full access, create, alter, display. {siteName} sets permissions per role, and which accounts each person sees.",
      source: "https://help.tallysolutions.com/manage-users-in-tallyprime/",
    },
    {
      feature: "Data export",
      us: "yes",
      them: "yes",
      note: "TallyPrime exports to Excel, PDF, XML, JSON and more. {siteName} exports each area as CSV or Excel, and the whole workspace as one sealed backup file.",
      source: "https://help.tallysolutions.com/export-data-in-tally/",
    },
    {
      feature: "Import from spreadsheets",
      us: "yes",
      them: "yes",
      note: "TallyPrime imports Excel, XML or JSON, with mapping templates for several other products. {siteName} imports CSV and Excel files and shows a dry run of every change first.",
      source: "https://help.tallysolutions.com/import-data-in-tally/",
    },
    {
      feature: "AI assistant",
      us: "yes",
      them: "yes",
      note: "TallyPrime: Tally Ira reads invoices and prepares entries for review. {siteName}: a copilot that answers questions from your data, on the AI provider and key you choose.",
      source: "https://tallysolutions.com/tally-ira/",
    },
    {
      feature: "Pricing model",
      us: "Per plan; some plans per person",
      them: "Per edition: perpetual licence or rental",
      note: "TallyPrime Silver is for one user and Gold for several on a local network; a licence comes with a year of Tally Software Services. No prices here: see each vendor's pricing page.",
      source: "https://help.tallysolutions.com/licensing-tallyprime/",
    },
    {
      feature: "Where it runs",
      us: "Cloud, in a web browser",
      them: "Windows desktop, offline if needed",
      note: "Tally also offers TallyPrime Cloud Access, a hosted option.",
      source: "https://tallysolutions.com/tally-prime-faq-guide/",
    },
  ],
  fits: {
    intro: "{siteName} suits a company that wants its accounts in a browser, beside the rest of its work.",
    items: [
      withLink("CRM, quotes, a helpdesk and campaigns in the same workspace as the books, on one set of records. See ", "CRM", "/product/crm", "."),
      "Work from any browser: each company has its own web address and a database of its own.",
      "Leave with balances and approvals, daily attendance and biometric devices, feeding the payroll run.",
      FIT_REVENUE,
      FIT_COPILOT,
    ],
  },
  theirs: {
    intro: "TallyPrime may suit you better if:",
    items: [
      withLink("you need to work offline: ", "TallyPrime's desktop edition", "https://tallysolutions.com/tally-prime-faq-guide/", " runs accounting, invoicing and inventory without an internet connection;"),
      withLink("you want to file GST returns from inside your accounting software: TallyPrime ", "uploads GSTR-1 and GSTR-3B data", "https://tallysolutions.com/features/taxation/", " and files returns directly;"),
      withLink("you need deeper inventory: ", "batches with expiry dates, godowns, bills of materials", "https://tallysolutions.com/features/inventory-management/", " and several stock valuation methods;"),
      withLink("your payroll needs statutory forms: TallyPrime ", "generates statutory reports", "https://tallysolutions.com/features/payroll-management/", " for PF, ESI, professional tax, gratuity and income tax;"),
      withLink("you want a local partner: Tally lists ", "certified partners", "https://tallysolutions.com/partners/", " who implement, support and extend TallyPrime."),
    ],
  },
  switching: {
    answer:
      "Export your masters from TallyPrime to Excel and import them into {siteName} one area at a time — ledgers into the chart of accounts, stock items into items, parties into customers and vendors. {siteName} shows every row it would create or update before anything is written.",
    steps: importSteps(
      withLink(
        "Export from TallyPrime: take a backup of the company, then export ",
        "masters, vouchers and reports",
        "https://help.tallysolutions.com/export-data-in-tally/",
        " to Excel, XML or JSON. Tally's export can write closing balances as opening balances.",
      ),
      "TallyPrime",
    ),
    after: IMPORT_AFTER,
  },
  faq: [
    {
      question: "Does {siteName} work offline like TallyPrime?",
      answer: ["No. {siteName} runs in a web browser and needs an internet connection. TallyPrime's desktop edition works offline; if that matters most to you, it may be the better fit."],
    },
    {
      question: "Can I bring my Tally ledgers and stock items into {siteName}?",
      answer: [
        "Yes, as spreadsheets. Export the masters from TallyPrime to Excel, then import ledgers into {siteName}'s chart of accounts, stock items into items, and parties into customers and vendors. A dry run shows every row before anything is written.",
      ],
    },
    faqHistory("TallyPrime"),
    {
      question: "Can my accountant work in {siteName}?",
      answer: ["Yes. Invite them as a user and give them a role that opens the accounts. They sign in from a browser, wherever they work."],
    },
    FAQ_TRIAL,
  ],
  related: [REL_ACCOUNTING, REL_INVOICES, REL_PAYROLL, REL_INVENTORY, REL_CRM, REL_IMPORT, REL_HUB],
  trademarks: "Tally, TallyPrime and related names are trademarks of their owner.",
});

// ─── Odoo ────────────────────────────────────────────────────────────────────────────────────────

const ODOO = comparePage({
  slug: "odoo",
  competitor: "Odoo",
  navTitle: "Odoo",
  website: "Odoo's website (odoo.com)",
  h1: "alternative",
  keywords: ["Odoo alternative", "Odoo alternative in India", "compare Odoo"],
  seoTitle: "Odoo alternative: {siteName} vs Odoo",
  seoDescription: "An Odoo alternative for Indian companies: GST invoicing, accounting, payroll, CRM and helpdesk in one hosted workspace. {siteName} and Odoo compared row by row.",
  subheading: "{siteName} is one hosted workspace for GST invoicing, the books, payroll, CRM and support. Compare Odoo and {siteName} row by row, from Odoo's own website and documentation.",
  summary: {
    heading: "Is {siteName} an Odoo alternative for an Indian company?",
    paragraphs: [
      [
        { text: "{siteName} is an Odoo alternative for companies that want a hosted workspace with India's GST, payroll and books ready to use. Odoo is a suite of business apps with an " },
        { text: "India localisation", href: "https://www.odoo.com/documentation/19.0/applications/finance/fiscal_localizations/india.html" },
        { text: ", which you can use online or host yourself." },
      ],
      "If you are looking for an Odoo alternative in India because you want one set of modules run for you, {siteName} is that. If you want open-source software, your own servers, or the widest choice of apps and customisation, Odoo may fit better: see below.",
    ],
  },
  tableIntro: "What each offers an Indian company: {siteName} from its own features, Odoo from its public website and documentation. Each Odoo row links the page it was read from.",
  rows: [
    {
      feature: "GST tax invoices (CGST, SGST, IGST)",
      us: "yes",
      them: "yes",
      note: "Odoo: through its India localisation. {siteName} works out CGST, SGST or IGST from the place of supply.",
      source: "https://www.odoo.com/documentation/19.0/applications/finance/fiscal_localizations/india.html",
    },
    {
      feature: "GST e-invoices (IRN and QR code)",
      us: "yes",
      them: "yes",
      note: "Odoo prints the IRN, acknowledgement and QR code on the invoice. {siteName} generates the IRN through the NIC e-invoice API, with your own API credentials.",
      source: "https://www.odoo.com/documentation/19.0/applications/finance/fiscal_localizations/india.html",
    },
    {
      feature: "E-way bills",
      us: "yes",
      them: "yes",
      note: "Odoo raises them from invoices and bills, and from deliveries. {siteName} raises them from invoices, credit notes and delivery challans.",
      source: "https://www.odoo.com/documentation/19.0/applications/finance/fiscal_localizations/india.html",
    },
    {
      feature: "GST returns (GSTR-1 and GSTR-3B)",
      us: "partial",
      them: "yes",
      note: "Odoo submits GSTR-1 to the GST portal and has a GSTR-3B report. {siteName} prepares both for each GSTIN from your documents; you file them on the portal.",
      source: "https://www.odoo.com/documentation/19.0/applications/finance/fiscal_localizations/india.html",
    },
    {
      feature: "TDS on bills and invoices",
      us: "yes",
      them: "yes",
      note: "Odoo applies TDS and TCS, with an alert when a threshold is passed. {siteName} records TDS deducted and withheld, with each month's total and its due date; the return is filed outside it.",
      source: "https://www.odoo.com/documentation/19.0/applications/finance/fiscal_localizations/india.html",
    },
    {
      feature: "Payroll with PF, ESI and professional tax",
      us: "partial",
      them: "yes",
      note: "Odoo's India payroll covers EPF, ESIC, professional tax and the Labour Welfare Fund. {siteName} computes PF and ESI, and professional tax for six states; income tax on salary is entered, not computed.",
      source: "https://www.odoo.com/documentation/19.0/applications/hr/payroll/payroll_localizations/india.html",
    },
    {
      feature: "Attendance and leave",
      us: "yes",
      them: "yes",
      note: "Odoo: its Time Off app, for leave requests, allocations and approvals. {siteName}: leave with balances and approvals, daily attendance and biometric devices.",
      source: "https://www.odoo.com/app/time-off",
    },
    {
      feature: "CRM: leads, contacts and a pipeline",
      us: "yes",
      them: "yes",
      note: "Odoo: its CRM app. {siteName}: companies, contacts and a lead pipeline, with calls and field visits.",
      source: "https://www.odoo.com/app/crm",
    },
    {
      feature: "Helpdesk tickets",
      us: "yes",
      them: "yes",
      note: "Odoo: its Helpdesk app, with SLA rules. {siteName}: tickets with priority, an SLA target and assignment.",
      source: "https://www.odoo.com/app/helpdesk",
    },
    {
      feature: "Tickets created from incoming email",
      us: "no",
      them: "yes",
      note: "Odoo's Helpdesk turns new emails into tickets. In {siteName}, your team logs each ticket.",
      source: "https://www.odoo.com/app/helpdesk",
    },
    {
      feature: "Projects and timesheets",
      us: "partial",
      them: "yes",
      note: "Odoo can bill customers for time spent on tasks. {siteName}: projects with milestones and billing stages, and no timesheets.",
      source: "https://www.odoo.com/app/project",
    },
    {
      feature: "Inventory",
      us: "partial",
      them: "yes",
      note: "Odoo tracks stock across several warehouses. {siteName} keeps one stock quantity per item, with its movements.",
      source: "https://www.odoo.com/app/inventory",
    },
    {
      feature: "Accounting: ledger, bank reconciliation, statements",
      us: "yes",
      them: "yes",
      note: "Both keep a double-entry ledger. {siteName} posts invoices, bills, payments and payroll to it as they are recorded.",
      source: "https://www.odoo.com/documentation/19.0/applications/finance/accounting.html",
    },
    {
      feature: "Deferred revenue",
      us: "yes",
      them: "yes",
      note: "Odoo defers an invoice line between its start and end dates. {siteName} recognises revenue as it is earned under Ind AS 115, with the Revenue & Close add-on.",
      source: "https://www.odoo.com/documentation/19.0/applications/finance/accounting/customer_invoices/deferred_revenues.html",
    },
    {
      feature: "Subscriptions and recurring billing",
      us: "partial",
      them: "yes",
      note: "Odoo: its Subscriptions app. {siteName} tracks subscription terms, co-termed add-ons and renewals, and each invoice is raised by your team: there is no automatic recurring billing.",
      source: "https://www.odoo.com/app/subscriptions",
    },
    {
      feature: "Fixed assets and depreciation",
      us: "yes",
      them: "yes",
      note: "Both keep an asset register with depreciation entries.",
      source: "https://www.odoo.com/documentation/19.0/applications/finance/accounting/vendor_bills/assets.html",
    },
    {
      feature: "Email campaigns",
      us: "yes",
      them: "yes",
      note: "Odoo: its Email Marketing app. {siteName}: campaigns and triggered journeys, each send checked against consent and the suppression list first.",
      source: "https://www.odoo.com/app/email-marketing",
    },
    {
      feature: "Roles and permissions",
      us: "yes",
      them: "yes",
      note: "Both set what each person can see and change.",
      source: "https://www.odoo.com/documentation/19.0/applications/general/users/access_rights.html",
    },
    {
      feature: "Data export and import",
      us: "yes",
      them: "yes",
      note: "Odoo exports any list as CSV or XLS and imports CSV or XLSX. {siteName} exports each area as CSV or Excel, and imports them with a dry run of every change first.",
      source: "https://www.odoo.com/documentation/19.0/applications/essentials/export_import_data.html",
    },
    {
      feature: "AI assistant",
      us: "yes",
      them: "yes",
      note: "Odoo: AI agents that answer questions and complete tasks inside its apps. {siteName}: a copilot that answers from your data with the person's own permissions, on the AI provider and key you choose.",
      source: "https://www.odoo.com/app/artificial-intelligence",
    },
    {
      feature: "Pricing model",
      us: "Per plan; some plans per person",
      them: "Per user, all apps; one app free",
      note: "No prices here: they change and differ by country. See each vendor's pricing page.",
      source: "https://www.odoo.com/pricing",
    },
    {
      feature: "Where it runs",
      us: "Cloud, a database per company",
      them: "Odoo Online, Odoo.sh or your own servers",
      note: "Odoo's on-premise option is open to both its Community and Enterprise editions.",
      source: "https://www.odoo.com/page/hosting-types",
    },
  ],
  fits: {
    intro: "{siteName} suits a company that wants India's rules ready in a workspace someone else runs.",
    items: [
      "Hosted for you: each company in a workspace and a database of its own, nothing to install or upgrade.",
      FIT_BOOKS,
      FIT_GST,
      FIT_REVENUE,
      FIT_COPILOT,
    ],
  },
  theirs: {
    intro: "Odoo may suit you better if:",
    items: [
      withLink("you want open-source software: Odoo's ", "Community edition is open source and free", "https://www.odoo.com/", ";"),
      withLink("you want to host it yourself, or add your own code: Odoo runs ", "online, on Odoo.sh or on your own servers", "https://www.odoo.com/page/hosting-types", ";"),
      withLink("you want a wide choice of add-ons: Odoo speaks of ", "40k+ community apps", "https://www.odoo.com/", ";"),
      withLink("you need stock across several warehouses, which ", "Odoo Inventory", "https://www.odoo.com/app/inventory", " tracks, or billing from timesheets;"),
      withLink("your support team takes tickets by email, forms and live chat, which ", "Odoo Helpdesk", "https://www.odoo.com/app/helpdesk", " handles."),
    ],
  },
  switching: {
    answer:
      "Export your Odoo records as spreadsheets and import them into {siteName} one area at a time — customers and vendors, contacts, items, the chart of accounts, employees. {siteName} shows every row it would create or update before anything is written.",
    steps: importSteps(
      withLink("Export from Odoo: ", "any list in any Odoo app", "https://www.odoo.com/documentation/19.0/applications/essentials/export_import_data.html", " exports to CSV or XLS, with the fields you choose."),
      "Odoo",
    ),
    after: IMPORT_AFTER,
  },
  faq: [
    {
      question: "Can I move my Odoo contacts, products and chart of accounts to {siteName}?",
      answer: [
        "Yes, as spreadsheets. Export each list from Odoo as CSV or XLS, then import it into the matching area in {siteName} — contacts, items, the chart of accounts. A dry run shows every row before anything is written.",
      ],
    },
    faqHistory("Odoo"),
    {
      question: "Can I host {siteName} on my own servers, as I can Odoo?",
      answer: ["No. {siteName} is hosted: each company gets a workspace and a database of its own, run for it. If running it on your own servers matters, Odoo may fit better."],
    },
    FAQ_TRIAL,
    FAQ_PRICING,
  ],
  related: [REL_ACCOUNTING, REL_INVOICES, REL_PAYROLL, REL_HELPDESK, REL_REVENUE, REL_IMPORT, REL_HUB],
  trademarks: "Odoo and the names of its apps are trademarks of their owner.",
});

// ─── Salesforce ──────────────────────────────────────────────────────────────────────────────────

const SALESFORCE = comparePage({
  slug: "salesforce",
  competitor: "Salesforce",
  navTitle: "Salesforce",
  website: "Salesforce's website (salesforce.com)",
  h1: "alternative",
  keywords: ["Salesforce alternative", "Salesforce alternative in India", "compare Salesforce"],
  seoTitle: "Salesforce alternative: {siteName} vs Salesforce",
  seoDescription: "A Salesforce alternative for Indian companies: CRM and support beside GST invoicing, accounting and payroll in one workspace, compared row by row.",
  subheading: "{siteName} keeps CRM and support beside GST invoicing, the books and payroll. Compare Salesforce and {siteName} row by row, from Salesforce's own website.",
  summary: {
    heading: "Is {siteName} a Salesforce alternative for an Indian company?",
    paragraphs: [
      [
        { text: "{siteName} is a Salesforce alternative for companies that want CRM and their books in one workspace. Salesforce is a CRM platform for sales, service and marketing; for GST, it says its CRM " },
        { text: "can be customised and integrated with ERP and accounting applications", href: "https://www.salesforce.com/in/crm/" },
        { text: ". {siteName} does GST invoicing and accounting itself." },
      ],
      "If you are looking for a Salesforce alternative in India because your sales team and your accounts team work from different systems, {siteName} puts them on one set of records. If you need a platform to build your own apps on, industry solutions, or a large partner marketplace, Salesforce may fit better: see below.",
    ],
  },
  tableIntro: "What each offers an Indian company: {siteName} from its own features, Salesforce from its public website. Each Salesforce row links the page it was read from.",
  rows: [
    {
      feature: "CRM: leads, contacts and a pipeline",
      us: "yes",
      them: "yes",
      note: "Salesforce: Sales Cloud. {siteName}: companies, contacts and a lead pipeline, with calls and field visits.",
      source: "https://www.salesforce.com/in/sales/",
    },
    {
      feature: "Customer service cases",
      us: "yes",
      them: "yes",
      note: "Salesforce: Service Cloud. {siteName}: tickets with priority, an SLA target and assignment.",
      source: "https://www.salesforce.com/in/service/",
    },
    {
      feature: "Contact centre across channels, and a knowledge base",
      us: "no",
      them: "yes",
      note: "Service Cloud describes an omni-channel contact centre and a knowledge library. In {siteName}, your team logs each ticket; there is no knowledge base.",
      source: "https://www.salesforce.com/in/service/",
    },
    {
      feature: "Email campaigns and journeys",
      us: "yes",
      them: "yes",
      note: "Salesforce: Agentforce Marketing, formerly Marketing Cloud. {siteName}: campaigns and triggered journeys, each send checked against consent first.",
      source: "https://www.salesforce.com/in/marketing/",
    },
    {
      feature: "Subscriptions and renewals",
      us: "partial",
      them: "yes",
      note: "Salesforce: Agentforce Revenue Management. {siteName} tracks subscription terms, co-termed add-ons and renewals; there is no automatic recurring billing.",
      source: "https://www.salesforce.com/in/sales/revenue-lifecycle-management/",
    },
    {
      feature: "GST tax invoices, e-invoices and e-way bills",
      us: "yes",
      them: "Through customisation and integration",
      note: "Salesforce says its CRM can be customised and integrated with ERP and accounting applications to support GST. {siteName} raises GST invoices, e-invoices and e-way bills itself.",
      source: "https://www.salesforce.com/in/crm/",
    },
    {
      feature: "Accounting: ledger, bank reconciliation, statements",
      us: "yes",
      them: "Billing data passed to an ERP",
      note: "Salesforce Billing passes invoice lines, payments and adjustments to an ERP system. {siteName} posts invoices, bills, payments and payroll to its own double-entry ledger.",
      source: "https://help.salesforce.com/s/articleView?id=sales.blng_align_org_accounting_erp.htm&language=en_US&type=5",
    },
    {
      feature: "Revenue recognition",
      us: "yes",
      them: "Completed in an ERP",
      note: "Salesforce's help says Billing's revenue data goes to an ERP to complete revenue recognition. {siteName} recognises revenue under Ind AS 115 in its own ledger, with the Revenue & Close add-on.",
      source: "https://help.salesforce.com/s/articleView?id=sales.blng_align_org_accounting_erp.htm&language=en_US&type=5",
    },
    {
      feature: "Payroll with PF, ESI and professional tax",
      us: "partial",
      them: "Not stated on Salesforce's website",
      note: "Salesforce's HR Service connects to systems such as Workday, SAP and ADP. {siteName} computes PF and ESI, and professional tax for six states; income tax on salary is entered, not computed.",
      source: "https://www.salesforce.com/in/service/hr-service-management/",
    },
    {
      feature: "Roles and permissions",
      us: "yes",
      them: "yes",
      note: "Salesforce adds a role hierarchy and field-level access. {siteName} sets permissions per role, and which accounts each person sees.",
      source: "https://trailhead.salesforce.com/content/learn/modules/data_security/data_security_overview",
    },
    {
      feature: "Data export",
      us: "yes",
      them: "yes",
      note: "Salesforce's Data Export Service sends a zip of CSV files. {siteName} exports each area as CSV or Excel, and the whole workspace as one sealed backup file.",
      source: "https://trailhead.salesforce.com/content/learn/modules/lex_implementation_data_management/lex_implementation_data_export",
    },
    {
      feature: "Import from spreadsheets",
      us: "yes",
      them: "yes",
      note: "Salesforce: the Data Import Wizard and Data Loader, from CSV files. {siteName} imports CSV and Excel files and shows a dry run of every change first.",
      source: "https://trailhead.salesforce.com/content/learn/modules/lex_implementation_data_management/lex_implementation_data_import",
    },
    {
      feature: "AI assistant",
      us: "yes",
      them: "yes",
      note: "Salesforce: Agentforce, for building AI agents. {siteName}: a copilot that answers from your data with the person's own permissions, on the AI provider and key you choose.",
      source: "https://www.salesforce.com/in/agentforce/",
    },
    {
      feature: "Pricing model",
      us: "Per plan; some plans per person",
      them: "Per user per month, by edition",
      note: "No prices here: they change and differ by country. See each vendor's pricing page.",
      source: "https://www.salesforce.com/in/sales/pricing/",
    },
  ],
  fits: {
    intro: "{siteName} suits a company that wants its CRM and its books to be one system.",
    items: [FIT_BOOKS, FIT_GST, FIT_PEOPLE, FIT_REVENUE, FIT_BRANCHES],
  },
  theirs: {
    intro: "Salesforce may suit you better if:",
    items: [
      withLink("you want a platform to build on: Salesforce's ", "App Builder", "https://www.salesforce.com/in/platform/low-code-development-platform/", " creates applications with little or no code;"),
      withLink("you want apps from partners: ", "AgentExchange", "https://www.salesforce.com/in/crm/", " is Salesforce's marketplace of partner-built apps;"),
      withLink("your service team runs a contact centre: Service Cloud describes ", "every channel on one platform", "https://www.salesforce.com/in/service/", ";"),
      withLink("your industry has its own needs: Salesforce lists ", "industry solutions", "https://www.salesforce.com/in/solutions/industries/", " for sectors such as financial services and manufacturing;"),
      withLink("your accounts already run in an ERP that ", "Salesforce Billing passes data to", "https://help.salesforce.com/s/articleView?id=sales.blng_align_org_accounting_erp.htm&language=en_US&type=5", "."),
    ],
  },
  switching: {
    answer:
      "Export your Salesforce data as CSV files and import them into {siteName} one area at a time — accounts as companies, contacts, cases as tickets. {siteName} shows every row it would create or update before anything is written.",
    steps: importSteps(
      withLink("Export from Salesforce: the ", "Data Export Service", "https://trailhead.salesforce.com/content/learn/modules/lex_implementation_data_management/lex_implementation_data_export", " sends your data as a zip of CSV files."),
      "Salesforce",
    ),
    after: IMPORT_AFTER,
  },
  faq: [
    {
      question: "Can I move my Salesforce accounts and contacts to {siteName}?",
      answer: [
        "Yes. Export them from Salesforce as CSV files, then import accounts into {siteName}'s Companies and contacts into Contacts. A dry run shows every row before anything is written, and running the file again updates rather than duplicates.",
      ],
    },
    faqHistory("Salesforce"),
    {
      question: "Can I use {siteName} and Salesforce together?",
      answer: ["{siteName} has no Salesforce integration, so the two wouldn't share records. You can run both side by side while you move, keeping the customer list in step with exports and imports."],
    },
    FAQ_TRIAL,
    FAQ_PRICING,
  ],
  related: [REL_CRM, REL_HELPDESK, REL_ACCOUNTING, REL_INVOICES, REL_REVENUE, REL_IMPORT, REL_HUB],
  trademarks: "Salesforce, Agentforce and the names of Salesforce's products are trademarks of their owner.",
});

// ─── Freshworks ──────────────────────────────────────────────────────────────────────────────────

const FRESHWORKS = comparePage({
  slug: "freshworks",
  competitor: "Freshworks",
  navTitle: "Freshworks",
  website: "Freshworks' websites (freshworks.com and its help centres)",
  h1: "alternative",
  keywords: ["Freshworks alternative", "Freshworks alternative in India", "compare Freshworks"],
  seoTitle: "Freshworks alternative: {siteName} vs Freshworks",
  seoDescription: "A Freshworks alternative for Indian companies: CRM and support tickets beside GST invoicing, accounting and payroll in one workspace, compared row by row.",
  subheading: "{siteName} keeps CRM and support tickets beside GST invoicing, the books and payroll. Compare Freshworks and {siteName} row by row, from Freshworks' own websites.",
  summary: {
    heading: "Is {siteName} a Freshworks alternative for an Indian company?",
    paragraphs: [
      [
        { text: "{siteName} is a Freshworks alternative for companies that want CRM, support and their books in one workspace. Freshworks makes Freshsales for CRM and Freshdesk for customer service; for accounting, Freshsales " },
        { text: "shows QuickBooks invoices beside a contact", href: "https://crmsupport.freshworks.com/support/solutions/articles/50000002459-how-to-integrate-quickbooks-" },
        { text: ". {siteName} raises GST invoices and keeps the ledger itself." },
      ],
      "If you are looking for a Freshworks alternative in India because sales, support and accounts sit in separate tools, {siteName} puts them on one set of records. If your support team works across email, chat, phone and messaging, or you run IT service management, Freshworks may fit better: see below.",
    ],
  },
  tableIntro: "What each offers an Indian company: {siteName} from its own features, Freshworks from its public websites. Each Freshworks row links the page it was read from.",
  rows: [
    {
      feature: "CRM: leads, contacts and a pipeline",
      us: "yes",
      them: "yes",
      note: "Freshworks: Freshsales. {siteName}: companies, contacts and a lead pipeline, with calls and field visits.",
      source: "https://www.freshworks.com/crm/sales/",
    },
    {
      feature: "Help desk tickets",
      us: "yes",
      them: "yes",
      note: "Freshworks: Freshdesk. {siteName}: tickets with priority, an SLA target and assignment.",
      source: "https://www.freshworks.com/freshdesk/pricing/",
    },
    {
      feature: "Support across email, chat, phone and messaging",
      us: "no",
      them: "yes",
      note: "Freshdesk Omni unifies these channels. In {siteName}, your team logs each ticket.",
      source: "https://www.freshworks.com/freshdesk/omni/",
    },
    {
      feature: "Email campaigns and journeys",
      us: "yes",
      them: "yes",
      note: "Freshworks: Freshmarketer and Freshsales Suite. {siteName}: campaigns and triggered journeys, each send checked against consent first.",
      source: "https://www.freshworks.com/crm/marketing/",
    },
    {
      feature: "Quotes",
      us: "yes",
      them: "yes",
      note: "Freshworks: the CPQ add-on for Freshsales. {siteName}: proposals and proforma invoices.",
      source: "https://www.freshworks.com/cpq/software/",
    },
    {
      feature: "GST tax invoices (CGST, SGST, IGST)",
      us: "yes",
      them: "Not stated on Freshworks' website",
      note: "Freshworks' CPQ page speaks of applicable taxes for the region, not GST. {siteName} works out CGST, SGST or IGST from the place of supply, with e-invoices and e-way bills.",
      source: "https://www.freshworks.com/cpq/software/",
    },
    {
      feature: "Accounting: ledger, bank reconciliation, statements",
      us: "yes",
      them: "Through integrations",
      note: "Freshsales' QuickBooks integration shows invoices and payment status beside a contact. {siteName} posts invoices, bills, payments and payroll to its own double-entry ledger.",
      source: "https://crmsupport.freshworks.com/support/solutions/articles/50000002459-how-to-integrate-quickbooks-",
    },
    {
      feature: "Projects",
      us: "partial",
      them: "IT projects, in Freshservice",
      note: "Freshservice has IT project management with time logged on tasks. {siteName}: projects with milestones and billing stages, and no timesheets.",
      source: "https://www.freshworks.com/freshservice/features/it-project-management-software/",
    },
    {
      feature: "IT asset tracking",
      us: "yes",
      them: "yes",
      note: "Freshworks: Freshservice. {siteName}: every machine and licence, with custody, warranty and AMC cover.",
      source: "https://www.freshworks.com/freshservice/it-asset-management/",
    },
    {
      feature: "Roles and permissions",
      us: "yes",
      them: "yes",
      note: "Both set what each person can see and change.",
      source: "https://crmsupport.freshworks.com/support/solutions/articles/50000002412-how-to-configure-roles-and-manage-user-permissions-in-freshworks-crm-",
    },
    {
      feature: "Data export",
      us: "yes",
      them: "yes",
      note: "Freshsales sends a full export as a zip file by email. {siteName} exports each area as CSV or Excel, and the whole workspace as one sealed backup file.",
      source: "https://crmsupport.freshworks.com/support/solutions/articles/50000004927-how-do-i-export-all-required-data-from-the-crm-",
    },
    {
      feature: "Import from spreadsheets",
      us: "yes",
      them: "yes",
      note: "Freshsales imports CSV or XLSX files. {siteName} imports CSV and Excel files and shows a dry run of every change first.",
      source: "https://crmsupport.freshworks.com/support/solutions/articles/50000002586-how-to-import-records-contacts-accounts-deals-from-a-csv-xlsx-file-",
    },
    {
      feature: "AI assistant",
      us: "yes",
      them: "yes",
      note: "Freshworks: Freddy AI. {siteName}: a copilot that answers from your data with the person's own permissions, on the AI provider and key you choose.",
      source: "https://www.freshworks.com/freshdesk/omni/freddy-ai-copilot/",
    },
    {
      feature: "Pricing model",
      us: "Per plan; some plans per person",
      them: "Per user or per agent, by plan",
      note: "Freshsales is priced per user, Freshdesk per agent. No prices here: see each vendor's pricing page.",
      source: "https://www.freshworks.com/crm/pricing/",
    },
    {
      feature: "Where it runs",
      us: "Cloud, a database per company",
      them: "Cloud, with mobile apps",
      note: "Freshdesk says it is cloud software, not an on-premise download.",
      source: "https://support.freshdesk.com/support/solutions/articles/234655-can-i-download-freshdesk-",
    },
  ],
  fits: {
    intro: "{siteName} suits a company that wants its customer work and its accounts on one set of records.",
    items: [FIT_BOOKS, FIT_GST, FIT_PEOPLE, FIT_REVENUE, FIT_DATABASE],
  },
  theirs: {
    intro: "Freshworks may suit you better if:",
    items: [
      withLink("your support team works across channels: ", "Freshdesk Omni", "https://www.freshworks.com/freshdesk/omni/", " unifies email, chat, phone and messaging;"),
      withLink("you run IT service management, or service desks for HR and finance teams, in ", "Freshservice", "https://www.freshworks.com/freshservice/business-teams/", ";"),
      withLink("you rely on many other apps: Freshworks speaks of ", "over 1,200 apps", "https://www.freshworks.com/platform/integrations/", " to extend it, and low-code tools to connect them;"),
      withLink("you want to choose where your data lives: Freshworks lists ", "five data centre regions, India among them", "https://support.freshdesk.com/support/solutions/articles/235810-where-is-your-data-servers-located-", ";"),
      withLink("your accounts already live in QuickBooks, which ", "Freshsales can show beside a contact", "https://crmsupport.freshworks.com/support/solutions/articles/50000002459-how-to-integrate-quickbooks-", "."),
    ],
  },
  switching: {
    answer:
      "Export your Freshsales and Freshdesk records as spreadsheets and import them into {siteName} one area at a time — accounts as companies, contacts, tickets. {siteName} shows every row it would create or update before anything is written.",
    steps: importSteps(
      [
        { text: "Export from Freshworks: " },
        { text: "Freshsales sends a full export", href: "https://crmsupport.freshworks.com/support/solutions/articles/50000004927-how-do-i-export-all-required-data-from-the-crm-" },
        { text: " as a zip file by email, and " },
        { text: "Freshdesk exports tickets", href: "https://support.freshdesk.com/support/solutions/articles/225158-how-do-i-export-my-tickets-from-freshdesk-" },
        { text: " as CSV or Excel." },
      ],
      "Freshworks",
    ),
    after: IMPORT_AFTER,
  },
  faq: [
    {
      question: "Can I move my Freshsales contacts and accounts to {siteName}?",
      answer: [
        "Yes. Export them from Freshsales, then import accounts into {siteName}'s Companies and contacts into Contacts, as CSV or Excel files. A dry run shows every row before anything is written, and running the file again updates rather than duplicates.",
      ],
    },
    {
      question: "Can I bring my Freshdesk tickets?",
      answer: ["Yes. Export tickets from Freshdesk as CSV or Excel and import them into {siteName}'s Tickets, each linked to its company. The dry run shows any row it can't place, and why."],
    },
    faqHistory("Freshworks"),
    FAQ_TRIAL,
    FAQ_PRICING,
  ],
  related: [REL_CRM, REL_HELPDESK, REL_MARKETING, REL_ACCOUNTING, REL_IMPORT, REL_HUB],
  trademarks: "Freshworks, Freshsales, Freshdesk, Freshservice and Freddy are trademarks of their owner.",
});

// ─── The hub: /compare ───────────────────────────────────────────────────────────────────────────

const HUB: SeedPage = {
  slug: "compare",
  document: {
    // The breadcrumb's word for the level above each comparison.
    title: "Compare",
    seo: {
      title: "Compare business software for Indian companies",
      description: "Compare business software for India: {siteName} beside Zoho One, TallyPrime, Odoo, Salesforce, HubSpot and Freshworks, from each vendor's own website.",
      keywords: ["compare business software", "business software for Indian companies", "Zoho One and Tally alternatives"],
    },
    blocks: [
      {
        id: "compare-header",
        type: "pageHeader",
        props: {
          eyebrow: "Compare",
          heading: "Compare business software for Indian companies",
          intro:
            "Compare business software the way a company registered for GST in India uses it: {siteName} beside Zoho One, TallyPrime, Odoo, Salesforce, HubSpot and Freshworks. Every statement about another product is read from its vendor's own website and linked to the page it came from.",
        },
      },
      {
        id: "compare-map",
        type: "moduleHighlights",
        props: {
          anchor: "comparisons",
          heading: "Every comparison",
          intro: "Zoho One and Tally alternatives, and CRMs such as Salesforce, HubSpot and Freshworks: each page sets the two products side by side on GST, payroll, CRM, support, the books and switching, and says where the other may fit better.",
          groups: [
            {
              title: "Business suites and ERP",
              items: [
                { label: "{siteName} vs Zoho One", href: "/compare/zoho-one", description: "Zoho's suite of business apps beside one workspace: GST, payroll, CRM, helpdesk and the books compared." },
                { label: "{siteName} vs Odoo", href: "/compare/odoo", description: "Odoo's apps and its India localisation beside {siteName}: GST, e-invoicing, payroll, projects and hosting compared." },
              ],
            },
            {
              title: "Accounting",
              items: [
                { label: "{siteName} vs TallyPrime", href: "/compare/tally", description: "Desktop accounting beside a browser workspace: GST, TDS, inventory and payroll, and what each adds around the books." },
              ],
            },
            {
              title: "CRM and customer service",
              items: [
                { label: "{siteName} vs Salesforce", href: "/compare/salesforce", description: "A CRM platform beside a workspace that also keeps the books: sales, service, GST invoicing and payroll compared." },
                { label: "{siteName} vs HubSpot", href: "/compare/hubspot", description: "HubSpot's hubs beside {siteName}'s modules: CRM, marketing, helpdesk, invoices and what sits behind them." },
                { label: "{siteName} vs Freshworks", href: "/compare/freshworks", description: "Freshsales and Freshdesk beside {siteName}: CRM, support tickets, GST billing, accounting and payroll compared." },
              ],
            },
          ],
        },
      },
      {
        id: "compare-choose",
        type: "richText",
        props: {
          anchor: "how-to-choose",
          content: [
            { type: "heading", level: 2, text: "How do you compare business software for an Indian company?" },
            {
              type: "paragraph",
              text: "Start from the work your team does every month — invoices under GST, payroll, collections, support — and check where each product does it: in the product itself, in a separate app, or through a partner. Then check how your data gets in and out.",
            },
            { type: "heading", level: 3, text: "Questions to ask of any product" },
            {
              type: "list",
              items: [
                "Does it raise GST e-invoices and e-way bills itself, and prepare GSTR-1 and GSTR-3B for each GSTIN you hold?",
                "Do sales, invoices and the ledger share one set of records, or are they separate apps kept in step?",
                "Does payroll compute PF, ESI and professional tax for the states your people work in?",
                "Who can see what: roles, permissions, and what a person may export?",
                "Is it priced per user, per organisation or per app, and which modules does each plan include?",
                "How do you bring your data in — and take all of it out again?",
              ],
            },
            { type: "heading", level: 2, text: "How these comparisons are made" },
            {
              type: "paragraph",
              text: "We read each vendor's own public website — product pages, help centres and documentation — on 30 September 2026. Every row about another product links the page it came from, so you can check it. Where a fact couldn't be confirmed there, the row is left out, or says the vendor's website doesn't state it.",
            },
            {
              type: "list",
              items: [
                "No prices: they change and differ by region, so each comparison links the vendor's own pricing page instead.",
                "{siteName}'s answers are what the product does today, marked partly where it is partial.",
                "Each page says where the other product may fit better.",
              ],
            },
            {
              type: "paragraph",
              text: withLink("Moving from any of them? Read how ", "import and migration", "/product/import-migration", " work in {siteName}, or see the plans on the pricing page."),
            },
          ],
        },
      },
      {
        id: "compare-hub-cta",
        type: "cta",
        props: {
          heading: "See it with your own data",
          body: "Set up a workspace and try {siteName} free for {trialDays} days, or book a demo and we will walk you through the modules that matter to you.",
          primary: { kind: "signup" },
          secondary: { kind: "link", label: "Book a demo", href: "/contact?topic=demo" },
          variant: "panel",
        },
      },
      {
        id: "compare-hub-disclaimer",
        type: "richText",
        props: {
          content: [
            {
              type: "note",
              tone: "info",
              text: `Information about other products on these pages is from their vendors' public websites as of ${AS_OF_WORDS}. Product names and trademarks belong to their owners. Check each vendor's website for current details.`,
            },
          ],
        },
      },
    ],
  },
};

// ─── The section ─────────────────────────────────────────────────────────────────────────────────

export const comparePages: SeedPage[] = [HUB, ZOHO_ONE, TALLY, ODOO, SALESFORCE, HUBSPOT, FRESHWORKS];

export const section: SeedSection = { name: "Compare", pages: comparePages };

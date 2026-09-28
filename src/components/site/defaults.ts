import type { SitePage, SiteSettings } from "@/components/site/blocks/types";
import { MODULE_REGISTRY } from "@/lib/modules";

/**
 * The public website's default content: the site-wide settings and every page, as blocks.
 *
 * This is the one place to edit the site's words until the platform console's CMS takes over; after
 * that it is what the site falls back to for anything not yet published there
 * (src/lib/platform/site-content.ts). Shapes: ./blocks/types.ts.
 *
 * ## Placeholders, on purpose
 *
 * The domain, the tagline and the sales address are not decided yet, so they are obvious
 * placeholders set once, below — "yourdomain.com", "Your tagline goes here", "sales@yourdomain.com" —
 * and the text uses them as tokens ({displayDomain}, {tagline}, {salesEmail}). Links never use the
 * display domain: they are built from PLATFORM_DOMAIN when the page is served.
 *
 * ## What the words may claim
 *
 * Only what the product does today: the modules are src/lib/modules.ts; the security and privacy
 * statements are docs/privacy (drafts for counsel) and docs/runbook.md. No customer logos,
 * testimonials, user counts or ratings — the logoCloud and testimonial blocks exist for when there
 * are real ones, and are not used here.
 */

export const DEFAULT_SITE_SETTINGS: SiteSettings = {
  siteName: "Wroffy ERP",
  tagline: "Your tagline goes here",
  displayDomain: "yourdomain.com",
  salesEmail: "sales@yourdomain.com",
  nav: [
    { label: "Product", href: "/#modules" },
    { label: "Pricing", href: "/pricing" },
    { label: "Security", href: "/security" },
    { label: "Contact", href: "/contact" },
  ],
  signinLink: { label: "Sign in", href: "/signin" },
  signupCta: {
    open: { label: "Start free trial", href: "/signup" },
    inviteOnly: { label: "Request an invitation", href: "/contact?topic=sales" },
  },
  footer: {
    columns: [
      {
        title: "Product",
        links: [
          { label: "Modules", href: "/#modules" },
          { label: "Built for India", href: "/#india" },
          { label: "Pricing", href: "/pricing" },
          { label: "Security", href: "/security" },
        ],
      },
      {
        title: "Get started",
        links: [
          { label: "Set up a workspace", href: "/signup" },
          { label: "Sign in", href: "/signin" },
          { label: "Find my workspaces", href: "/signin#find" },
          { label: "Book a demo", href: "/contact?topic=demo" },
        ],
      },
      {
        title: "Legal",
        links: [
          { label: "Privacy", href: "/privacy" },
          { label: "Terms", href: "/terms" },
          { label: "Sub-processors", href: "/security#subprocessors" },
          { label: "Contact", href: "/contact" },
        ],
      },
    ],
    note: "{tagline}",
  },
  social: [],
  seo: {
    titleTemplate: "%s · {siteName}",
    defaultTitle: "{siteName}",
    description: "CRM, quotes and GST invoices, accounting, HR and payroll, inventory and support in one workspace — each company on a database of its own.",
  },
  notFound: {
    heading: "We couldn't find that page",
    body: "The address may be mistyped, or the page may have moved.",
    links: [
      { label: "Home", href: "/" },
      { label: "Pricing", href: "/pricing" },
      { label: "Sign in", href: "/signin" },
      { label: "Contact", href: "/contact" },
    ],
  },
};

// ─── Shared between pages ────────────────────────────────────────────────────────────────────────

const SECURITY_ITEMS = [
  {
    icon: "database" as const,
    title: "A database for each company",
    body: "Every workspace has a database of its own, with its own database login. No other workspace's login can open it.",
  },
  {
    icon: "key" as const,
    title: "Keys of its own",
    body: "A workspace's stored secrets — mail passwords, API keys, vault entries — are encrypted with keys unique to it, sealed under a platform key kept outside the database.",
  },
  {
    icon: "fingerprint" as const,
    title: "Two-factor sign-in",
    body: "Authenticator codes, which a workspace can require of everybody, and Microsoft single sign-on.",
  },
  {
    icon: "users" as const,
    title: "Roles and permissions",
    body: "Roles with the permissions you choose, and rules for the devices and networks each person may sign in from.",
  },
  {
    icon: "scroll" as const,
    title: "Activity and audit logs",
    body: "Sign-ins, exports and changes are logged in each workspace. Every action our staff take in the platform is logged too.",
  },
  {
    icon: "door" as const,
    title: "Our staff only by invitation",
    body: "Our support staff can open a workspace only when its owner grants access, for as long as the owner chooses — and each visit is recorded.",
  },
];

// ─── Pages ───────────────────────────────────────────────────────────────────────────────────────

const HOME: SitePage = {
  slug: "home",
  title: "Home",
  seo: {
    title: "{siteName} — {tagline}",
    absoluteTitle: true,
    description: "CRM and sales pipeline, quotes and GST invoices, accounting, HR and payroll, inventory, helpdesk and marketing in one workspace — each company on a database of its own.",
  },
  blocks: [
    {
      id: "home-hero",
      type: "hero",
      props: {
        eyebrow: "{tagline}",
        heading: "Sales, accounts, people and support in one workspace",
        subheading:
          "CRM and pipeline, quotes and GST invoices, accounting, HR and payroll, inventory, helpdesk and marketing — for each company in a workspace and a database of its own.",
        primary: { kind: "signup" },
        secondary: { kind: "link", label: "See pricing", href: "/pricing" },
        note: "Free for {trialDays} days. No card needed to start.",
        noteInviteOnly: "Setting up a workspace is by invitation for now.",
        media: { kind: "preview", preview: "pipeline" },
      },
    },
    {
      id: "home-stats",
      type: "stats",
      props: {
        items: [
          { value: String(MODULE_REGISTRY.length), label: "modules, switched on as you need them" },
          { value: "1", label: "database for each company, shared with no other" },
          { value: "{trialDays} days", label: "free trial, no card needed to start" },
        ],
      },
    },
    {
      id: "home-modules",
      type: "moduleGrid",
      props: {
        anchor: "modules",
        eyebrow: "Product",
        heading: "Everything a growing company runs on",
        intro: "Switch on the modules you need. They share one set of records, so an invoice posts itself to the ledger and a payslip reads attendance and leave.",
        groups: [
          {
            icon: "chart",
            title: "Sell",
            summary: "From the first call to the signed order.",
            modules: [
              { key: "companies", label: "Companies, contacts & leads", blurb: "Company profiles, contacts, and a lead pipeline from new to won." },
              { key: "calls", label: "Calls", blurb: "Dial from any record, time the call, log how it went, and keep a list of callbacks." },
              { key: "visits", label: "Field visits", blurb: "Plan client visits, check in and out on the day, and write up the outcome." },
              { key: "forecast", label: "Forecasting", blurb: "Open deals weighted by each stage's real win rate, with renewals and expected cash." },
              { key: "targets", label: "Targets", blurb: "Targets for people and teams, measured against the records themselves." },
              { key: "incentives", label: "Incentives", blurb: "Schemes with thresholds, bands and caps, paid through payroll." },
              { key: "wins", label: "Sales wins", blurb: "A wins wall, a monthly leaderboard and a screen for the sales floor." },
              { key: "workspace", label: "Saved lists", blurb: "Lists built from filters, which stay current as the data changes." },
              { key: "domains", label: "Domain intel", blurb: "What a prospect's DNS and website say about their email and hosting." },
            ],
          },
          {
            icon: "receipt",
            title: "Quote, bill and get paid",
            summary: "The documents your customers receive, and the money that follows.",
            modules: [
              { key: "sales_documents", label: "Quotes & GST invoices", blurb: "Proposals, proformas, tax invoices, credit notes and delivery challans, with place-of-supply tax." },
              { key: "orders", label: "Orders", blurb: "Sales punches the order, accounts approves the terms, purchasing sources it." },
              { key: "renewals", label: "Renewals", blurb: "Every subscription's start and expiry, and the renewals coming up." },
              { key: "payments", label: "Payments", blurb: "Payments received against orders, and what is still outstanding." },
              { key: "receivables", label: "Receivables & credit", blurb: "Ageing from due dates, statements, and who is safe to give terms to." },
              { key: "customer_portal", label: "Customer portal", blurb: "Customers see what they have, what they owe and their open tickets." },
            ],
          },
          {
            icon: "package",
            title: "Buy and stock",
            summary: "What you sell, what you buy, and what you own.",
            modules: [
              { key: "items", label: "Items & inventory", blurb: "Goods, services and subscriptions, with stock tracking for goods." },
              { key: "purchase_documents", label: "Purchase orders & bills", blurb: "Orders to vendors, and the bills that come back, reconciled." },
              { key: "payables", label: "Payables", blurb: "What you owe vendors, aged, with a statement for each." },
              { key: "vendors", label: "Vendors", blurb: "Vendors, OEMs, distributors and partners, kept apart from customers." },
              { key: "it_assets", label: "IT assets", blurb: "Every machine and licence: custody, warranty, AMC cover and movements." },
              { key: "expenses", label: "Expenses", blurb: "Claims with manager approval and reimbursement tracking." },
            ],
          },
          {
            icon: "book",
            title: "Accounts",
            summary: "Books that keep themselves up to date.",
            modules: [
              { key: "accounting", label: "General ledger", blurb: "Double-entry postings made as you invoice, bill, pay and run payroll — with trial balance, P&L, balance sheet and cash flow." },
              { key: "accounting", label: "Tax and period close", blurb: "Bank reconciliation, fixed assets and depreciation, GST and TDS returns, and closing a period so a filed figure can't change." },
            ],
          },
          {
            icon: "users",
            title: "People",
            summary: "From hiring to payslips.",
            modules: [
              { key: "hr", label: "HR", blurb: "Hiring and joining, employee records, holidays, leave and daily attendance, with biometric devices." },
              { key: "payroll", label: "Payroll", blurb: "Salary structures, the monthly run and payslips, with PF, ESI and professional tax." },
              { key: "visitors", label: "Visitor management", blurb: "A reception tablet that signs visitors in and tells their host they have arrived." },
              { key: "engagement", label: "Speak up & forms", blurb: "An anonymous feedback channel, and forms, polls and votes for HR." },
            ],
          },
          {
            icon: "headset",
            title: "Support and delivery",
            summary: "Looking after customers after the sale.",
            modules: [
              { key: "helpdesk", label: "Helpdesk", blurb: "Tickets with priority, an SLA target, assignment and a comment thread." },
              { key: "feedback", label: "Customer feedback", blurb: "A one-time link asking how it went, with every answer kept." },
              { key: "projects", label: "Projects", blurb: "Milestones, billing stages, agreements, risks and weekly updates." },
            ],
          },
          {
            icon: "megaphone",
            title: "Marketing",
            summary: "Reaching the customers who asked to hear from you.",
            modules: [
              { key: "marketing", label: "Marketing automation", blurb: "Campaigns and journeys built from what the ERP knows, every send checked against consent first." },
              { key: "forms", label: "Forms & events", blurb: "Event invitations with RSVPs and attendance, assessments and enquiry forms." },
            ],
          },
          {
            icon: "sparkles",
            title: "Everyday work",
            summary: "The tools everybody uses.",
            modules: [
              { key: "tasks", label: "Tasks & notes", blurb: "To-dos with due dates and reminders, and notes kept with the record they are about." },
              { key: "reports", label: "Reports", blurb: "Any figure broken down by anything else — month, person, brand, city." },
              { key: "vault", label: "Credential vault", blurb: "The company's own logins, encrypted, with every access recorded." },
              { label: "Copilot", blurb: "Ask questions of your data in plain language, with the AI provider and key you choose." },
            ],
          },
        ],
        footnote: "Also: resellers and commission parties, a contacts library, and notifications each person can tune. Accounting and payroll follow Indian rules, so they are offered in India only.",
      },
    },
    {
      id: "home-previews",
      type: "productPreviews",
      props: {
        eyebrow: "A closer look",
        heading: "Screens you will use every day",
        intro: "Drawn from the app, with sample data.",
        items: [
          { preview: "pipeline", title: "The lead pipeline", body: "Every lead by stage, from new to won, with its value and who owns it." },
          { preview: "invoice", title: "A GST tax invoice", body: "Tax worked out from the place of supply, with the e-invoice number and e-way bill from the government portal." },
          { preview: "attendance", title: "Attendance", body: "Present, from home, on leave or off — the week at a glance, and the loss of pay payroll works from." },
        ],
      },
    },
    {
      id: "home-india",
      type: "featureGrid",
      props: {
        anchor: "india",
        eyebrow: "Where you work",
        heading: "Built for India, ready for everywhere else",
        intro: "Indian tax and payroll rules are part of the product. Outside India, the same workspace is billed in your currency.",
        columns: 2,
        items: [
          {
            icon: "rupee",
            title: "Built for India",
            body: "For companies registered for GST.",
            bullets: [
              "GST tax invoices with place-of-supply tax, e-invoices (IRN) and e-way bills through the government portal",
              "GST and TDS returns, and periods you close so a filed figure can't change",
              "Payroll with PF, ESI and professional tax",
              "Addresses filled in from the PIN code",
              "Pay in rupees, through Razorpay",
            ],
          },
          {
            icon: "globe",
            title: "Works worldwide",
            body: "For teams and customers in other countries.",
            bullets: [
              "Billing through Stripe, in your currency where a plan is priced in it, and US dollars otherwise",
              "Plans offered country by country",
              "Quotes and invoices in your customer's currency, with the exchange rate kept on each document",
              "Addresses for every country",
              "Accounting and payroll follow Indian rules today, so they are sold in India only",
            ],
          },
        ],
      },
    },
    {
      id: "home-security",
      type: "securityHighlights",
      props: {
        anchor: "security",
        eyebrow: "Security",
        heading: "Each company's data, kept apart",
        intro: "Protection that comes from how the platform is built, not from a setting somebody has to find.",
        items: SECURITY_ITEMS,
        link: { label: "How we keep data apart", href: "/security" },
      },
    },
    {
      id: "home-pricing",
      type: "cta",
      props: {
        heading: "Plans for where you are",
        body: "Pay in rupees through Razorpay in India, and through Stripe everywhere else. Every workspace starts with a {trialDays}-day free trial.",
        primary: { kind: "link", label: "See plans and pricing", href: "/pricing" },
        secondary: { kind: "link", label: "Book a demo", href: "/contact?topic=demo" },
        variant: "panel",
      },
    },
    {
      id: "home-cta",
      type: "cta",
      props: {
        heading: "Give your company a workspace of its own",
        body: "An address of its own — yourcompany.{displayDomain} — and a database no other company shares.",
        primary: { kind: "signup" },
        secondary: { kind: "link", label: "Talk to us", href: "/contact" },
        variant: "band",
      },
    },
  ],
};

const PRICING: SitePage = {
  slug: "pricing",
  title: "Pricing",
  seo: {
    title: "Pricing",
    description: "Plans and prices for your country, in the currency you pay in — rupees through Razorpay in India, Stripe everywhere else. Every workspace starts with a free trial.",
  },
  blocks: [
    {
      id: "pricing-header",
      type: "pageHeader",
      props: {
        eyebrow: "Pricing",
        heading: "Plans and pricing",
        intro: "Prices for your country, in the currency you will pay in. Every workspace starts with a {trialDays}-day free trial.",
      },
    },
    {
      id: "pricing-table",
      type: "pricingTable",
      props: {
        countryLabel: "Prices for",
        editionsHeading: "Plans",
        extrasHeading: "Add-ons and bundles",
        extrasIntro: "On top of a plan: more modules, more people, more copilot.",
        trialNote: "Every workspace starts with a {trialDays}-day free trial. No card needed to start.",
        footnote: "Every plan includes the basics: companies, contacts and leads, tasks, notes and notifications.",
        emptyHeading: "Nothing is on sale here yet",
        emptyBody: "Plans for this country haven't been published. Tell us about your company and we will help you get started.",
        emptyAction: { kind: "link", label: "Talk to us", href: "/contact?topic=sales" },
      },
    },
    {
      id: "pricing-faq",
      type: "faq",
      props: {
        anchor: "faq",
        heading: "Questions about plans",
        items: [
          {
            question: "How does the free trial work?",
            answer: ["Every new workspace starts on a free trial of {trialDays} days, without a card. Choose a plan from your workspace's billing page whenever you are ready."],
          },
          {
            question: "Which currency will I pay in?",
            answer: [
              "In India, rupees, through Razorpay. Everywhere else, through Stripe — in your own currency where a plan is priced in it, and in US dollars otherwise.",
              "Prices on this page are shown in the currency you would be billed in. They are never converted.",
            ],
          },
          {
            question: "Can I change or cancel my plan?",
            answer: [
              "Outside India, change your plan, card or billing address, or cancel, from Stripe's billing portal, linked from your workspace.",
              "In India, a Razorpay subscription can be cancelled from your workspace; it runs to the end of the period you have paid for.",
            ],
          },
          {
            question: "What happens if a payment fails?",
            answer: ["Nothing is deleted. After a grace period the workspace is held: its owner can still sign in and reach the billing page, and paying reopens it at once."],
          },
          {
            question: "Is there a limit on people?",
            answer: ["Each plan says how many people it includes, and some are priced per person. Add-ons can add more."],
          },
          {
            question: "Can I see it before I sign up?",
            answer: ["Yes — book a demo and we will walk you through the modules that matter to you."],
          },
        ],
      },
    },
    {
      id: "pricing-cta",
      type: "cta",
      props: {
        heading: "Not sure which plan fits?",
        body: "Tell us how your company works and we will help you choose.",
        primary: { kind: "link", label: "Talk to us", href: "/contact?topic=sales" },
        secondary: { kind: "signup" },
        variant: "panel",
      },
    },
  ],
};

const SECURITY: SitePage = {
  slug: "security",
  title: "Security",
  seo: {
    title: "Security",
    description: "How each company's data is kept apart: a database of its own, per-workspace encryption keys, two-factor sign-in, audit logs, backups and the sub-processors we use.",
  },
  blocks: [
    {
      id: "security-header",
      type: "pageHeader",
      props: {
        eyebrow: "Security",
        heading: "How we keep each company's data apart",
        intro: "A plain-language summary of how the platform is built and run.",
        notice: {
          tone: "warning",
          text: "The legal documents this page draws on — the data processing agreement and the list of sub-processors — are drafts, still to be reviewed by counsel.",
        },
      },
    },
    {
      id: "security-highlights",
      type: "securityHighlights",
      props: { heading: "At a glance", items: SECURITY_ITEMS },
    },
    {
      id: "security-detail",
      type: "richText",
      props: {
        content: [
          { type: "heading", level: 2, text: "Isolation", anchor: "isolation" },
          {
            type: "paragraph",
            text: "Each workspace has its own database, with its own database login; no other workspace's login can connect to it. Every request is served as exactly one workspace, decided by the address it arrives on.",
          },
          {
            type: "paragraph",
            text: "Each workspace's database activity is bounded — in time and in connections — so one company's heavy day cannot slow another's.",
          },
          { type: "heading", level: 2, text: "Encryption", anchor: "encryption" },
          {
            type: "paragraph",
            text: "Stored secrets — passwords for mail, API keys, credentials in the vault — are encrypted with keys unique to the workspace. Those keys are sealed under a platform key held outside the database. Traffic is encrypted in transit (TLS).",
          },
          { type: "heading", level: 2, text: "Signing in and access", anchor: "access" },
          {
            type: "list",
            items: [
              "Two-factor authentication with an authenticator app, which a workspace can require of everybody",
              "Microsoft single sign-on",
              "Roles and permissions each company sets for itself",
              "Rules for the devices and networks each person may sign in from",
              "Accounts locked after repeated failed sign-ins",
            ],
          },
          { type: "heading", level: 2, text: "Our staff", anchor: "staff" },
          {
            type: "paragraph",
            text: "Platform staff work from a separate console, with its own sign-in and two-factor authentication. They cannot open a workspace unless its owner grants support access, for a time the owner chooses, and every such visit is recorded in the workspace's own activity log. Every action staff take in the console is recorded in the platform's audit log.",
          },
          { type: "heading", level: 2, text: "Records", anchor: "records" },
          { type: "paragraph", text: "Each workspace keeps an activity log of sign-ins, exports and changes, which its administrators can read." },
          { type: "heading", level: 2, text: "Backups and recovery", anchor: "backups" },
          {
            type: "list",
            items: [
              "Point-in-time recovery of the database cluster",
              "Scheduled, sealed backups of each workspace, kept apart from every other's",
              "Your data, exported whenever you like, from your workspace's settings",
            ],
          },
          { type: "heading", level: 2, text: "When a workspace closes", anchor: "closing" },
          {
            type: "paragraph",
            text: "A final backup is taken and the workspace's database is deleted. The backup and the keys to read it are kept for 90 days — in case you come back or ask for your data — and then the keys are destroyed, which makes every remaining copy unreadable. Backups of the whole platform expire after 30 days.",
          },
          { type: "heading", level: 2, text: "Testing", anchor: "testing" },
          {
            type: "paragraph",
            text: "Automated checks run on every change. A penetration test that tries to reach one workspace from another runs before any release touching sign-in, workspaces or billing.",
          },
          { type: "heading", level: 2, text: "Sub-processors", anchor: "subprocessors" },
          { type: "note", tone: "warning", text: "Draft — for review by counsel. The hosting and mail providers are still to be chosen; customers will get 30 days' notice of any change." },
          {
            type: "table",
            columns: ["Sub-processor", "What it does", "Personal data it sees", "Where"],
            rows: [
              ["Hosting provider — to be chosen", "Runs the servers, databases and backups", "Everything in every workspace (workspace secrets additionally encrypted by the platform)", "India (region to be confirmed)"],
              ["Mail provider — to be chosen", "Sends the platform's own mail: signup codes, workspace-ready notices, billing reminders", "Recipients' email addresses and names", "To be confirmed"],
              ["Stripe", "Charges workspaces outside India; collects tax numbers; works out tax", "The owner's name, billing email, address, tax number; card details (held by Stripe, never by us)", "USA / EU"],
              ["Razorpay", "Charges workspaces in India", "The owner's name, billing email, phone; payment method (held by Razorpay)", "India"],
            ],
          },
          {
            type: "paragraph",
            text: "Not sub-processors: services a company connects to its own workspace with its own credentials — its mail provider, Microsoft 365, the AI provider it chooses for the copilot, and the government's e-invoice and e-way bill portals. These act for the company.",
          },
          { type: "heading", level: 2, text: "Legal documents", anchor: "documents" },
          {
            type: "paragraph",
            text: [
              { text: "The " },
              { text: "privacy notice", href: "/privacy" },
              { text: " and the " },
              { text: "terms, with the data processing agreement", href: "/terms" },
              { text: ", are drafts for review by counsel." },
            ],
          },
        ],
      },
    },
    {
      id: "security-cta",
      type: "cta",
      props: {
        heading: "Questions from your security team?",
        body: "We are happy to answer security questionnaires and walk through how the platform works.",
        primary: { kind: "link", label: "Contact us", href: "/contact?topic=sales" },
        variant: "panel",
      },
    },
  ],
};

const CONTACT: SitePage = {
  slug: "contact",
  title: "Contact",
  seo: { title: "Contact", description: "Book a demo, ask about plans and pricing, or get help with your workspace." },
  blocks: [
    {
      id: "contact-header",
      type: "pageHeader",
      props: { eyebrow: "Contact", heading: "Talk to us", intro: "Book a demo, ask about plans and pricing, or get help with your workspace. Tell us what you need and we will get back to you." },
    },
    {
      id: "contact-form",
      type: "contactForm",
      props: {
        heading: "Send us a message",
        topics: { demo: "Book a demo", sales: "Plans, pricing or an invitation", support: "Help with my workspace", other: "Something else" },
        submitLabel: "Send message",
        successHeading: "Thanks — your message has been sent",
        successBody: "We will reply to the email address you gave.",
        asideHeading: "Other ways to reach us",
        aside: [
          { title: "Email", body: "{salesEmail}" },
          { title: "Already a customer?", body: "Sign in at your workspace's own address, or have us email you a link to each of your workspaces.", link: { label: "Sign in", href: "/signin" } },
          { title: "Security and privacy", body: "How each company's data is kept apart, and who we share it with.", link: { label: "Security", href: "/security" } },
        ],
      },
    },
  ],
};

const SIGNIN: SitePage = {
  slug: "signin",
  title: "Sign in",
  seo: { title: "Sign in", description: "Go to your workspace, or have us email you a link to every workspace you belong to." },
  blocks: [
    {
      id: "signin-header",
      type: "pageHeader",
      props: {
        heading: "Sign in",
        intro: "Every company on {siteName} has an address of its own. Go straight to yours, or have us email you a link to each workspace you belong to.",
      },
    },
    {
      id: "signin-options",
      type: "workspaceSignin",
      props: {
        goHeading: "Go to your workspace",
        goBody: "Type your workspace's name — the first part of its address.",
        findHeading: "Find my workspaces",
        findBody: "Forgotten the address? Enter your work email and we will send you a link to every workspace you can sign in to.",
        confirmationHeading: "Check your email",
        confirmationBody:
          "If that address belongs to anybody on {siteName}, we have sent it a list of their workspaces. Nothing there after a few minutes? Check your spam folder, or ask whoever invited you for your workspace's address.",
      },
    },
    {
      id: "signin-new",
      type: "cta",
      props: { heading: "New to {siteName}?", body: "Set up a workspace for your company in a few minutes.", primary: { kind: "signup" }, variant: "panel" },
    },
  ],
};

const SIGNUP: SitePage = {
  slug: "signup",
  title: "Set up a workspace",
  seo: { title: "Set up a workspace", description: "Set up a workspace for your company.", noindex: true },
  blocks: [
    {
      id: "signup-form",
      type: "signupForm",
      props: {
        heading: "Set up your workspace",
        body: "Your company gets an address of its own, and you are its owner. Free for {trialDays} days — no card needed to start.",
        bodyInviteOnly: "Setting up a workspace is by invitation for now. Enter the code from your invitation — or ask us for one.",
        asideHeading: "What you get",
        asideItems: [
          "An address of your own: yourcompany.{displayDomain}",
          "A database of its own, apart from every other company's",
          "You as its owner, with every permission — invite your team when you are ready",
          "The modules in your plan, switched on as you need them",
        ],
      },
    },
  ],
};

const DRAFT = "Draft — for review by counsel. Not legal advice; it will change before it is final.";

const TERMS: SitePage = {
  slug: "terms",
  title: "Terms",
  seo: { title: "Terms", description: "The draft terms for using the platform, including the data processing agreement." },
  blocks: [
    {
      id: "terms-header",
      type: "pageHeader",
      props: {
        eyebrow: "Legal",
        heading: "Terms",
        intro: "The terms of service are still being written. What follows is the draft data processing agreement that will form part of them: how we handle the personal data a company keeps in its workspace.",
        notice: { tone: "warning", text: DRAFT },
      },
    },
    {
      id: "terms-dpa",
      type: "richText",
      props: {
        heading: "Data processing agreement",
        content: [
          {
            type: "paragraph",
            text: "This agreement is between us, the provider of {siteName} (the processor), and the company that holds a workspace on it (the controller under the GDPR; the Data Fiduciary under India's DPDP Act).",
          },
          { type: "heading", level: 3, text: "1. What it covers" },
          {
            type: "list",
            items: [
              [{ text: "Subject matter: ", strong: true }, { text: "personal data the company puts into its workspace, or collects through it — its forms, its customer portal, its visitor tablet." }],
              [{ text: "Duration: ", strong: true }, { text: "for as long as the company has a workspace, and the retention period after it closes (section 9)." }],
              [{ text: "Nature: ", strong: true }, { text: "hosting, storing, backing up, and processing as the company's use of the software directs — nothing else." }],
              [{ text: "Purpose: ", strong: true }, { text: "to provide the service the company subscribed to." }],
            ],
          },
          { type: "heading", level: 3, text: "2. The personal data and the people it is about" },
          {
            type: "table",
            columns: ["People", "Personal data"],
            rows: [
              ["The company's staff (its users)", "Name, work email and phone, role, department, sign-in records and devices, attendance and leave, HR and payroll records where those modules are used"],
              ["The company's customers and prospects", "Contact names, work email and phone, company, communications, orders, invoices, tickets, feedback"],
              ["Its vendors, resellers, visitors and candidates", "Contact details, and what the company records about them"],
              ["Recipients of its marketing", "Email address, consent and its evidence, opens and clicks, unsubscribes"],
            ],
          },
          { type: "paragraph", text: "The service is not directed at children. The company agrees not to record children's personal data through it without the verifiable parental consent the law requires." },
          { type: "heading", level: 3, text: "3. Our obligations" },
          {
            type: "list",
            ordered: true,
            items: [
              "We process personal data only on the company's documented instructions — its use of the software, and this agreement — unless the law requires otherwise, in which case we tell the company first where the law allows.",
              "Everyone with access is bound to confidentiality. Our staff reach a workspace's data only when its owner grants support access, for a time the owner chooses, and every such access is recorded in the workspace's own activity log.",
              "We keep the security measures in section 5.",
              "We use sub-processors only as in section 6.",
              "We help the company answer requests from the people its data is about, and meet its own obligations on security, breach notification and impact assessments, as far as the nature of the processing allows.",
              "We delete or return personal data at the end of the service (section 9).",
              "We make available what is needed to show we comply with this agreement, and allow for audits (section 10).",
            ],
          },
          { type: "heading", level: 3, text: "4. The company's obligations" },
          {
            type: "paragraph",
            text: "The company is responsible for having a lawful basis (or, under the DPDP Act, consent or a legitimate use) for what it records, for its notices to the people concerned, for the accuracy of what it records, and for the access it gives its own users.",
          },
          { type: "heading", level: 3, text: "5. Security measures" },
          {
            type: "list",
            items: [
              [{ text: "Isolation: ", strong: true }, { text: "each workspace has its own database and database login; every request is served as exactly one workspace." }],
              [{ text: "Encryption: ", strong: true }, { text: "stored secrets are encrypted with keys unique to the workspace, sealed under a platform key held outside the database; traffic is encrypted in transit." }],
              [{ text: "Access: ", strong: true }, { text: "two-factor sign-in a workspace can require, Microsoft single sign-on, roles and permissions, device and network rules, and lockouts after repeated failures. Our staff use a separate console and cannot enter a workspace without its owner's grant." }],
              [{ text: "Records: ", strong: true }, { text: "an activity log in each workspace, and an audit log of every staff action." }],
              [{ text: "Resilience: ", strong: true }, { text: "point-in-time recovery of the database cluster, and scheduled, sealed backups of each workspace kept apart from every other's." }],
              [{ text: "Limits: ", strong: true }, { text: "each workspace's database activity is bounded, so one workspace's load cannot deny service to another." }],
            ],
          },
          { type: "heading", level: 3, text: "6. Sub-processors" },
          {
            type: "paragraph",
            text: [
              { text: "The company authorises the sub-processors on the " },
              { text: "security page", href: "/security#subprocessors" },
              { text: ". We give at least 30 days' notice of a new one, during which the company may object; if an objection cannot be resolved, the company may end the affected part of the service and receive a pro-rata refund." },
            ],
          },
          { type: "heading", level: 3, text: "7. Requests from the people the data is about" },
          {
            type: "paragraph",
            text: "The software lets the company answer requests itself: find everything held about a person, export it, correct it and delete it. Marketing recipients can always change what they receive, and unsubscribe, whatever the company's plan. Where the software cannot answer a request, we help within 10 working days of being asked.",
          },
          { type: "heading", level: 3, text: "8. Personal data breaches" },
          {
            type: "paragraph",
            text: "We notify the company without undue delay, and in any case within 48 hours, of becoming aware of a breach affecting its personal data — so it can notify its regulator within 72 hours under the GDPR, and the Data Protection Board of India and the people affected as the DPDP Rules require.",
          },
          { type: "heading", level: 3, text: "9. Return and deletion at the end of the service" },
          {
            type: "list",
            items: [
              "Before closing, the company can export its data, including a full archive.",
              "When a workspace is closed, a final backup is taken and its database is deleted. The backup and its keys are kept for 90 days, then the keys are wiped, which makes every remaining copy unreadable.",
              "Backups of the whole platform expire after 30 days; a closed workspace's data in them is unreadable once its keys are destroyed.",
            ],
          },
          { type: "heading", level: 3, text: "10. Audits" },
          {
            type: "paragraph",
            text: "On request we make our security documentation and test reports available and answer reasonable security questionnaires. On-site audits at the company's cost, with 30 days' notice, no more than once a year unless a breach or a regulator requires it.",
          },
          { type: "heading", level: 3, text: "11. International transfers" },
          {
            type: "paragraph",
            text: "Personal data is hosted in the region recorded for the workspace — India, unless agreed otherwise. Transfers out of the EU or UK follow the Standard Contractual Clauses (and the UK Addendum); transfers from India follow any restrictions notified under the DPDP Act.",
          },
          { type: "heading", level: 3, text: "12. Order of precedence" },
          { type: "paragraph", text: "If this agreement and the terms of service conflict on the protection of personal data, this agreement prevails." },
        ],
      },
    },
  ],
};

const PRIVACY: SitePage = {
  slug: "privacy",
  title: "Privacy",
  seo: { title: "Privacy", description: "What we collect, what we are responsible for, how long we keep it, and how to exercise your rights." },
  blocks: [
    {
      id: "privacy-header",
      type: "pageHeader",
      props: {
        eyebrow: "Legal",
        heading: "Privacy",
        intro: "What this site and the platform collect, who is responsible for what, and how to ask about your data.",
        notice: { tone: "warning", text: DRAFT },
      },
    },
    {
      id: "privacy-body",
      type: "richText",
      props: {
        content: [
          { type: "heading", level: 2, text: "Who is responsible for what" },
          {
            type: "table",
            columns: ["Data", "Our role", "Who decides"],
            rows: [
              ["What a company records in its workspace", "Processor — we act only on the company's instructions", "The company: the controller (GDPR) or Data Fiduciary (DPDP Act)"],
              ["Signups, workspace owners' account and billing details, visitors to this site", "Controller / Data Fiduciary", "Us"],
            ],
          },
          { type: "heading", level: 2, text: "What this site collects" },
          {
            type: "list",
            items: [
              [{ text: "No analytics or advertising cookies. ", strong: true }, { text: "Your choice of light or dark theme is kept in your own browser." }],
              [{ text: "Setting up a workspace: ", strong: true }, { text: "your company's name and address on the platform, your name, work email and country, your password (kept only as a one-way hash), and the network address you signed up from when it is known. One cookie links the emailed code to the browser that asked for it." }],
              [{ text: "The contact form: ", strong: true }, { text: "what you type, sent to our inbox." }],
              [{ text: "Find my workspaces: ", strong: true }, { text: "your email address, used once to look up your workspaces and email you the list." }],
            ],
          },
          { type: "heading", level: 2, text: "Your rights, and how to use them" },
          {
            type: "table",
            columns: ["Request", "Data in a company's workspace", "Our own records (signups, billing)"],
            rows: [
              ["A copy of your data", "Ask the company: it can find and export it with the software", "Ask us; we reply within 30 days, or the period the DPDP Rules set"],
              ["Correction", "Ask the company", "Ask us"],
              ["Erasure", "Ask the company; marketing consent is withdrawn by unsubscribing, which always works", "A signup that never became a workspace is deleted on request; a closed workspace is erased after 90 days"],
              ["Stop marketing", "Every email carries a one-click unsubscribe and a preference centre", "—"],
              ["A grievance (DPDP Act)", "The company's own grievance officer", "Our grievance officer — name and contact to be published"],
            ],
          },
          {
            type: "paragraph",
            text: [
              { text: "To ask us, use the " },
              { text: "contact form", href: "/contact?topic=other" },
              { text: " or write to {salesEmail}." },
            ],
          },
          { type: "heading", level: 2, text: "How long we keep things" },
          {
            type: "table",
            columns: ["What", "Kept", "Then"],
            rows: [
              ["A workspace's data", "While it has a workspace", "On closing: a final backup, then its database deleted"],
              ["A closed workspace's final backup and keys", "90 days", "Keys wiped: every copy unreadable"],
              ["Platform database backups", "30 days", "Expire"],
              ["Billing records and invoices", "As long as tax law requires (in India, 8 years)", "Deleted"],
            ],
          },
          { type: "heading", level: 2, text: "If something goes wrong" },
          {
            type: "paragraph",
            text: "We tell the companies whose workspaces are affected by a breach without undue delay, and within 48 hours. Where we are responsible for the data ourselves, we notify the regulator — within 72 hours under the GDPR — and the Data Protection Board of India and the people affected as the DPDP Rules require.",
          },
          { type: "heading", level: 2, text: "Who we share data with" },
          {
            type: "paragraph",
            text: [{ text: "Only the sub-processors listed on the " }, { text: "security page", href: "/security#subprocessors" }, { text: ", each bound to protect it as we do." }],
          },
        ],
      },
    },
  ],
};

/** Every page the site has by default, in the order the sitemap lists them. */
export const DEFAULT_SITE_PAGES: SitePage[] = [HOME, PRICING, SECURITY, CONTACT, SIGNIN, SIGNUP, TERMS, PRIVACY];

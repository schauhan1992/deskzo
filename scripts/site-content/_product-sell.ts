import { productPage } from "./_build";
import type { SeedPage } from "./types";

/**
 * The "Sell & serve" column: CRM, quotes and invoices, subscriptions and renewals, payments and
 * receivables, helpdesk, marketing, projects. Checked against src/lib/modules.ts, src/lib/{leads,
 * calls,gst-engine,einvoice,eway,renewals,subscriptions,receivables,credit,tickets,support,portal,
 * marketing,forms,projects}/** and their check scripts.
 *
 * The e-invoice and e-way bill connections call NIC's APIs directly, with a test mode that is the
 * default; they haven't yet been proven against the live portal, so the page describes the flow and
 * the test mode, and never "live e-invoicing".
 */

const crm = productPage({
  slug: "product/crm",
  name: "CRM",
  seo: {
    title: "CRM software for Indian sales teams",
    description: "CRM software for Indian sales teams: companies and contacts, a lead pipeline with scores, field visits, call logging and callbacks, beside your billing.",
    keywords: ["CRM software", "lead management software", "sales pipeline"],
  },
  eyebrow: "Sell & serve",
  h1: "CRM software for the whole sale, from lead to paid invoice",
  lead: "Companies and contacts, a lead pipeline from new to won, lead scores that explain themselves, field visits, call logging with callbacks, and duplicate checks, in the same workspace as your quotes, invoices and support.",
  heroPreview: "pipeline",
  answer: {
    question: "What is CRM software?",
    answer:
      "CRM software is where a company keeps its customers, their contacts and the deals it is working on. In {siteName}, the CRM is the record everything else hangs off: quotes, invoices, payments, tickets, visits and calls all belong to a company, so its page shows the whole relationship.",
    more: [
      "Lead management software only helps if leads arrive and move. Enquiries reach {siteName} through a lead capture API with a key per website, assignment rules share them out by brand, product, source or state, and each lead carries a score out of 100 that says why: fit, intent, engagement and stage, less points for going quiet.",
    ],
  },
  features: {
    heading: "What the CRM does",
    intro: "The CRM keeps every company, contact and lead in one place, and records each call and visit against them.",
    items: [
      { icon: "chart", title: "A sales pipeline you can drag", body: "New, contacted, qualifying, qualified, proposal sent, negotiation, then won or lost, on a board or a list. Lost and disqualified leads need a reason." },
      { icon: "gauge", title: "Lead scores with reasons", body: "A score out of 100 graded hot, warm or cold, with every point explained, so reps work the right leads first." },
      { icon: "users", title: "Assignment rules", body: "Round robin, fewest open leads, a named person or the account manager, matched on brand, product, designation, source or state. People on leave can be skipped." },
      { icon: "building", title: "A page for every company", body: "Contacts, products and subscriptions, documents, payments, credit, statement, calls, visits, tickets, emails and portal access, on one company page." },
      { icon: "headset", title: "Calls and callbacks", body: "A phone icon on each record dials from your device and times the call. Log how it went and set a callback, which lands on a worklist." },
      { icon: "map-pin", title: "Field visits", body: "Plan a visit with its purpose, check in on the day, write up the outcome and distance, and claim the travel against it." },
      { icon: "layers", title: "Saved lists and calling campaigns", body: "Lists saved as filters stay current. A calling campaign shares a list out among callers." },
      { icon: "check", title: "Duplicates found and merged", body: "Duplicate companies are found by name, GSTIN, PAN, domain and phone, and a merge moves every linked record across." },
    ],
  },
  how: [
    {
      heading: "How a lead moves through the sales pipeline",
      intro: "The sales pipeline in {siteName} is one board, and each move leaves a record.",
      body: [
        "A new enquiry arrives through the website's lead capture key, lands with the person the assignment rules choose, and starts with a score. The rep calls, logs the outcome and sets a callback. A proposal is raised from the lead, and when it is won, the company already has the contacts, the quote and the history, ready for the invoice.",
      ],
      bullets: ["Stages from new to won, with reasons for every loss", "Retries from a website never create a duplicate lead", "Enquiries from a reseller's customers never become leads"],
      preview: "pipeline",
      side: "left",
    },
  ],
  faq: [
    ["Can my website send enquiries straight into the CRM?", "Yes. Your website posts each enquiry to {siteName}'s lead capture API with its own key, and the lead is created and assigned. A retried request with the same reference doesn't create a duplicate."],
    ["Does the calls feature record or route phone calls?", "No. The phone icon dials from the device you are on and times the call on screen; the rep logs the outcome. There is no telephony integration, recording or call routing."],
    ["Can reps see each other's customers?", "Not unless their role allows it. A rep sees the accounts they manage, and a manager sees their team's, down the reporting line."],
    ["Can we change the pipeline stages?", "The stages are fixed, from new to won or lost, so every report and forecast reads them the same way. The forecast's weight for each stage can be changed."],
  ],
  related: ["/product/quotes-invoices", "/product/marketing", "/product/targets-incentives", "/product/reports", "/solutions/sales-teams", "/solutions/founders"],
  cta: { heading: "Bring your leads and customers in", body: "Import companies and contacts from a spreadsheet and start working your pipeline today. Every workspace starts with a {trialDays}-day free trial." },
});

const quotes = productPage({
  slug: "product/quotes-invoices",
  name: "Quotes & invoices",
  seo: {
    title: "GST billing software with e-invoicing",
    description: "GST billing software for proposals, proformas, tax invoices and credit notes, with place-of-supply tax, e-invoice IRN steps, e-way bills and approvals.",
    keywords: ["GST billing software", "e-invoicing software", "quotes and invoices"],
  },
  eyebrow: "Sell & serve",
  h1: "GST billing software for quotes, invoices, e-invoices and e-way bills",
  lead: "Proposals, proforma invoices, GST tax invoices and credit notes, with CGST and SGST or IGST worked out from the place of supply. Each tax invoice can carry its e-invoice IRN and QR code and an e-way bill.",
  heroPreview: "invoice",
  answer: {
    question: "What is GST billing software?",
    answer:
      "GST billing software is the tool that makes the documents a customer receives and works out the GST on them. In {siteName}, a proposal becomes a proforma or a tax invoice in one step, the tax on each line follows the place of supply, and issuing the invoice posts it to the books.",
    more: [
      "Quotes and invoices share one engine. Each document type has its own number series for each branch, reset every financial year. An issued document is locked, and a correction is made with a credit note, as GST rules expect. Line items carry HSN or SAC codes, freight can carry its own tax rate, and documents can be in any of fourteen currencies, with the exchange rate kept on the document.",
    ],
  },
  features: {
    heading: "What the billing module makes",
    intro: "The billing module makes every document from a first quote to a credit note, with the tax on each line worked out for you.",
    items: [
      { icon: "file-text", title: "Five sales documents", body: "Proposals, proforma invoices, tax invoices, credit notes and delivery challans, each with its own prefix and series." },
      { icon: "rupee", title: "Place-of-supply tax", body: "CGST and SGST when the seller's state is the place of supply, IGST when it isn't. Reverse charge, TDS and TCS, and a round-off line are there too." },
      { icon: "receipt", title: "E-invoicing software steps", body: "Generate the IRN and signed QR code when an invoice or credit note is issued, print them, and cancel within 24 hours with the portal's reasons." },
      { icon: "truck", title: "E-way bills", body: "Raised from an invoice, a credit note or a delivery challan, with Part B vehicle updates, validity worked out from the distance, and cancellation." },
      { icon: "check", title: "Approval rules", body: "Documents above a value, or with a discount above a percentage you set, wait for approval by role, by name or by the maker's manager." },
      { icon: "mail", title: "Emailed as PDFs", body: "Send the PDF from your own Microsoft 365 mailbox to the customer's contacts, with a template for each document type. Every send is logged." },
      { icon: "globe", title: "Fourteen currencies", body: "Quote in dollars, euros, dirhams and more. The rate is fixed on the document and the print shows the rupee equivalent." },
      { icon: "layers", title: "Where every document came from", body: "Each document records whether it was typed, converted, priced by the add-on calculator, raised from the renewals list or from a consignment." },
    ],
  },
  how: [
    {
      heading: "How a proposal becomes a paid GST invoice",
      intro: "Quotes and invoices follow one path, and nothing is typed twice.",
      body: [
        "A proposal is priced from the item catalogue and sent as a PDF. When the customer agrees, convert it into a proforma or a tax invoice. Issuing the tax invoice locks it, gives it the next number in the branch's series, works out its GST and posts it to the ledger. Where e-invoicing applies, the IRN and QR code are generated at the same moment and printed on the invoice.",
      ],
      bullets: ["Credit notes against an invoice, never edits", "Numbering per branch and financial year", "Approval before issue for large values or discounts"],
      preview: "invoice",
    },
  ],
  faq: [
    ["Does it decide between IGST and CGST plus SGST automatically?", "Yes. It compares the seller's state with the place of supply on each document: the same state gives CGST and SGST, a different state gives IGST."],
    ["How does {siteName} connect to the e-invoice and e-way bill systems?", "Directly to NIC's e-invoice and e-way bill APIs, with each GSTIN's own API credentials, and no GST Suvidha Provider in between. Each GSTIN starts in test mode, so the whole flow can be tried before it is switched to NIC's sandbox or production system."],
    ["Can large discounts need a manager's sign-off?", "Yes. Set a value or a discount percentage for each document type, and documents above it wait for an approver. Nobody approves their own document."],
    ["Can we raise recurring invoices automatically?", "Not yet. Renewals are raised from the renewals list with one click, but invoices aren't created on a schedule."],
  ],
  related: ["/product/accounting-gst", "/product/payments-receivables", "/product/subscriptions-renewals", "/product/multi-branch-gst", "/product/inventory", "/solutions/small-business"],
  cta: { heading: "Issue your first GST invoice today", body: "Set up a workspace, add your items and send a proposal this afternoon. Every workspace starts with a {trialDays}-day free trial." },
});

const renewals = productPage({
  slug: "product/subscriptions-renewals",
  name: "Subscriptions & renewals",
  seo: {
    title: "Subscription and renewal management software",
    description: "Renewal management software for orders, subscriptions, add-on seats and AMCs: approvals, margin, renewal stages and one-click renewal proposals.",
    keywords: ["renewal management software", "subscription management", "order management"],
  },
  eyebrow: "Sell & serve",
  h1: "Renewal management software for every subscription you sell",
  lead: "Orders punched by sales, approved by accounts and sourced by purchasing. Every subscription's start and expiry, the renewals coming up, add-on seats priced to end with their parent, and AMCs on the machines they cover.",
  answer: {
    question: "What is renewal management software?",
    answer:
      "Renewal management software is the record of when each subscription a customer holds expires, and of who is renewing it. In {siteName}, the renewals list shows what has expired and what is due within 30 days, 60 days or 90 days, with a stage for each renewal.",
    more: [
      "Most stages are worked out from what has happened: a task raised, the customer contacted, a quote sent, negotiating, on hold, lost or renewed. A rep can pin a stage by hand when they know more than the records do. From the list, one click raises a renewal proposal priced at the full-term rate for the subscription and all its add-ons, or punches the renewal order.",
    ],
  },
  features: {
    heading: "What order and subscription management covers",
    intro: "Order management and subscription management cover the order that starts a subscription, the add-ons it gathers, and the renewal that continues it.",
    items: [
      { icon: "check", title: "Order punching with approvals", body: "Sales punches the order, accounts approves the payment terms and purchasing sets the vendor, cost and PO number. Nobody approves their own." },
      { icon: "rupee", title: "Margin on every order", body: "Sell price against purchase price, less commission, freight and installation, with each order marked new, renewal or add-on." },
      { icon: "calendar", title: "Renewal windows", body: "Expired, or due within 30 days, 60 days or 90 days, with stages worked out from activity and renewal tasks created in bulk." },
      { icon: "layers", title: "Add-on seats, pro-rated", body: "An add-on ends on the same day as its parent subscription, priced for the days or months left." },
      { icon: "shield", title: "AMCs on machines", body: "AMCs are subscriptions linked to IT assets, so each machine shows warranty, AMC, both or none." },
      { icon: "mail", title: "Service messages", body: "Renewal reminders and order-fulfilled notices go out as service messages, so they reach customers who opted out of marketing." },
    ],
  },
  how: [
    {
      heading: "How a renewal is won back",
      intro: "Subscription management in {siteName} starts ninety days before the expiry date.",
      steps: [
        "The subscription appears in the 90-day window, and a renewal task is raised.",
        "The rep contacts the customer, and the stage moves as calls and quotes are logged.",
        "One click raises the renewal proposal, with every add-on seat at the full-term price.",
        "The renewal order is punched, approved and fulfilled, and the new term starts.",
      ],
    },
  ],
  faq: [
    ["What happens when a customer adds seats mid-term?", "The add-on ends on the same day as the parent subscription and is priced for the time left, by day or by month. At renewal, all seats are quoted at the full-term price."],
    ["Do subscriptions renew or invoice automatically?", "No. Renewals are raised from the renewals list, and invoicing is a step someone takes. Fulfilling an order doesn't create an invoice by itself."],
    ["Can accounts stop an order on risky credit terms?", "Yes. Terms or a value beyond what the customer's credit rating supports need an override with a written reason."],
  ],
  related: ["/product/quotes-invoices", "/product/payments-receivables", "/product/revenue-close", "/product/assets", "/solutions/it-services-resellers", "/solutions/saas-subscriptions"],
  cta: { heading: "Never miss a renewal date again", body: "Import your subscriptions with their expiry dates and see the next 90 days. Every workspace starts with a {trialDays}-day free trial." },
});

const payments = productPage({
  slug: "product/payments-receivables",
  name: "Payments & receivables",
  seo: {
    title: "Accounts receivable software for collections",
    description: "Accounts receivable software: payments allocated to invoices, ageing from due dates, customer statements, credit notes and a credit rating for each customer.",
    keywords: ["accounts receivable software", "payment tracking", "customer credit limit"],
  },
  eyebrow: "Sell & serve",
  h1: "Accounts receivable software that shows who owes what, and who to trust",
  lead: "Every receivable in one place: payments allocated against invoices, ageing from each invoice's due date, a statement for every customer, and a credit rating that suggests terms and limits with its reasons.",
  heroPreview: "invoice",
  answer: {
    question: "What does accounts receivable software do?",
    answer:
      "Accounts receivable software is the record of the money customers owe and the payments made against it. In {siteName}, an invoice's status, issued, partly paid or paid, is worked out from the payments and credit notes applied to it, and never set by hand.",
    more: [
      "Payment tracking starts with the payment itself: bank transfer, UPI, cheque with its cleared date, cash or card. One payment can be split across several invoices, and anything left over stays on account. A payment in a foreign currency books its exchange gain or loss on each part. Rupees received on account can be set against a dollar invoice at the day's rate.",
    ],
  },
  features: {
    heading: "What receivables management covers",
    intro: "Receivables management covers what is owed, how late it is, and whether to give the customer more credit.",
    items: [
      { icon: "gauge", title: "Ageing from due dates", body: "Not yet due, then up to 30 days, up to 60 days, up to 90 days and over 90 days late, counted from each invoice's due date." },
      { icon: "file-text", title: "Customer statements", body: "Invoices, payments and credit notes with a running balance, and the ageing of what is still open." },
      { icon: "receipt", title: "Credit notes applied", body: "Apply a credit note against an invoice, or take the application back, and the invoice's status follows." },
      { icon: "shield", title: "Customer credit limit", body: "Reliable, fair, risky or new, from two years of payment habits, with suggested terms and a credit limit, and the reasons in words." },
      { icon: "lock", title: "Overrides with reasons", body: "Longer terms than the rating supports, or an order over the limit, need an override permission and a written reason." },
      { icon: "book", title: "Posted to the books", body: "With accounting on, each payment clears the receivable in the ledger, and the ageing is checked against it at month end." },
    ],
  },
  how: [
    {
      heading: "How a customer's credit rating is worked out",
      intro: "The customer credit limit comes from how the customer has actually paid.",
      body: [
        "{siteName} looks at two years of each customer's invoices and payments. Paying within a few days of the due date counts as on time; anything over ninety days late makes the customer risky. From that it suggests payment terms and a credit limit, and writes down why, so the decision can be explained to sales.",
      ],
      bullets: ["Ratings: reliable, fair, risky and new", "Suggested terms and limit, with their reasons", "Overrides kept with the person and the reason"],
      preview: "invoice",
      side: "left",
    },
  ],
  faq: [
    ["Can customers pay invoices online?", "Not through {siteName}. Customers pay by bank transfer, UPI, cheque, card or cash, and you record the payment. The invoice prints your bank details and UPI ID."],
    ["How is ageing worked out?", "From each invoice's due date, or its issue date when it has none, in 30-day buckets up to over 90 days."],
    ["Does it send payment reminders?", "No automatic reminders are sent. A customer with an overdue invoice is held back from marketing mail, so a promotion never reaches someone who owes you."],
  ],
  related: ["/product/quotes-invoices", "/product/accounting-gst", "/product/subscriptions-renewals", "/product/reports", "/solutions/finance-teams", "/solutions/trading-distribution"],
  cta: { heading: "See who owes you, as of today", body: "Record this month's payments and read the ageing tomorrow morning. Every workspace starts with a {trialDays}-day free trial." },
});

const helpdesk = productPage({
  slug: "product/helpdesk",
  name: "Helpdesk",
  seo: {
    title: "Helpdesk software with SLAs and a portal",
    description: "Helpdesk software for support teams: tickets with priority and SLA targets, a customer portal, support load by customer, and feedback after the work is done.",
    keywords: ["helpdesk software", "ticketing system", "customer portal"],
  },
  eyebrow: "Sell & serve",
  h1: "Helpdesk software linked to what each customer bought",
  lead: "Support tickets with priority, an SLA target, assignment and a comment thread, each tied to the company, contact, subscription and machine it is about. A portal for customers, and feedback when the work is done.",
  answer: {
    question: "What is helpdesk software?",
    answer:
      "Helpdesk software is the queue a support team works from: each customer request is a ticket with an owner, a priority and a deadline. In {siteName}, a ticket belongs to a company and can name the order, subscription or machine it concerns.",
    more: [
      "Each priority has its SLA target: urgent tickets within 4 hours, high within 24, medium within 72 and low within 168. A ticket shows when it is due, or how long it has been overdue. The support load page puts tickets beside billing, so you can see which customers take the most support for what they pay.",
    ],
  },
  features: {
    heading: "What the ticketing system does",
    intro: "The ticketing system keeps each customer request in one queue, with an owner and a deadline.",
    items: [
      { icon: "headset", title: "Tickets with types", body: "Product support, demos, installation, training and more, each with a number, a status and an assigned agent." },
      { icon: "gauge", title: "SLA targets by priority", body: "Low, medium, high and urgent, each with its target, shown as due by or overdue since." },
      { icon: "users", title: "Comments and bulk updates", body: "An internal thread on each ticket, and bulk changes of status or owner from the list." },
      { icon: "chart", title: "Support load", body: "Tickets for each rupee billed, customer by customer, set against the typical customer and marked heavy or light." },
      { icon: "globe", title: "A customer portal", body: "A personal link for each contact shows their subscriptions with days left, their invoices and credit notes, and their tickets' status." },
      { icon: "check", title: "Feedback after the work", body: "A one-time link asks the customer to rate the person and the product on a scale of one to five. A happy score can offer your public review page." },
    ],
  },
  how: [
    {
      heading: "How the customer portal works",
      intro: "The customer portal needs no password: each contact gets a personal link from your team.",
      steps: [
        "Create a portal link for the contact, with an expiry date if you want one.",
        "The customer opens it and sees their subscriptions, invoices and tickets.",
        "They ask for a renewal, more seats, or send a question, which lands in customer requests.",
        "Your team works the request, and the link can be revoked at any time.",
      ],
    },
  ],
  faq: [
    ["Can customers raise tickets by email or in the portal?", "Not yet. Tickets are raised by your team; in the portal, customers can send a question, a renewal request or a request for more seats, which reach your team as customer requests."],
    ["Can we change the SLA targets?", "Not today. The targets are fixed for each priority: 4 hours, 24 hours, 72 hours and 168 hours from creation."],
    ["Can customers see their invoices in the portal?", "Yes. The portal shows their issued invoices, proformas and credit notes, their subscriptions and the status of their tickets."],
  ],
  related: ["/product/crm", "/product/subscriptions-renewals", "/product/assets", "/product/projects", "/solutions/it-services-resellers"],
  cta: { heading: "Answer every ticket on time", body: "Set up a workspace and raise your first ticket against a customer today. Every workspace starts with a {trialDays}-day free trial." },
});

const marketing = productPage({
  slug: "product/marketing",
  name: "Marketing",
  seo: {
    title: "Marketing automation built on your customers",
    description: "Marketing automation for B2B companies: campaigns and journeys from renewals and warranties, consent by topic, forms and events with RSVPs, and mass mail.",
    keywords: ["marketing automation", "email campaigns with consent", "event registration forms"],
  },
  eyebrow: "Sell & serve",
  h1: "Marketing automation that knows your customers' renewals",
  lead: "Campaigns and triggered journeys built from what the ERP knows: a renewal coming up, a warranty running out, more staff than seats. Every send is checked against consent first. Forms and events collect enquiries, RSVPs and attendance.",
  answer: {
    question: "What does marketing automation do in {siteName}?",
    answer:
      "Marketing automation is a way of sending the right message when something happens. In {siteName}, a journey starts from one of 19 triggers, such as a renewal due, an AMC running out or a proposal with no reply, and each step sends an email or a WhatsApp template, or gives one of your team a task.",
    more: [
      "Consent is recorded by topic, renewals, offers, product news, events, newsletter and service, with where it came from. Before any message goes, {siteName} checks it: an unsubscribed or unverified address, a hard bounce, a reseller's customer, an open complaint, an overdue invoice or a ticket past its SLA holds the message back.",
    ],
  },
  features: {
    heading: "What the marketing module covers",
    intro: "The marketing module covers one-off campaigns, journeys that start themselves, and the forms and events that bring people in.",
    items: [
      { icon: "megaphone", title: "Campaigns with approval", body: "Draft, schedule, send and pause campaigns. A large send waits for a second person to approve it." },
      { icon: "sparkles", title: "Triggered journeys", body: "Renewal due or missed, warranty or AMC running out, a lead gone quiet, a customer who rated you well, and more." },
      { icon: "shield", title: "Email campaigns with consent", body: "Consent by topic with its evidence, a preference centre, one-click unsubscribe, frequency caps and quiet hours." },
      { icon: "mail", title: "Mass mail", body: "Upload an HTML or zipped template from Stripo, BEE, Mailchimp or Canva, and a CSV list, with open and click tracking." },
      { icon: "calendar", title: "Event registration forms", body: "Events with RSVPs, seat limits and deadlines, and an attendance register of who came." },
      { icon: "file-text", title: "Enquiry forms and assessments", body: "Forms with twelve field types, shared by public link or personal invitation. Enquiry forms can create leads." },
    ],
  },
  how: [
    {
      heading: "How a renewal journey runs",
      intro: "A journey reads the same records your sales team works from.",
      steps: [
        "Choose a trigger, such as a subscription due for renewal in 60 days.",
        "Add steps: an email now, a WhatsApp template a week later, and a task for the account manager if there is no reply.",
        "Before each step, the message is checked against consent, complaints, overdue invoices and quiet hours.",
        "The journey stops for a customer once the renewal is won.",
      ],
    },
  ],
  faq: [
    ["Which email providers can send our campaigns?", "Resend, Elastic Email, Amazon SES or Microsoft 365, with your own account. Transactional and marketing mail can go through different providers, with failover."],
    ["Can we send WhatsApp messages?", "Journeys and campaigns can send pre-approved WhatsApp templates through Meta's Cloud API. You need your own WhatsApp Business account and approved templates."],
    ["Will we email a customer who has an open complaint?", "No. A customer with an unanswered complaint, an overdue invoice or a ticket past its SLA is held back until it is resolved."],
    ["Can the forms be embedded on our website?", "Forms are shared as links to their own pages. They can't be embedded in a frame on another website."],
  ],
  related: ["/product/crm", "/product/subscriptions-renewals", "/product/helpdesk", "/solutions/sales-teams", "/solutions/it-services-resellers"],
  cta: { heading: "Reach customers who asked to hear from you", body: "Set up a workspace, import your contacts with their consent, and build your first journey. Every workspace starts with a {trialDays}-day free trial." },
});

const projects = productPage({
  slug: "product/projects",
  name: "Projects",
  seo: {
    title: "Project management software for client work",
    description: "Project management software for delivery teams: milestones, billing stages that raise invoices, agreements, encrypted credentials, risks and weekly updates.",
    keywords: ["project management software", "milestone billing", "client project tracking"],
  },
  eyebrow: "Sell & serve",
  h1: "Project management software for work you deliver to customers",
  lead: "Website builds, migrations and implementations: milestones and billing stages, an agreement and NDA store, encrypted credentials, risks and weekly updates, visible to the people on each project.",
  answer: {
    question: "What is project management software for client work?",
    answer:
      "Project management software for client work is the record of what you promised a customer, when, and what you can bill for it. In {siteName}, each project has delivery milestones and billing stages, and raising a stage's invoice links the two.",
    more: [
      "A project moves from proposed through discovery, planning, in progress, UAT, go-live and handover to completed, with a health of on track, at risk or off track. Only its stakeholders can see it, including the customer's and vendors' people named on it, so a project's credentials and agreements stay with the people who need them.",
    ],
  },
  features: {
    heading: "What client project tracking covers",
    intro: "Client project tracking covers the plan, the money and the paperwork of each project you deliver.",
    items: [
      { icon: "calendar", title: "Delivery milestones", body: "Milestones from templates for each project type, so a new implementation starts with the usual steps." },
      { icon: "rupee", title: "Milestone billing", body: "Billing stages as an amount or a share of the value. Raise the invoice from the stage, and it follows that invoice until it is paid." },
      { icon: "scroll", title: "Agreements and NDAs", body: "Agreements, NDAs, statements of work, proposals, designs and sign-offs stored on the project." },
      { icon: "lock", title: "Encrypted credentials", body: "Client logins encrypted at rest. Revealing one needs your own password, and every reveal is logged." },
      { icon: "shield", title: "Risks and issues", body: "Each risk or issue with its severity and status, from open to closed." },
      { icon: "history", title: "Weekly updates", body: "A weekly update with its health status, so anyone on the project can see where it stands." },
    ],
  },
  how: [
    {
      heading: "How milestone billing works",
      intro: "Milestone billing ties the invoice to the work that earned it.",
      steps: [
        "Set the project's billing stages, each an amount or a share of the value.",
        "When a stage falls due, raise its invoice from the project.",
        "The stage follows the invoice: invoiced, then paid, or back to due if it is cancelled.",
        "With Revenue & Close on, a milestone's revenue is recognised in the month the milestone is delivered.",
      ],
    },
  ],
  faq: [
    ["Can a sales rep see every project?", "No. A project is visible to its stakeholders, and to people whose role can see all projects."],
    ["Are there Gantt charts or timesheets?", "No. Projects track milestones, billing, documents, risks and weekly updates; there are no Gantt charts or timesheets."],
    ["Can customers see their project?", "Not yet. Customer stakeholders are named on the project as contacts, but the customer portal doesn't show projects."],
  ],
  related: ["/product/quotes-invoices", "/product/revenue-close", "/product/helpdesk", "/solutions/professional-services", "/solutions/operations"],
  cta: { heading: "Bill each milestone the day it is delivered", body: "Set up a workspace and add your current projects with their billing stages. Every workspace starts with a {trialDays}-day free trial." },
});

export const SELL_PAGES: SeedPage[] = [crm, quotes, renewals, payments, helpdesk, marketing, projects];

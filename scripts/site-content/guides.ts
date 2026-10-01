import type { RichNode, SiteBlock } from "../../src/components/site/blocks/types";
import { DEMO, SIGNUP, note, ol, p, related, runs, table, ul } from "./_build";
import type { SeedCategory, SeedPost, SeedSection } from "./types";

/**
 * The Guides category (/blog/category/guides) and its six starter guides.
 *
 * Every regulatory fact is from an official source (cbic-gst.gov.in, gst.gov.in, einvoice.gst.gov.in,
 * ewaybillgst.gov.in, incometaxindia.gov.in, epfindia.gov.in / epfo.gov.in, esic.gov.in, icai.org),
 * read on REVIEWED, and linked where it is stated. Where a figure changes by notification, the guide
 * says to check the current one. The product sections say what {siteName} does today, limits included.
 */

const REVIEWED = "30 September 2026";

const SRC = {
  einvoiceFaq: "https://einvoice.gst.gov.in/faqs",
  einvoicePortal: "https://einvoice.gst.gov.in/",
  einvoiceOverview: "https://tutorial.gst.gov.in/downloads/news/e_invoice_overview.pdf",
  einvoiceExempt: "https://einvoice.gst.gov.in/uiassets/js/assets/files/Manual_on_e-invocie_exemption.pdf",
  einvoiceManual: "https://einvoice1.gst.gov.in/Documents/EINVOICE_UserManual_Web.pdf",
  irps: "https://tutorial.gst.gov.in/downloads/news/e_invoice_services_offered_by_the_new_irps_updated_irps_final_1Aug2023.pdf",
  gstPortal: "https://www.gst.gov.in/",
  hsn: "https://tutorial.gst.gov.in/downloads/news/updated_advisory_hsn_table12_25042025.pdf",
  gstr1: "https://tutorial.gst.gov.in/userguide/returns/GSTR_1.htm",
  gstr3b: "https://tutorial.gst.gov.in/userguide/returns/GSTR3B.htm",
  ewbPortal: "https://ewaybillgst.gov.in/",
  ewbFaq: "https://ewaybillgst.gov.in/Staticpages/faq.aspx",
  itAct: "https://www.incometaxindia.gov.in/income-tax-act-2025",
  tdsRates: "https://www.incometaxindia.gov.in/w/tds-rates",
  tdsInterest: "https://www.incometaxindia.gov.in/w/interest-for-delay-in-payment-of-tds/tcs-and-for-non-payment-of-tax-demanded-1",
  tdsLateFee: "https://www.incometaxindia.gov.in/w/late-filing-fees-and-penalty-for-failure-to-furnish/delay-in-furnishing-the-tds/tcs-statements%E2%80%8B-1",
  tdsNoPan: "https://www.incometaxindia.gov.in/w/higher-deduction-of-tax-at-source-in-certain-cases-section-206aa-and-section-206ab-1",
  tan: "https://www.incometaxindia.gov.in/w/tax-deduction-account-number-1",
  itForms: "https://www.incometaxindia.gov.in/faqs-and-guidance-notes-on-forms-as-per-income-tax-rules-2026",
  indAs115: "https://resource.cdn.icai.org/94042indas2025-26-115.pdf",
  indAsApplicability: "https://resource.cdn.icai.org/75317asb60889.pdf",
  as9: "https://resource.cdn.icai.org/89101asb-aps2918-as9.pdf",
  epfCeilingFaq: "https://pmvbry-cdn.epfindia.gov.in/wp-content/uploads/2026/09/EPFO_Wage_Ceiling_FAQs.pdf",
  epfCeilingCircular: "https://pmvbry-cdn.epfindia.gov.in/wp-content/uploads/2026/09/Wage-Ceiling-Circular-28.09.2026.pdf",
  epfoFaq: "https://www.epfo.gov.in/faq-epfo/",
  socialSecurityCode: "https://esic.gov.in/attachments/actfile/The_Code_on_Social_Security_2020_No_36_of_2020_1787043715.pdf",
  codesInForce: "https://esic.gov.in/attachments/actfile/MINISTRY_OF_LABOUR_AND_EMPLOYMENT_NOTIFICATION_1787043012.pdf",
  esicCoverage: "https://esic.gov.in/coverage",
  esicContribution: "https://esic.gov.in/contribution",
};

const GUIDES: SeedCategory = {
  slug: "guides",
  name: "Guides",
  description:
    "Practical guides for Indian businesses: e-invoicing and e-way bills under GST, TDS on business payments, the month-end close, revenue recognition under Ind AS 115, and PF, ESI and professional tax in payroll. Each links to the official sources and says when it was last reviewed.",
  seo: {
    title: "Guides to GST, TDS, payroll and the close",
    description: "Practical, sourced guides for Indian businesses: e-invoicing, e-way bills, TDS, the month-end close, Ind AS 115 and payroll deductions.",
    keywords: ["GST guides", "TDS guide", "payroll compliance guide"],
  },
};

/** A section of a guide: its H2 and what is under it. */
const part = (id: string, heading: string, content: RichNode[]): SiteBlock => ({ id, type: "richText", props: { heading, content } });
const reviewed = (id: string, extra: string): SiteBlock => ({ id, type: "richText", props: { content: [note(`Last reviewed: ${REVIEWED}. ${extra}`)] } });
const faq = (id: string, heading: string, items: [string, ...string[]][]): SiteBlock => ({ id, type: "faq", props: { heading, items: items.map(([question, ...answer]) => ({ question, answer })) } });
const cta = (id: string, heading: string, body: string): SiteBlock => ({ id, type: "cta", props: { heading, body, primary: SIGNUP, secondary: DEMO, variant: "panel" } });

// ─── 1. E-invoicing ──────────────────────────────────────────────────────────────────────────────

const einvoicing: SeedPost = {
  slug: "e-invoicing-under-gst",
  title: "E-invoicing under GST: who must do it, and how an IRN is issued",
  excerpt:
    "E-invoicing under GST is the reporting of each B2B invoice to a government Invoice Registration Portal, which checks it, signs it and returns an IRN and a QR code. This guide covers who must e-invoice, which documents are covered, the reporting time limit and cancellation.",
  seo: {
    title: "E-invoicing under GST: who, what and when",
    description: "E-invoicing under GST explained: the ₹5 crore threshold, which documents need an IRN, the 30-day reporting limit and cancellation within 24 hours.",
    keywords: ["e-invoicing under GST", "IRN generation", "e-invoice time limit"],
  },
  categories: ["guides"],
  body: [
    reviewed("einv-reviewed", "Thresholds and time limits change by notification: check the current one on the e-invoice portal before you rely on a figure."),
    part("einv-what", "What is e-invoicing under GST?", [
      p("E-invoicing under GST is a reporting system, not a way of making invoices. You still create the invoice in your own software; its details are then reported to an Invoice Registration Portal (IRP), which validates them, gives the invoice an Invoice Reference Number (IRN), signs it and adds a QR code."),
      p(runs("The rule behind it is Rule 48(4) of the CGST Rules, and the invoice is reported in the format of FORM GST INV-01. An invoice that a business required to e-invoice issues any other way is not treated as a valid invoice, according to the ", ["e-invoice portal's FAQ", SRC.einvoiceFaq], ".")),
    ]),
    part("einv-who", "Who must issue e-invoices?", [
      p(runs("A business must e-invoice when its aggregate turnover, counted on its PAN, has exceeded ₹5 crore in any financial year since 2017-18. That threshold has applied since 1 August 2023, when it came down from ₹10 crore, according to the ", ["GST e-invoice overview", SRC.einvoiceOverview], ".")),
      p(runs("Some categories are exempt whatever their turnover. The ", ["e-invoice exemption manual", SRC.einvoiceExempt], " lists them, each with its notification:")),
      ul(
        "SEZ units (SEZ developers are not exempt)",
        "Insurers, banking companies, financial institutions and NBFCs",
        "Goods transport agencies carrying goods by road",
        "Suppliers of passenger transport services",
        "Admission to films shown on multiplex screens",
        "Government departments and local authorities",
      ),
      p("The exemption belongs to the business, not to a transaction. A business that is not exempt must e-invoice every supply the rules cover."),
    ]),
    part("einv-which", "Which documents need an IRN?", [
      p("Invoices, credit notes and debit notes need an IRN when they are for supplies to registered businesses, to SEZs, for exports or as deemed exports. Supplies to consumers do not, and neither do bills of supply."),
      table(
        ["Document or supply", "IRN needed?"],
        [
          ["Tax invoice to a registered business (B2B)", "Yes"],
          ["Supply to an SEZ, with or without payment of tax", "Yes"],
          ["Export, with or without payment of tax, and deemed exports", "Yes"],
          ["Credit note or debit note under section 34", "Yes"],
          ["Invoice to a consumer (B2C)", "No: not allowed at present"],
          ["Bill of supply for exempt or nil-rated goods", "No"],
          ["Import bill of entry, or an ISD invoice", "No"],
        ],
      ),
      p(runs("A financial or commercial credit note that doesn't change the tax is not reported. See the applicability section of the ", ["e-invoice FAQ", SRC.einvoiceFaq], ".")),
    ]),
    part("einv-how", "How is an IRN generated?", [
      p("IRN generation takes four steps, and only the supplier can do it, not the buyer or the transporter."),
      ol(
        "Create the invoice in your billing or accounting software, as you do today.",
        "Your software sends the invoice to an IRP as JSON in the INV-01 format.",
        "The IRP validates it, generates the IRN, a 64-character hash of the supplier's GSTIN, financial year, document type and number, and signs the invoice.",
        "The signed invoice and its QR code come back; the QR code is printed on the invoice you send.",
      ),
      p(runs("Several IRPs are authorised, run by NIC and by private providers, and all are free to use. The same invoice can have only one valid IRN, so a second upload to another IRP is rejected; see the ", ["list of IRPs and their services", SRC.irps], ". The ", ["e-invoice user manual", SRC.einvoiceManual], " sets out what the QR code carries.")),
    ]),
    part("einv-time", "What is the time limit for reporting an e-invoice?", [
      p(runs("From 1 April 2025, a business with an aggregate turnover of ₹10 crore or more cannot report an invoice, credit note or debit note to the IRP more than 30 days after its date. The IRP blocks late reporting, as announced on the ", ["GST portal", SRC.gstPortal], ".")),
      p("For example, an invoice dated 1 April 2025 could not be reported after 30 April 2025. Businesses below ₹10 crore have no such limit at present, but reporting on the day the invoice is issued avoids the question."),
      p(runs("Signing in to the e-invoice and e-way bill systems also needs two-factor authentication for every taxpayer since 1 April 2025, as the ", ["e-way bill portal", SRC.ewbPortal], " notes.")),
    ]),
    part("einv-cancel", "Can an e-invoice be cancelled or amended?", [
      p("An IRN can be cancelled only within 24 hours of being generated, and only in full. It cannot be cancelled while an e-way bill linked to it is active, or once an officer has verified that e-way bill."),
      ul(
        "A cancelled invoice's number cannot be used again for another invoice.",
        "There are no part-cancellations: issue a credit note instead.",
        "Amendments aren't made on the IRP; they go through GSTR-1.",
      ),
    ]),
    part("einv-mistakes", "Common e-invoicing mistakes", [
      p("Most e-invoicing problems come from a handful of habits that are easy to fix once they are known."),
      ul(
        runs("Too few HSN digits: six digits are required above ₹5 crore of turnover, as the ", ["GSTN advisory on HSN", SRC.hsn], " sets out."),
        "Reporting late: a business at ₹10 crore or more loses the invoice's IRN after 30 days.",
        "Numbering by case: invoice numbers are converted to capitals before an IRN is generated, since 1 June 2025, so INV-1a and INV-1A are the same number.",
        "Reusing a cancelled number for a new invoice.",
        "Trying to e-invoice a consumer invoice, which the IRP does not accept at present.",
      ),
    ]),
    part("einv-product", "How {siteName} handles e-invoices", [
      p(runs("In ", ["{siteName}'s quotes and invoices", "/product/quotes-invoices"], ", the IRN and signed QR code are generated when a tax invoice or credit note is issued, and printed on it. An IRN can be cancelled within the 24 hours with the portal's reasons, and an e-way bill can be raised from the same invoice.")),
      p("Each GSTIN has its own API credentials and a minimum invoice value for e-invoicing. {siteName} connects to NIC's e-invoice API directly, without a GST Suvidha Provider, and each GSTIN starts in a test mode, so the flow can be tried before it is switched to NIC's sandbox or production system."),
    ]),
    faq("einv-faq", "E-invoicing questions", [
      ["Do I need an e-way bill if the invoice has an IRN?", "Yes, when the goods need one. An e-way bill can be generated with the IRN if the transport details are sent, or added afterwards on the IRP or the e-way bill portal."],
      ["Can I choose which IRP to use?", "Yes. Any authorised IRP can register your invoices, and all are free. An invoice registered on one can't be registered again on another."],
      ["Is e-invoicing required for invoices to consumers?", "Not at present. The e-invoice FAQ says reporting B2C invoices is not applicable or allowed today. Check the current notification, as the rules are reviewed from time to time."],
    ]),
    related("einv-related", "Read next", ["/blog/e-way-bill-rules", "/resources/glossary", "/product/quotes-invoices", "/product/multi-branch-gst"]),
    cta("einv-cta", "Issue GST invoices with their IRN", "Set up a workspace and try the e-invoice flow in test mode. Every workspace starts with a {trialDays}-day free trial."),
  ],
};

// ─── 2. E-way bills ──────────────────────────────────────────────────────────────────────────────

const eway: SeedPost = {
  slug: "e-way-bill-rules",
  title: "E-way bill rules: when you need one, and how long it lasts",
  excerpt:
    "E-way bill rules are the GST rules that decide when goods on the move need an electronic e-way bill, who raises it, and how long it stays valid. This guide covers the ₹50,000 threshold, Part A and Part B, validity by distance, extension, cancellation and the 2025 changes.",
  seo: {
    title: "E-way bill rules: limits, validity and Part B",
    description: "E-way bill rules explained: the ₹50,000 threshold, who generates it, Part A and Part B, validity of one day per 200 km, extension and cancellation.",
    keywords: ["e-way bill rules", "e-way bill validity", "Part B of e-way bill"],
  },
  categories: ["guides"],
  body: [
    reviewed("ewb-reviewed", "Limits and rules change by notification: check the e-way bill portal before you rely on a figure."),
    part("ewb-what", "What is an e-way bill?", [
      p("An e-way bill is an electronic document generated on the government's e-way bill portal for goods being moved. It records what is moving, between whom, and in which vehicle, and an officer can check it on the road."),
      p(runs("The requirement comes from section 68 of the CGST Act and Rule 138 of the CGST Rules. An e-way bill is still needed when the invoice has an e-invoice IRN, as the ", ["e-invoice FAQ", SRC.einvoiceFaq], " confirms.")),
    ]),
    part("ewb-when", "When is an e-way bill needed?", [
      p(runs("An e-way bill is needed to move goods whose consignment value is more than ₹50,000, according to the ", ["e-way bill portal", SRC.ewbPortal], ". That covers a sale, a movement for another reason, such as a return, and an inward supply from an unregistered person.")),
      ul(
        "Goods moved for job work, and handicraft goods, need one even below ₹50,000.",
        runs("For movement within a state, each state or union territory may set its own threshold, which the ", ["e-way bill FAQ", SRC.ewbFaq], " refers to."),
        "An e-way bill is for goods: a bill carrying only service (SAC) codes can't generate one.",
      ),
    ]),
    part("ewb-who", "Who generates the e-way bill?", [
      p("The registered supplier or the registered recipient generates it, or the transporter does on their behalf. A transporter who isn't registered for GST first enrols on the portal."),
      p("The other party can reject an e-way bill within 72 hours of its generation, or before delivery if that is earlier. If they don't, it is treated as accepted."),
    ]),
    part("ewb-parts", "What are Part A and Part B?", [
      p("Part A of an e-way bill holds the document details: the invoice or challan, the parties, the goods and their value. Part B holds the transport details: the vehicle number, or the transport document number."),
      p("Until Part B is filled in, the portal gives only a Part-A slip, and the goods can't move on it. Part B can be left out only when goods move less than 50 km within a state between the supplier or recipient and the transporter's place."),
    ]),
    part("ewb-validity", "How long is an e-way bill valid?", [
      p(runs("E-way bill validity depends on the distance. For normal cargo, it is one day for every 200 km of the journey, or part of it. For over-dimensional cargo it is one day for every 20 km, according to the ", ["e-way bill FAQ", SRC.ewbFaq], ".")),
      table(
        ["Journey", "Normal cargo", "Over-dimensional cargo"],
        [
          ["Up to 200 km", "1 day", "10 days"],
          ["201 to 400 km", "2 days", "20 days"],
          ["401 to 600 km", "3 days", "30 days"],
        ],
      ),
      p("Validity runs from the time Part B is first entered, and it expires at midnight on its last day. Plan long journeys so the goods arrive, or the bill is extended, before then."),
    ]),
    part("ewb-extend", "Can an e-way bill be extended or cancelled?", [
      p("The transporter carrying the goods can extend an e-way bill from eight hours before to eight hours after it expires, for reasons such as a natural calamity or transshipment. The extension is worked out from the distance still to travel."),
      ul(
        "Cancellation: the generator can cancel an e-way bill within 24 hours, unless an officer has already verified it.",
        runs("Since 1 January 2025, an e-way bill can be generated only for documents dated within the last 180 days, and its total extension is capped at 360 days from generation, as ", ["GSTN's advisory on the GST portal", SRC.gstPortal], " announced."),
        "Since 1 April 2025, signing in needs two-factor authentication for every taxpayer and transporter.",
      ),
    ]),
    part("ewb-product", "How {siteName} handles e-way bills", [
      p(runs("In ", ["{siteName}'s quotes and invoices", "/product/quotes-invoices"], ", an e-way bill is raised from a tax invoice, a credit note or a delivery challan. Part B is updated with the vehicle and a reason code, and the bill can be cancelled within 24 hours. A bill raised on the portal itself can be looked up and attached.")),
      p(runs("Validity is worked out at one day per 200 km, or 20 km for over-dimensional cargo. The value threshold is set for each GSTIN, and ", ["IT asset consignments", "/product/assets"], " flag when a movement needs one. Extensions are made on the portal: {siteName} prompts you to extend the bill there or raise a new one.")),
    ]),
    faq("ewb-faq", "E-way bill questions", [
      ["What happens if the vehicle changes on the way?", "Update Part B with the new vehicle number before the goods move on. The e-way bill stays the same; its transport details change."],
      ["Can the buyer generate the e-way bill?", "Yes. A registered recipient can generate it, as can the supplier or the transporter on their behalf."],
      ["Does an e-way bill need an e-invoice first?", "No. Businesses that e-invoice can generate the e-way bill with the IRN, but any business moving goods over the threshold needs an e-way bill."],
    ]),
    related("ewb-related", "Read next", ["/blog/e-invoicing-under-gst", "/resources/glossary", "/product/quotes-invoices", "/solutions/trading-distribution"]),
    cta("ewb-cta", "Raise the e-way bill from the invoice", "Set up a workspace and try e-way bills in test mode. Every workspace starts with a {trialDays}-day free trial."),
  ],
};

// ─── 3. TDS ──────────────────────────────────────────────────────────────────────────────────────

const tdsSource = runs("Source: the ", ["TDS rates chart for tax year 2026-27", SRC.tdsRates], " and section 393 of the ", ["Income-tax Act, 2025", SRC.itAct], ". The old section numbers are given for reference.");

const tds: SeedPost = {
  slug: "tds-on-business-payments",
  title: "TDS on business payments: the basics under the Income-tax Act, 2025",
  excerpt:
    "TDS on business payments is the income tax a business deducts when it pays a contractor, a professional, a landlord or a supplier, and deposits with the government. This guide covers the new Act's section 393, the common rates and thresholds, deposit dates and quarterly statements.",
  seo: {
    title: "TDS on business payments: the basics",
    description: "TDS on business payments under the Income-tax Act, 2025: section 393, rates for contractors, professionals, rent and goods, and TDS return due dates.",
    keywords: ["TDS on business payments", "TDS rates for businesses", "TDS return due dates"],
  },
  categories: ["guides"],
  body: [
    reviewed("tds-reviewed", "This guide is a summary, not tax advice. Rates and thresholds change in each Finance Act: check the current rates chart before you deduct."),
    part("tds-what", "What is TDS on business payments?", [
      p("TDS, tax deducted at source, is income tax the payer deducts from certain payments and deposits with the government on the payee's behalf. The payee then claims it against their own tax. A business deducts TDS on payments such as contractors' bills, professional fees, commission and rent."),
      p("To deduct TDS, a business needs a TAN, a ten-character tax deduction and collection account number, quoted on every payment and statement."),
    ]),
    part("tds-act", "What changed with the Income-tax Act, 2025?", [
      p(runs("The Income-tax Act, 2025 came into force on 1 April 2026 and replaced the Income-tax Act, 1961, according to ", ["its text on incometaxindia.gov.in", SRC.itAct], ". The old Act still applies to tax years that began before that date.")),
      ul(
        "Section 392 covers TDS on salary.",
        "Section 393 covers everything else, in tables: payments to residents, payments to non-residents, and other cases.",
        runs("The forms have new numbers under the Income-tax Rules, 2026: the quarterly non-salary TDS statement is Form 140, which replaced Form 26Q, and the certificate to the payee is Form 131, which replaced Form 16A. See the ", ["guide to the new forms", SRC.itForms], "."),
        runs("A TAN is now applied for in Form 135 (Form 134 for government deductors), as the ", ["TAN page", SRC.tan], " explains."),
      ),
    ]),
    part("tds-rates", "What are the TDS rates for businesses?", [
      p("For payments to residents, the common items for a business are these. Each row applies above its threshold, and the rate depends on the payee."),
      table(
        ["Payment (old section)", "Rate", "Threshold"],
        [
          ["Contractors (194C)", "1% to an individual or HUF, 2% to others", "₹30,000 a payment, or ₹1,00,000 in a year"],
          ["Professional or technical fees (194J)", "10%; 2% for technical services, call centres and film royalties", "₹50,000 in a year"],
          ["Commission or brokerage (194H)", "2%", "₹20,000 in a year"],
          ["Rent of land, building or furniture (194-I)", "10%", "₹50,000 a month or part of a month"],
          ["Rent of plant, machinery or equipment (194-I)", "2%", "₹50,000 a month or part of a month"],
          ["Purchase of goods (194Q)", "0.1% of the amount above ₹50 lakh", "When the buyer's turnover last year exceeded ₹10 crore"],
        ],
      ),
      p(tdsSource),
      p("Where the payee has no PAN, tax is deducted at the higher of the applicable rate and 20%, or 5% for purchases of goods, under section 397(2)."),
    ]),
    part("tds-deposit", "When is TDS deposited?", [
      p(runs("TDS deducted in April to February is deposited within seven days of the end of the month. TDS deducted in March is deposited by 30 April. Some items, such as rent paid by individuals, allow 30 days; see the ", ["interest and due dates page", SRC.tdsInterest], ".")),
      ul(
        "Interest of 1% a month runs when tax that should have been deducted wasn't.",
        "Interest of 1.5% a month runs when tax was deducted but deposited late.",
        "Both are under section 398(3) of the new Act.",
      ),
    ]),
    part("tds-returns", "What are the TDS return due dates?", [
      p(runs("The quarterly TDS statement for tax year 2026-27 is due on 31 July, 31 October, 31 January and 31 May, for the four quarters in turn. Filing late costs a fee of ₹200 a day under section 427, up to the TDS amount, as the ", ["late fee page", SRC.tdsLateFee], " explains.")),
      table(
        ["Quarter", "Months", "Statement due"],
        [
          ["Q1", "April to June", "31 July"],
          ["Q2", "July to September", "31 October"],
          ["Q3", "October to December", "31 January"],
          ["Q4", "January to March", "31 May"],
        ],
      ),
      p("A penalty of ₹10,000 to ₹1,00,000 can also apply under section 461. It isn't charged if the statement is filed within a month of the due date, after the tax, fee and interest are paid. The payee's certificate, Form 131, follows each statement."),
    ]),
    part("tds-product", "How {siteName} helps with TDS", [
      p(runs("In ", ["{siteName}'s accounting", "/product/accounting-gst"], ", each vendor bill or invoice can carry TDS or TCS with its section and rate. Issuing a bill with TDS posts the deduction to TDS payable, and a customer's deduction from your invoice posts to TDS receivable.")),
      p("A monthly TDS page lists the tax deducted from vendors, due by the seventh of the next month, and warns when it is overdue or a party has no PAN. {siteName} doesn't hold a rate table or thresholds, and it doesn't prepare Form 140 or Form 131: file the statement with your TDS software or on the e-filing portal."),
    ]),
    faq("tds-faq", "TDS questions", [
      ["Do the old section numbers still matter?", "For tax years that began before 1 April 2026, yes: the Income-tax Act, 1961 still applies to them. For the current tax year, use the new Act's sections and forms."],
      ["What is the threshold for TDS on professional fees?", "₹50,000 in a year, for professional or technical fees paid to a resident. Check the current rates chart, as thresholds change in each Finance Act."],
      ["What happens if TDS is deposited late?", "Interest of 1.5% a month runs on tax deducted but not deposited on time, according to the income tax site, and a late statement adds a fee of ₹200 a day."],
    ]),
    related("tds-related", "Read next", ["/resources/glossary", "/blog/month-end-close-checklist", "/product/accounting-gst", "/solutions/finance-teams"]),
    cta("tds-cta", "Keep TDS in the same books as the bills", "Set up a workspace and record this month's vendor bills with their TDS. Every workspace starts with a {trialDays}-day free trial."),
  ],
};

// ─── 4. Month-end close ──────────────────────────────────────────────────────────────────────────

const close: SeedPost = {
  slug: "month-end-close-checklist",
  title: "A month-end close checklist for Indian companies",
  excerpt:
    "A month-end close checklist is the list of tasks that finish a month's books before the period is locked: reconciliations, accruals, revenue, depreciation, payroll, GST and TDS, and a review of what moved. This guide sets the tasks out in order, with why each matters.",
  seo: {
    title: "Month-end close checklist, step by step",
    description: "A month-end close checklist for Indian companies: reconciliations, accruals, revenue, depreciation, payroll, GST and TDS, a flux review, and locking the period.",
    keywords: ["month-end close checklist", "close the books", "bank reconciliation"],
  },
  categories: ["guides"],
  body: [
    reviewed("close-reviewed", "Due dates for GST and TDS change by notification: check the GST portal and the income tax site for the current ones."),
    part("close-what", "What is a month-end close?", [
      p("A month-end close is the work that turns a month's transactions into books you can rely on. Everything that belongs to the month is recorded, everything recorded is checked, and then you close the books: the period is locked so its figures can't change afterwards."),
      p("A good month-end close checklist puts the tasks in an order where each one can rely on the one before. Reconciliations come first, because every later figure reads the ledger they check."),
    ]),
    part("close-checklist", "The month-end close checklist", [
      p("Work through these tasks in order, and give each one an owner and a due date."),
      ol(
        "Stop the month: make sure every invoice, credit note and vendor bill dated in the month is entered, and no drafts are left.",
        "Reconcile each bank account to the statement at month end, and post bank charges and interest.",
        "Allocate every customer payment and every vendor payment to its invoices or bills.",
        "Post the month's accruals, such as unbilled services and utilities, and amortise prepaid expenses.",
        "Recognise the month's deferred revenue for subscriptions and services.",
        "Run depreciation on the fixed asset register.",
        "Lock the month's payroll and post the salary journal.",
        "Post approved expense claims.",
        "Tie receivables and payables ageing to the ledger.",
        "Prepare GSTR-1 and GSTR-3B, and reconcile TDS deducted with TDS deposited.",
        "Review the large movements against last month and last year, and explain them.",
        "Lock the period.",
      ),
    ]),
    part("close-reconcile", "Why do reconciliations come first?", [
      p("Reconciliations come first because they prove the ledger matches the outside world. A bank reconciliation compares the bank's statement with the bank account in your books, line by line, and explains every difference."),
      table(
        ["Reconciliation", "What it proves"],
        [
          ["Bank account to bank statement", "Every receipt and payment in the bank is in the books, and nothing extra"],
          ["Receivables ageing to the ledger", "What customers owe, invoice by invoice, adds up to the receivables account"],
          ["Payables ageing to the ledger", "What you owe vendors, bill by bill, adds up to the payables account"],
          ["TDS deducted to TDS deposited", "Tax deducted in the month has been, or will be, paid on time"],
        ],
      ),
      p("When an ageing doesn't agree with the ledger, the usual causes are a journal posted by hand to the control account, a payment not allocated to an invoice, or a line with no customer or vendor on it."),
    ]),
    part("close-tax", "Which tax deadlines fall in the close?", [
      p(runs("GST and TDS deadlines fall in the first weeks of the next month, so they shape the close. TDS deducted in a month is deposited within seven days of its end, according to the ", ["income tax site", SRC.tdsInterest], ".")),
      ul(
        runs("GSTR-1 is due on the 11th for monthly filers, and the 13th for quarterly ones, as the ", ["GSTR-1 guide", SRC.gstr1], " shows."),
        runs("GSTR-3B is due on the 20th for monthly filers, with later dates for quarterly filers, as the ", ["GSTR-3B guide", SRC.gstr3b], " shows."),
        "Plan the close so the books are final before the returns are filed, and lock the period once they are.",
      ),
    ]),
    part("close-review", "What does the review at the end look for?", [
      p("The review looks for movements that nobody can explain. Flux analysis compares each account's balance or movement with last month and the same month last year, and asks for a reason where the change passes a threshold you set."),
      p("An unexplained movement is often a posting to the wrong account or the wrong month. It is cheaper to find it now than after the period is locked and the returns are filed."),
    ]),
    part("close-product", "How {siteName} runs the month-end close", [
      p(runs("With ", ["{siteName}'s Revenue & Close", "/product/revenue-close"], ", a workspace starts with a close checklist of 14 tasks, due on the third working day of the next month, each with an owner and reminders. Eleven of them check themselves.")),
      ul("Bank accounts reconciled, and no draft invoices left", "Revenue recognised, prepaids and accruals posted", "Depreciation run, payroll and expense claims posted", "Receivables and payables ageing tied to the ledger"),
      p("Large movements are flagged against last month and last year, and each needs an explanation. Months close in order, and an open task blocks the close unless someone writes down why. Closing moves the books lock, so nothing dated in the month can be posted afterwards."),
    ]),
    faq("close-faq", "Month-end close questions", [
      ["What is the difference between a month-end close and a year-end close?", "A month-end close locks one month. A year-end close also moves the year's profit into retained earnings and starts the new year's income and expense accounts at zero."],
      ["Can a closed month be reopened?", "In most systems, yes, by someone with the right permission. In {siteName}, reopening a month also reopens every month after it, and the change is logged."],
      ["Who should own the checklist?", "One person should own the close as a whole, with each task given its own owner, so every step has someone who answers for it."],
    ]),
    related("close-related", "Read next", ["/blog/revenue-recognition-ind-as-115", "/blog/tds-on-business-payments", "/product/revenue-close", "/product/accounting-gst"]),
    cta("close-cta", "Close the month with a checklist that checks itself", "Revenue & Close is offered to companies in India. Book a demo to see the close checklist with your own data."),
  ],
};

// ─── 5. Revenue recognition ──────────────────────────────────────────────────────────────────────

const revenue: SeedPost = {
  slug: "revenue-recognition-ind-as-115",
  title: "Ind AS 115 revenue recognition for subscriptions",
  excerpt:
    "Ind AS 115 revenue recognition means recording revenue as the goods or services promised to a customer are delivered, not when they are invoiced. For a subscription paid in advance, that means deferred revenue that moves into sales month by month. This guide explains the rules and a worked example.",
  seo: {
    title: "Ind AS 115 revenue recognition for SaaS",
    description: "Ind AS 115 revenue recognition for subscriptions: who applies it, the five steps, performance obligations, deferred revenue and a worked example.",
    keywords: ["Ind AS 115 revenue recognition", "deferred revenue for subscriptions", "performance obligations"],
  },
  categories: ["guides"],
  body: [
    reviewed("rev-reviewed", "This guide summarises the standard; it is not accounting advice. Your auditor decides how it applies to your contracts."),
    part("rev-what", "What is Ind AS 115?", [
      p(runs("Ind AS 115 is the Indian accounting standard for revenue from contracts with customers, in force for accounting periods beginning on or after 1 April 2018. Its core principle is that revenue shows the transfer of goods or services at the amount the company expects to be entitled to; see the ", ["standard's text from ICAI", SRC.indAs115], ".")),
      p("For a subscription business, the effect is simple to state. An annual subscription invoiced in April is not April's revenue: it is earned across the twelve months the service is provided."),
    ]),
    part("rev-who", "Who has to apply Ind AS 115?", [
      p(runs("Companies that follow Indian Accounting Standards apply Ind AS 115, as ICAI's summary of the ", ["Companies (Indian Accounting Standards) Rules, 2015", SRC.indAsApplicability], " sets out. Others follow the Accounting Standards, where AS 9 covers revenue.")),
      ul(
        "From 1 April 2016: companies with a net worth of ₹500 crore or more, and their group companies.",
        "From 1 April 2017: other listed companies, and unlisted companies with a net worth of ₹250 crore to ₹500 crore, and their group companies.",
        runs("Other companies: the Companies (Accounting Standards) Rules, with ", ["AS 9 Revenue Recognition", SRC.as9], "."),
      ),
    ]),
    part("rev-steps", "What are the five steps of Ind AS 115?", [
      p(runs("The standard works through five steps, each set out in its own paragraphs of the ", ["Ind AS 115 text", SRC.indAs115], ".")),
      ol(
        "Identify the contract with the customer (paragraph 9).",
        "Identify the performance obligations: the distinct goods or services promised (paragraph 22).",
        "Determine the transaction price (paragraph 47).",
        "Allocate the price to the obligations, by their relative stand-alone selling prices (paragraphs 73 and 74).",
        "Recognise revenue when, or as, each obligation is satisfied (paragraph 31).",
      ),
    ]),
    part("rev-time", "Is a subscription recognised over time or at a point in time?", [
      p(runs("A subscription to a service the customer uses as it is provided is usually satisfied over time, because the customer receives and consumes the benefit as the company performs. The criteria are in paragraph 35 of the ", ["standard", SRC.indAs115], "; an obligation that meets none of them is satisfied at a point in time.")),
      p("A one-off sale of goods, or a perpetual licence delivered on day one, is usually recognised when control passes. The decision is made when the contract starts, not month by month."),
    ]),
    part("rev-example", "A worked example: an annual subscription", [
      p("A customer buys a twelve-month subscription for ₹1,20,000, starting on 1 April and invoiced in full that day. Revenue of ₹10,000 is recognised each month, and the rest sits in deferred revenue until it is earned."),
      table(
        ["Month end", "Revenue recognised in the month", "Revenue recognised to date", "Deferred revenue left"],
        [
          ["30 April", "₹10,000", "₹10,000", "₹1,10,000"],
          ["30 June", "₹10,000", "₹30,000", "₹90,000"],
          ["30 September", "₹10,000", "₹60,000", "₹60,000"],
          ["31 March", "₹10,000", "₹1,20,000", "₹0"],
        ],
      ),
      p("If the customer adds seats in October for the rest of the term, the add-on is recognised over its own months, from October to March. A credit note for a downgrade reduces what is still to be recognised."),
    ]),
    part("rev-balance", "Where does deferred revenue sit on the balance sheet?", [
      p(runs("Deferred revenue for subscriptions is a contract liability: an obligation to deliver service the customer has already paid for, or been invoiced for. Paragraphs 105 to 108 of the ", ["standard", SRC.indAs115], " define contract liabilities, contract assets and receivables.")),
      p("A contract asset is the opposite case: service delivered but not yet billable, such as work done before a milestone invoice. Companies may use other descriptions on the balance sheet, such as deferred revenue."),
    ]),
    part("rev-product", "How {siteName} recognises subscription revenue", [
      p(runs("With ", ["{siteName}'s Revenue & Close", "/product/revenue-close"], ", an invoice line whose service runs past the month of issue waits in deferred revenue and moves into sales month by month, spread by day or evenly by month. A milestone's revenue is recognised in the month it is delivered. A revenue waterfall shows what is still to come.")),
      p("Recognition follows each issued invoice line, not a contract model: prices are not re-allocated by stand-alone selling price, and unbilled revenue is not booked as a contract asset. A second person approves any schedule changed by hand."),
    ]),
    faq("rev-faq", "Revenue recognition questions", [
      ["Is a one-time setup fee recognised at once?", "It depends on whether the setup is a distinct service. When it isn't distinct from the subscription, it is usually recognised over the subscription's term. Ask your auditor about your own contracts."],
      ["Does Ind AS 115 apply to a small private company?", "Only if the company follows Indian Accounting Standards. A company that doesn't applies AS 9 Revenue Recognition, under the Companies (Accounting Standards) Rules."],
      ["What happens to deferred revenue if the customer cancels?", "The unearned part is reversed with the credit note or refund, so the liability falls without ever passing through revenue."],
    ]),
    related("rev-related", "Read next", ["/blog/month-end-close-checklist", "/product/revenue-close", "/solutions/saas-subscriptions", "/resources/glossary"]),
    cta("rev-cta", "Recognise subscription revenue month by month", "Revenue & Close is offered to companies in India. Book a demo to see your own deferred revenue and waterfall."),
  ],
};

// ─── 6. PF, ESI and professional tax ─────────────────────────────────────────────────────────────

const payroll: SeedPost = {
  slug: "pf-esi-professional-tax-payroll",
  title: "PF, ESI and professional tax: a payroll guide for Indian employers",
  excerpt:
    "PF, ESI and professional tax are the three statutory deductions most Indian payrolls handle each month. This guide covers who they apply to, how contributions are worked out, the new PF wage ceiling of ₹25,000 from 17 September 2026, and when each is due.",
  seo: {
    title: "PF, ESI and professional tax in payroll",
    description: "PF, ESI and professional tax explained: the Code on Social Security, the new PF wage ceiling, ESI contribution rates, state slabs and due dates.",
    keywords: ["PF ESI and professional tax", "PF wage ceiling", "ESI contribution rates"],
  },
  categories: ["guides"],
  body: [
    reviewed("pay-reviewed", "Contribution rates, ceilings and state slabs change by notification. Check EPFO, ESIC and your state's notification before you rely on a figure."),
    part("pay-code", "What changed with the Code on Social Security?", [
      p(runs("The Code on Social Security, 2020 brought the PF, ESI and other social security laws into one code. Most of it came into force on 21 November 2025, according to the ", ["Ministry of Labour's notification", SRC.codesInForce], ".")),
      p(runs("The Code defines wages as basic pay, dearness allowance and retaining allowance. If the allowances it leaves out come to more than half of total pay, the excess is added back to wages; see section 2(88) of the ", ["Code", SRC.socialSecurityCode], ". PF and ESI are worked out on those wages.")),
    ]),
    part("pay-pf", "How is PF worked out?", [
      p(runs("PF is worked out as a share of wages, paid by both employee and employer each month. Establishments with twenty or more employees must register with EPFO. The contribution rates are in the ", ["EPFO wage ceiling FAQ", SRC.epfCeilingFaq], ".")),
      table(
        ["Contribution", "Rate of wages", "Paid by"],
        [
          ["Employees' Provident Fund (employee's share)", "12%", "Employee"],
          ["Employees' Pension Scheme (EPS)", "8.33%", "Employer"],
          ["Employees' Provident Fund (employer's balance)", "3.67%", "Employer"],
          ["EDLI insurance", "0.5%", "Employer"],
          ["Administrative charges", "0.5%, at least ₹500 a month", "Employer"],
        ],
      ),
      p("Each member has a UAN, a twelve-digit Universal Account Number that stays with them across jobs."),
    ]),
    part("pay-ceiling", "What is the PF wage ceiling?", [
      p(runs("The PF wage ceiling rose from ₹15,000 to ₹25,000 a month from 17 September 2026, by notification S.O. 5109(E), according to ", ["EPFO's circular", SRC.epfCeilingCircular], ". The ceiling is tested on wages as the Code defines them.")),
      p(runs("For September 2026, contributions are split between 1 to 16 September and 17 to 30 September, and filed in a single ECR, as the ", ["EPFO FAQ", SRC.epfCeilingFaq], " explains. The ECR and payment for a month are due by the 15th of the next month.")),
    ]),
    part("pay-esi", "Who is covered by ESI?", [
      p(runs("ESI covers employees earning up to ₹21,000 a month, or ₹25,000 for persons with disability, in factories with ten or more people and in notified shops and establishments, according to ", ["ESIC's coverage page", SRC.esicCoverage], ".")),
      table(
        ["ESI item", "Rule"],
        [
          ["Employee's contribution", "0.75% of wages, since 1 July 2019"],
          ["Employer's contribution", "3.25% of wages, since 1 July 2019"],
          ["Low earners", "No employee share when the daily average wage is up to ₹176"],
          ["Due date", "Within 15 days of the end of the calendar month"],
          ["Contribution periods", "April to September, and October to March"],
        ],
      ),
      p(runs("The ESI contribution rates and periods are from ", ["ESIC's contribution page", SRC.esicContribution], ". We found no change to the ESI wage limit in ESIC's circulars up to the date this guide was reviewed.")),
    ]),
    part("pay-pt", "What is professional tax?", [
      p("Professional tax is a tax some states levy on salaried employment. The employer deducts it from salary each month by the state's slabs and pays it to the state."),
      ul(
        "Each state sets its own slabs and due dates, and some states levy none.",
        "An employee's state is usually decided by where they work, which matters for a company with branches in several states.",
        runs("Professional tax paid is deductible from salary income under section 19 of the ", ["Income-tax Act, 2025", SRC.itAct], "."),
      ),
    ]),
    part("pay-calendar", "What is due each month?", [
      p("A payroll team's statutory month has a few fixed points. Put them in the calendar before the first payroll of the year."),
      table(
        ["Date", "What is due"],
        [
          ["7th", "TDS deducted from salaries in the previous month"],
          ["15th", "PF: the ECR and payment for the previous month"],
          ["15th", "ESI: contributions for the previous month"],
          ["By the state's date", "Professional tax, by each state's rules"],
        ],
      ),
    ]),
    part("pay-product", "How {siteName} handles PF, ESI and professional tax", [
      p(runs("In ", ["{siteName}'s payroll", "/product/payroll"], ", each payslip works out PF on basic, with the employer's share split between EPS and EPF, ESI while gross pay is within ₹21,000, and professional tax by the slabs of Maharashtra, Karnataka, West Bengal, Tamil Nadu, Telangana and Gujarat. Locking the run posts PF, ESI and PT payable to the ledger.")),
      p("PF wages are capped at the ceiling in force for the month: ₹25,000 from 17 September 2026. September 2026 is split by days, as EPFO's FAQ describes: 1 to 16 September at ₹15,000 and 17 to 30 September at ₹25,000. A payslip flags anyone outside PF whose basic the higher ceiling now covers. {siteName} doesn't produce the ECR file or ESI challans: file them on the EPFO and ESIC portals."),
    ]),
    faq("pay-faq", "Payroll deduction questions", [
      ["Does PF apply to a company with fewer than twenty employees?", "Registration becomes mandatory at twenty employees. Below that, check EPFO's rules on voluntary coverage."],
      ["Does an employee earning above ₹21,000 pay ESI?", "Employees above the wage limit are outside ESI. The limit is applied with the contribution periods, so check ESIC's rules for someone whose pay rises during a period."],
      ["Which state's professional tax applies?", "Usually the state where the employee works. A company with branches in several states deducts by each branch's state."],
    ]),
    related("pay-related", "Read next", ["/product/payroll", "/solutions/hr-teams", "/resources/glossary", "/blog/tds-on-business-payments"]),
    cta("pay-cta", "Run payroll from attendance and leave", "Payroll is offered to companies in India. Set up a workspace and try a payroll run during the {trialDays}-day free trial."),
  ],
};

export const section: SeedSection = { name: "Guides", categories: [GUIDES], posts: [einvoicing, eway, tds, close, revenue, payroll] };

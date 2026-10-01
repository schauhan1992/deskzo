import type { RichNode, SiteBlock } from "../../src/components/site/blocks/types";
import { h3, p, related, runs, ul } from "./_build";
import type { SeedPage } from "./types";

/**
 * /resources/glossary: GST, income tax, payroll, accounting, revenue and sales terms, each a
 * question-shaped H3 with a short, answer-first definition. Regulatory terms link their official
 * source (cbic-gst.gov.in, gst.gov.in, einvoice.gst.gov.in, ewaybillgst.gov.in,
 * incometaxindia.gov.in, epfindia.gov.in / epfo.gov.in, esic.gov.in, icai.org), read on the date
 * below. Where a figure changes by notification, the text says so rather than guessing.
 */

export const GLOSSARY_REVIEWED = "30 September 2026";

const SRC = {
  cbicFaq: "https://cbic-gst.gov.in/faq.html",
  gstr1: "https://tutorial.gst.gov.in/userguide/returns/GSTR_1.htm",
  gstr3b: "https://tutorial.gst.gov.in/userguide/returns/GSTR3B.htm",
  gstr2b: "https://tutorial.gst.gov.in/userguide/returns/FAQ_gstr2b.htm",
  ims: "https://tutorial.gst.gov.in/userguide/returns/FAQ_IMS_Dashboard.htm",
  gstr9: "https://tutorial.gst.gov.in/userguide/returns/FAQs_gstr9.htm",
  composition: "https://tutorial.gst.gov.in/userguide/registration/Opt_for_Composition_Scheme.htm",
  hsn: "https://tutorial.gst.gov.in/downloads/news/updated_advisory_hsn_table12_25042025.pdf",
  einvoiceFaq: "https://einvoice.gst.gov.in/faqs",
  einvoiceOverview: "https://tutorial.gst.gov.in/downloads/news/e_invoice_overview.pdf",
  ewbFaq: "https://ewaybillgst.gov.in/Staticpages/faq.aspx",
  itAct: "https://www.incometaxindia.gov.in/income-tax-act-2025",
  tdsRates: "https://www.incometaxindia.gov.in/w/tds-rates",
  tan: "https://www.incometaxindia.gov.in/w/tax-deduction-account-number-1",
  itForms: "https://www.incometaxindia.gov.in/faqs-and-guidance-notes-on-forms-as-per-income-tax-rules-2026",
  epfCeiling: "https://pmvbry-cdn.epfindia.gov.in/wp-content/uploads/2026/09/EPFO_Wage_Ceiling_FAQs.pdf",
  epfoFaq: "https://www.epfo.gov.in/faq-epfo/",
  esicContribution: "https://esic.gov.in/contribution",
  esicCoverage: "https://esic.gov.in/coverage",
  socialSecurityCode: "https://esic.gov.in/attachments/actfile/The_Code_on_Social_Security_2020_No_36_of_2020_1787043715.pdf",
  indAs115: "https://resource.cdn.icai.org/94042indas2025-26-115.pdf",
};

/** One term: its question, and its answer's paragraphs. */
const term = (question: string, ...answer: RichNode[]): RichNode[] => [h3(question), ...answer];

function group(id: string, heading: string, terms: RichNode[][]): SiteBlock {
  return { id, type: "richText", props: { anchor: id.replace(/^glossary-/, ""), heading, content: terms.flat() } };
}

const gstBasics = group("glossary-gst", "GST basics", [
  term("What is GST?", p(runs("GST, the goods and services tax, is India's tax on the supply of goods and services. Within a state it is charged as CGST and SGST; between states as IGST, as ", ["CBIC's GST FAQ", SRC.cbicFaq], " explains."))),
  term("What is a GSTIN?", p("A GSTIN is the GST identification number a business gets for each state it is registered in. It is built on the business's PAN, so one PAN can hold a registration in several states.")),
  term("What are CGST, SGST and IGST?", p("CGST and SGST are the central and state shares of GST, charged together when the supplier and the place of supply are in the same state. IGST is charged instead on supplies between states and on imports.")),
  term("What is the place of supply?", p("The place of supply is where a supply is treated as made for GST. Set against the supplier's state, it decides whether a sale carries CGST and SGST or IGST.")),
  term("What is a tax invoice?", p("A tax invoice is the document a registered supplier issues for a taxable supply, showing the GST charged. A supplier of exempt or nil-rated goods issues a bill of supply instead.")),
  term("What is a delivery challan?", p("A delivery challan is the document that goes with goods moved for a reason other than a sale, such as a job-work movement or goods sent on approval. It is not a tax invoice.")),
  term("What are credit notes and debit notes?", p("A credit note reduces the value, quantity or tax of an invoice already issued, for example after a return. A debit note increases it. Both refer back to the original invoice.")),
  term("What is reverse charge?", p("Reverse charge means the buyer, not the supplier, pays the GST on a supply. It applies to notified goods and services, and to some supplies from unregistered persons.")),
  term("What is the composition scheme?", p(runs("The composition scheme lets a small business pay GST at a flat rate on its turnover instead of charging tax on each invoice. It has turnover limits and exclusions, such as inter-state sales of goods; see the ", ["GST portal's guide to opting in", SRC.composition], ". Check the current limits before opting in."))),
  term("What are HSN and SAC codes?", p(runs("HSN codes classify goods, and SAC codes classify services, for GST. How many digits a return needs depends on turnover: four digits up to ₹5 crore and six above, as the ", ["GSTN advisory on HSN reporting", SRC.hsn], " states."))),
]);

const returns = group("glossary-returns", "GST returns and input tax credit", [
  term("What is input tax credit (ITC)?", p("Input tax credit is the GST a business paid on its purchases, set off against the GST it owes on its sales. Only credit the rules allow can be claimed, and it must appear in the supplier's filings.")),
  term("What is GSTR-1?", p(runs("GSTR-1 is the return of a business's outward supplies: its sales invoices, credit notes and debit notes. It is filed monthly, or quarterly by smaller taxpayers, as the ", ["GST portal's GSTR-1 guide", SRC.gstr1], " describes."))),
  term("What is GSTR-3B?", p(runs("GSTR-3B is the summary return in which a business declares its tax liability, claims input tax credit and pays the net tax. See the ", ["GSTR-3B guide on the GST portal", SRC.gstr3b], " for the current due dates."))),
  term("What is GSTR-2B?", p(runs("GSTR-2B is a read-only statement of the input tax credit available to a buyer, drafted from its suppliers' filings each month. It is the reference for claiming credit in GSTR-3B; see the ", ["GSTR-2B FAQ", SRC.gstr2b], "."))),
  term("What is the Invoice Management System (IMS)?", p(runs("The Invoice Management System is a GST portal facility where a buyer accepts, rejects or keeps pending the invoices its suppliers report. Its decisions feed GSTR-2B, as the ", ["IMS FAQ", SRC.ims], " explains."))),
  term("What is GSTR-9?", p(runs("GSTR-9 is the annual return of a regular GST taxpayer, bringing the year's monthly or quarterly returns together. Composition taxpayers file GSTR-9A instead; see the ", ["GSTR-9 FAQ", SRC.gstr9], "."))),
]);

const einvoicing = group("glossary-einvoicing", "E-invoicing and e-way bills", [
  term("What is an e-invoice?", p(runs("An e-invoice is a B2B invoice whose details are reported to a government Invoice Registration Portal, which validates it, signs it and returns an IRN. The supplier still makes the invoice in its own software; see the ", ["e-invoice FAQ", SRC.einvoiceFaq], "."))),
  term("What is an IRP?", p("An IRP, an Invoice Registration Portal, is the government-authorised portal that registers e-invoices. There are several; an invoice registered on one gets only one valid IRN.")),
  term("What is an IRN?", p("An IRN, the Invoice Reference Number, is the unique 64-character reference an IRP gives a registered e-invoice. It is made from the supplier's GSTIN, the financial year, the document type and number.")),
  term("What is the signed QR code on an e-invoice?", p("The signed QR code is the code the IRP adds to a registered e-invoice. It carries the key invoice details and the IRN, so an officer can check the invoice offline.")),
  term("Who must issue e-invoices?", p(runs("Businesses whose aggregate turnover exceeded ₹5 crore in any financial year since 2017-18 must e-invoice B2B supplies, unless their category is exempt, according to the ", ["GST e-invoice overview", SRC.einvoiceOverview], ". Check the current notification."))),
  term("What is an e-way bill?", p(runs("An e-way bill is the electronic document needed to move goods worth more than ₹50,000, generated on the e-way bill portal. States may set their own limit for movement within the state; see the ", ["e-way bill FAQ", SRC.ewbFaq], "."))),
  term("What are Part A and Part B of an e-way bill?", p("Part A holds the invoice or document details, and Part B the vehicle or transport document. The e-way bill is complete only when Part B is filled in.")),
]);

const incomeTax = group("glossary-income-tax", "Income tax and TDS", [
  term("What is the Income-tax Act, 2025?", p(runs("The Income-tax Act, 2025 is the law that replaced the Income-tax Act, 1961 from 1 April 2026. Its TDS rules are in sections 392 and 393; the ", ["Act on incometaxindia.gov.in", SRC.itAct], " has the text."))),
  term("What is TDS?", p(runs("TDS, tax deducted at source, is income tax the payer deducts from a payment, such as a contractor's fee or rent, and deposits with the government for the payee. Rates and thresholds are in the ", ["TDS rates chart", SRC.tdsRates], "."))),
  term("What is TCS?", p("TCS, tax collected at source, is income tax a seller collects from the buyer on notified sales, on top of the price, and deposits with the government.")),
  term("What is a TAN?", p(runs("A TAN is the ten-character tax deduction and collection account number a business needs to deduct or collect tax at source. It is quoted on every TDS payment and statement; see the ", ["TAN page", SRC.tan], "."))),
  term("Which forms replaced Form 26Q and Form 16A?", p(runs("Under the Income-tax Rules, 2026, the quarterly statement of non-salary TDS is Form 140, which replaced Form 26Q, and the certificate given to the payee is Form 131, which replaced Form 16A. See the ", ["guide to the new forms", SRC.itForms], "."))),
]);

const payroll = group("glossary-payroll", "Payroll and labour law", [
  term("What is CTC?", p("CTC, cost to company, is everything an employer spends on an employee in a year: salary, allowances and the employer's contributions, such as PF.")),
  term("What is loss of pay?", p("Loss of pay is the salary deducted for days an employee was absent without paid leave. It is usually worked out from the month's attendance and unpaid leave.")),
  term("What is the Code on Social Security, 2020?", p(runs("The Code on Social Security, 2020 brings the PF, ESI, gratuity and other social security laws into one code, in force from 21 November 2025. Its text is on ", ["esic.gov.in", SRC.socialSecurityCode], "."))),
  term("What is PF?", p(runs("PF, the Employees' Provident Fund, is a retirement fund to which employee and employer each contribute a share of wages every month. Establishments with twenty or more employees must register; see the ", ["EPFO FAQ", SRC.epfoFaq], "."))),
  term("What is EPS?", p(runs("EPS, the Employees' Pension Scheme, receives part of the employer's PF contribution, worked out on wages up to the wage ceiling. EPFO raised that ceiling from ₹15,000 to ₹25,000 a month from 17 September 2026, according to its ", ["wage ceiling FAQ", SRC.epfCeiling], "."))),
  term("What is a UAN?", p("A UAN, the Universal Account Number, is the twelve-digit number EPFO gives each member. It stays with the employee across jobs.")),
  term("What is an ECR?", p("An ECR, the electronic challan cum return, is the monthly file an employer uploads to EPFO with each employee's wages and PF contributions, before paying them.")),
  term("What is ESI?", p(runs("ESI, the Employees' State Insurance scheme, gives employees medical care and cash benefits, paid for by contributions from employee and employer. It covers employees earning up to ₹21,000 a month; see ", ["ESIC's contribution page", SRC.esicContribution], "."))),
  term("What is professional tax?", p("Professional tax is a tax some states levy on salaried employment, deducted by the employer each month. Each state sets its own slabs, and some states levy none, so check your state's notification.")),
  term("What is a full and final settlement?", p("A full and final settlement is the last payment to an employee who leaves: salary to the last day, leave encashment, gratuity where it applies, less any recoveries.")),
]);

const accounting = group("glossary-accounting", "Accounting basics", [
  term("What is double-entry bookkeeping?", p("Double-entry bookkeeping records every transaction twice, as a debit to one account and a credit to another, so the books always balance.")),
  term("What is a chart of accounts?", p("A chart of accounts is the list of every account a company posts to: assets, liabilities, income, expenses and equity.")),
  term("What is a journal entry?", p("A journal entry is one posting to the ledger, with its debits and credits, its date and what it was for. A posted entry is corrected with a reversing entry, not by editing it.")),
  term("What is a trial balance?", p("A trial balance lists every account's balance on a date. Its debits and credits must be equal, which proves the postings balance, though not that they are right.")),
  term("What is accrual accounting?", p("Accrual accounting records income when it is earned and expenses when they are incurred, whether or not the cash has moved. Cash accounting waits for the payment.")),
  term("What is a prepaid expense?", p("A prepaid expense is a cost paid in advance, such as a year's insurance, held as an asset and charged to expense month by month.")),
  term("What is an accrued expense?", p("An accrued expense is a cost already incurred but not yet billed or paid, such as this month's electricity, recorded at month end so the month bears it.")),
  term("What is a bank reconciliation?", p("A bank reconciliation compares the bank statement with the company's own bank account in the books, line by line, and explains every difference.")),
  term("What is depreciation?", p("Depreciation spreads the cost of a fixed asset over its useful life. The straight-line method charges the same amount each period; the written-down-value method charges a rate on what is left.")),
  term("What is closing the books?", p("Closing the books is locking a finished period so nothing dated inside it can be posted or changed, usually once its returns are filed.")),
]);

const revenue = group("glossary-revenue", "Revenue recognition and the close", [
  term("What is Ind AS 115?", p(runs("Ind AS 115 is the Indian accounting standard for revenue from contracts with customers, in force for periods from 1 April 2018. Revenue is recognised as the promised goods or services are transferred; see the ", ["standard's text from ICAI", SRC.indAs115], "."))),
  term("What is a performance obligation?", p("A performance obligation is a promise in a contract to transfer a distinct good or service to the customer. Revenue is recognised as each one is satisfied, at a point in time or over time.")),
  term("What is deferred revenue?", p("Deferred revenue is money invoiced or received for goods or services not yet delivered. Ind AS 115 texts call it a contract liability; it moves into revenue as the service is delivered.")),
  term("What is a revenue waterfall?", p("A revenue waterfall shows, month by month, how much deferred revenue will be recognised in the months ahead, by customer or product.")),
  term("What is a month-end close?", p("A month-end close is the checklist of tasks that finish a month's books: reconciliations, accruals, depreciation, revenue recognition and review, before the period is locked.")),
  term("What is flux analysis?", p("Flux analysis compares each account's movement with last month and the same month last year, and asks for an explanation where the change is large.")),
]);

const sales = group("glossary-sales", "Sales and subscription terms", [
  term("What is a CRM?", p("A CRM, customer relationship management system, keeps a company's customers, contacts, leads and deals, and the calls, visits and emails between them.")),
  term("What is a sales pipeline?", p("A sales pipeline is the set of open deals, arranged by stage from first contact to won or lost. Weighing each stage by its win rate gives a forecast.")),
  term("What is a proforma invoice?", p("A proforma invoice is a quotation set out like an invoice, sent before the sale so the customer can pay or approve. It is not a tax invoice.")),
  term("What is receivables ageing?", p("Receivables ageing groups what customers owe by how late it is, such as not yet due, up to 30 days, up to 60 days and over 90 days late.")),
  term("What is an AMC?", p("An AMC, an annual maintenance contract, is a yearly agreement to service equipment, such as computers or machines, for a fixed fee.")),
  term("What are MRR and ARR?", p("MRR, monthly recurring revenue, is the revenue a subscription business expects every month from its active subscriptions. ARR, annual recurring revenue, is the same for a year, often MRR times twelve.")),
]);

const jump: SiteBlock = {
  id: "glossary-sections",
  type: "richText",
  props: {
    content: [
      p("Jump to a section:"),
      ul(
        runs(["GST basics", "#gst"]),
        runs(["GST returns and input tax credit", "#returns"]),
        runs(["E-invoicing and e-way bills", "#einvoicing"]),
        runs(["Income tax and TDS", "#income-tax"]),
        runs(["Payroll and labour law", "#payroll"]),
        runs(["Accounting basics", "#accounting"]),
        runs(["Revenue recognition and the close", "#revenue"]),
        runs(["Sales and subscription terms", "#sales"]),
      ),
    ],
  },
};

const header: SiteBlock = {
  id: "glossary-header",
  type: "pageHeader",
  props: {
    eyebrow: "Resources",
    heading: "GST glossary: tax, accounting and payroll terms",
    intro: `This GST glossary is a plain-language list of the tax, accounting, payroll and sales terms Indian businesses meet, each answered in a few sentences. Regulatory terms link to their official source. Last reviewed: ${GLOSSARY_REVIEWED}. Rates and limits change by notification, so check the current one before you rely on a figure.`,
  },
};

export const GLOSSARY: SeedPage = {
  slug: "resources/glossary",
  document: {
    title: "Glossary",
    seo: {
      title: "GST glossary: tax, accounting and payroll terms",
      description: "A GST glossary for Indian businesses: e-invoice, IRN, e-way bill, HSN, ITC, GSTR-1, TDS, PF, ESI, Ind AS 115 and CRM terms, defined in plain words.",
      keywords: ["GST glossary", "accounting and payroll terms", "e-invoicing and e-way bills"],
    },
    blocks: [
      header,
      jump,
      gstBasics,
      returns,
      einvoicing,
      incomeTax,
      payroll,
      accounting,
      revenue,
      sales,
      related("glossary-related", "Go deeper", ["/blog/e-invoicing-under-gst", "/blog/e-way-bill-rules", "/blog/tds-on-business-payments", "/blog/pf-esi-professional-tax-payroll", "/blog/revenue-recognition-ind-as-115", "/product/accounting-gst", "/resources"], "The guides explain these terms in practice, and the product pages show how {siteName} handles them."),
    ],
  },
};

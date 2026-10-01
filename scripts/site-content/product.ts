import { productByKey } from "../../src/lib/products";
import { h3, hubPage, p, pageMap, ul } from "./_build";
import { PRODUCT_GROUPS, PRODUCT_LINE_GROUPS } from "./_catalog";
import { ADVANCED_PAGES } from "./_product-advanced";
import { PEOPLE_PAGES } from "./_product-people";
import { RUN_PAGES } from "./_product-run";
import { SELL_PAGES } from "./_product-sell";
import { withProductLine } from "./_products";
import type { SeedSection } from "./types";

/**
 * /product and a page for each module (the modules' pages are in _product-*.ts, one file per menu
 * column). The hub leads with the products (src/lib/products.ts, their pages in products.ts), then
 * maps every module; each module page carries one line under its header naming the products it is
 * in (_products.ts PAGE_PLACES).
 */

const one = productByKey("one")!;

const hub = hubPage({
  slug: "product",
  name: "Product",
  seo: {
    title: "Cloud ERP software for Indian businesses",
    description: "Cloud ERP software with every module on one page: CRM, GST invoicing, accounting, payroll, inventory, helpdesk and more, in one workspace.",
    keywords: ["cloud ERP software", "ERP modules", "ERP for Indian businesses"],
  },
  eyebrow: "Product",
  h1: "Cloud ERP software, one module at a time",
  intro: `Cloud ERP software is one system, reached through a browser, for the work a company runs on: selling, billing, buying, the books, people and support. {siteName} sells that work as products, each a set of modules, and ${one.name} is all of them. They share one set of records, so an invoice posts itself to the ledger and a payslip reads attendance and leave.`,
  before: [
    pageMap(
      "product-products",
      "Every {siteName} product",
      `Start with the product for the work in front of you, add others as you grow, or take every one as ${one.name}. Each product's page lists the modules in it.`,
      PRODUCT_LINE_GROUPS,
    ),
  ],
  map: {
    heading: "Every module, grouped by the work it runs",
    intro: "Each page says what the module does today, how it works, and which modules it works with.",
    groups: PRODUCT_GROUPS,
  },
  extra: [
    {
      id: "product-choose",
      type: "richText",
      props: {
        heading: "How to choose your ERP modules",
        content: [
          p("Choose ERP modules by where your company spends the most time today, and add the rest as the work grows. Every module shares one set of records, so starting small costs nothing later."),
          h3("Which modules does a company start with?"),
          p("Most companies start with the CRM and quotes and invoices, because that is where money comes in. Payments and receivables follow, then accounting and GST once invoices and bills are flowing. Companies, contacts and leads, tasks and notes are in every plan."),
          ul("Selling first: CRM, quotes and invoices, payments and receivables", "The books next: accounting and GST, purchases and payables, expenses", "People when you are ready: HR, attendance, leave and payroll", "Support and delivery as customers grow: helpdesk, projects, renewals"),
          h3("Can modules be added later?"),
          p("Yes. A module switched on later works with the records already there: switch on the helpdesk, and every company and contact is ready to raise a ticket against. Nothing has to be keyed in twice."),
          h3("Which modules are sold in India only?"),
          p(`Accounting, Revenue & Close and payroll follow Indian rules, so they are offered to companies in India only — and so are ${productByKey("books")!.name} and ${productByKey("people")!.name}, the products built on them. The e-invoice and e-way bill features in quotes and invoices are India's government systems. Every other module works anywhere.`),
        ],
      },
    },
  ],
  related: ["/solutions", "/compare", "/resources"],
  cta: { heading: "Start with the modules you need", body: "Set up a workspace and switch modules on as you go. Every workspace starts with a {trialDays}-day free trial." },
});

export const section: SeedSection = { name: "Product", pages: [hub, ...[...SELL_PAGES, ...RUN_PAGES, ...PEOPLE_PAGES, ...ADVANCED_PAGES].map(withProductLine)] };

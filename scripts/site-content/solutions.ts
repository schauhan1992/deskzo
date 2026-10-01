import { h3, hubPage, p, ul } from "./_build";
import { SOLUTION_GROUPS } from "./_catalog";
import { INDUSTRY_PAGES } from "./_solutions-industry";
import { ROLE_PAGES } from "./_solutions-role";
import { SIZE_PAGES } from "./_solutions-size";
import type { SeedSection } from "./types";

/** /solutions and a page for each role, company size and industry (in _solutions-*.ts). */

const hub = hubPage({
  slug: "solutions",
  name: "Solutions",
  seo: {
    title: "Business software for Indian companies",
    description: "Business software for Indian companies, by role, company size and industry: founders, finance, sales, HR and IT teams, resellers, agencies, traders and SaaS.",
    keywords: ["business software for Indian companies", "software by company size", "industry solutions"],
  },
  eyebrow: "Solutions",
  h1: "Business software for Indian companies, by role, size and industry",
  intro:
    "Business software for Indian companies has to handle GST, TDS and payroll rules as well as sales and support. These pages start from who you are: your role, the size of your company, or your industry. Each one names the problems it solves and the {siteName} modules that solve them.",
  map: {
    heading: "Find the page for your team",
    intro: "Every solution is built from the same modules, switched on in the combination that team or company needs.",
    groups: SOLUTION_GROUPS,
  },
  extra: [
    {
      id: "solutions-choose",
      type: "richText",
      props: {
        heading: "How the solutions fit together",
        content: [
          p("Business software for Indian companies is one product here, not a family of apps. Each page picks the modules a role, a size or an industry needs most, and every module shares one set of records: the same companies, items and people."),
          h3("Is each solution a separate product?"),
          p("No. Every solution is the same workspace with a different set of modules switched on. A company can start as a small business, add payroll as it grows, and add branches later without moving its data."),
          ul("By role: founders, finance, sales, HR, operations and IT", "Software by company size: small businesses, growing companies and multi-branch companies", "Industry solutions: IT services and resellers, professional services, trading and distribution, SaaS and subscriptions"),
          h3("What if my company fits more than one page?"),
          p("Most do. A trading company with branches will want the trading and distribution page and the multi-branch page. Read both: the modules they name work together in one workspace, on one set of records."),
        ],
      },
    },
  ],
  related: ["/product", "/compare", "/resources"],
  cta: { heading: "Tell us how your company works", body: "Book a demo and we will show you the modules that fit, with the steps your team follows each day." },
});

export const section: SeedSection = { name: "Solutions", pages: [hub, ...ROLE_PAGES, ...SIZE_PAGES, ...INDUSTRY_PAGES] };

import { hubPage } from "./_build";
import { GUIDE_ENTRIES, RESOURCE_ENTRIES } from "./_catalog";
import { GLOSSARY } from "./_glossary";
import type { SeedSection } from "./types";

/** /resources and /resources/glossary. The guides are posts: guides.ts. */

const hub = hubPage({
  slug: "resources",
  name: "Resources",
  seo: {
    title: "GST resources: guides and a glossary",
    description: "GST resources for Indian businesses: guides to e-invoicing, e-way bills, TDS and payroll, and an accounting glossary of the terms you meet.",
    keywords: ["GST resources", "accounting glossary", "compliance guides"],
  },
  eyebrow: "Resources",
  h1: "GST resources, guides and a glossary",
  intro:
    "The GST resources here are a set of plain-language guides for Indian businesses, on e-invoicing, e-way bills, TDS, payroll and the month-end close, with a glossary of the terms you meet in each. Every guide links to the official source and says when it was last reviewed.",
  map: {
    heading: "Learn, then get in touch",
    intro:
      "Start with the compliance guides or the accounting glossary. The guides explain one topic each, such as e-invoicing or the month-end close, in the order you meet it, and link to the official sources. The glossary defines the terms they use. When you want to see how the software handles it, book a demo.",
    groups: [
      { title: "Learn", entries: RESOURCE_ENTRIES },
      { title: "Guides", entries: GUIDE_ENTRIES },
      {
        title: "Talk to us",
        entries: [
          { path: "/contact?topic=demo", label: "Book a demo", tagline: "", summary: "A walk through the modules that matter to your company, with your questions answered." },
          { path: "/contact", label: "Contact", tagline: "", summary: "Plans and pricing, an invitation, or help with your workspace." },
          { path: "/security", label: "Security", tagline: "", summary: "How each company's data is kept apart: its own database, its own keys, and audit logs." },
        ],
      },
      {
        title: "Partners",
        entries: [
          { path: "/partners", label: "Become a partner", tagline: "", summary: "Sell {siteName} to the companies you work with and earn a recurring commission." },
          { path: "/partners/find", label: "Find a partner", tagline: "", summary: "Companies that sell {siteName}, set it up and support it where you are." },
        ],
      },
    ],
  },
  related: ["/product", "/solutions", "/compare"],
  cta: { heading: "Questions a guide doesn't answer?", body: "Tell us how your company works and we will show you how {siteName} handles it." },
});

export const section: SeedSection = { name: "Resources", pages: [hub, GLOSSARY] };

import type { HelpGuideProps } from "../../src/components/site/blocks/types";

/**
 * A module's guide as the Help Center seed holds it (scripts/help-guides-seed.ts): one file per
 * module in this directory, named by its module key (sales_documents.ts), exporting `guide`.
 *
 * The seed saves each one in the website CMS as a draft page at `slug` — never published: Deskzo's
 * staff read it, correct it and publish it there. After that the CMS holds the guide, and the seed
 * leaves a page a person has changed alone.
 *
 * The words follow the site's content rules (src/components/site/defaults.ts) and the guide outline
 * (src/lib/help/guides.ts): the brand is the {siteName} token, never typed; products are never named
 * (the block lists them from src/lib/products.ts); every claim true of the code today.
 */
export type SeedGuide = {
  /** "help/leads" — the page's address under the Help Center. */
  slug: string;
  /** The page's name in the CMS and in the breadcrumb: "Leads". */
  title: string;
  /** What a search result shows. Three primary keywords, keyword 1 first. */
  seo: { title: string; description: string; keywords: [string, string, string] };
  /** The guide itself — the page's one block. */
  guide: HelpGuideProps;
};

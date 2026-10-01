import type { SiteBlock } from "../../src/components/site/blocks/types";
import type { PageDocument, PostSeo, TermSeo } from "../../src/lib/cms/types";

/**
 * The shapes the website seed's data modules export (scripts/site-seed-pages.ts, logic in
 * scripts/lib/site-seed.ts).
 *
 * Each module in this directory — product.ts, solutions.ts, resources.ts, guides.ts, compare.ts… —
 * exports one `section: SeedSection`, and the seed picks every module up by itself (./index.ts):
 * adding a section is adding a file. The content is exactly what the CMS stores, so the CMS's own
 * validator checks it (`--dry-run` shows what it would refuse), and a person can edit any of it in
 * the CMS afterwards — the seed then leaves that page or post alone.
 *
 * The words follow the site's content rules (src/components/site/defaults.ts): the brand is always
 * the `{siteName}` token, never a name; no superlatives, invented numbers, customers or testimonials;
 * every product claim true of the code; a regulatory fact linked to its official source.
 */

/** A CMS page: its address ("product/crm", no leading slash) and the document as the CMS keeps it — `title` is its name in the CMS and in breadcrumbs. */
export type SeedPage = { slug: string; document: PageDocument };

/** A blog category the section's posts file under (made through the CMS's taxonomy functions). */
export type SeedCategory = { slug: string; name: string; description?: string; seo?: TermSeo };

/**
 * A blog post, published at /blog/<slug>. `categories` are category slugs — the section's own or
 * any already on the site — the main one first. `tags` are tag names or slugs (made when missing).
 */
export type SeedPost = { slug: string; title: string; excerpt: string; seo: PostSeo; body: SiteBlock[]; categories: string[]; tags?: string[] };

/** One data module's content. `name` is what the seed's output calls it ("Product", "Compare"). */
export type SeedSection = { name: string; pages?: SeedPage[]; categories?: SeedCategory[]; posts?: SeedPost[] };

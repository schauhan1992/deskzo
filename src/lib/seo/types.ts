import type { SiteSettings } from "@/components/site/blocks/types";

/**
 * The SEO Intelligence engine's vocabulary: what an entity looks like to the checks (`SeoInput`),
 * what a check is (`CheckDef`) and what it answers (`CheckResult`), and the scores built from them.
 *
 * Pure and client-safe, like everything in src/lib/seo: plain data and types, no database, no React,
 * nothing server-only — the CMS editors score live in the browser with the same code the dashboard
 * runs on the server. The scores are internal indicators, not any search engine's or AI platform's.
 */

// ─── Entities ────────────────────────────────────────────────────────────────────────────────────

/** What can be scored: a page (the home page is its own kind), a post, an archive, the blog index. */
export type SeoEntityKind = "page" | "home" | "post" | "category" | "tag" | "blog-index";
export const SEO_ENTITY_KINDS: readonly SeoEntityKind[] = ["page", "home", "post", "category", "tag", "blog-index"];

/** Where the content is: live as published, a draft, a built-in page's default content, or a post scheduled for later. */
export type SeoStatus = "published" | "draft" | "default" | "scheduled";

/**
 * What sort of page it is, for the checks whose expectations differ: the pricing and security pages
 * should state facts, a form page is not an article, a help page is expected to answer questions.
 */
export type SeoPageType = "home" | "pricing" | "security" | "contact" | "legal" | "form" | "help" | "general" | "article" | "archive" | "blog-index";

/** An image with what the site knows about it. `width`/`height` only when known. */
export type SeoImage = { src: string; alt: string; width?: number | null; height?: number | null };

// ─── Metadata as the site emits it ───────────────────────────────────────────────────────────────

/** Where a value came from: the entity's own SEO field, a fallback the site uses, text the site generates, or code. */
export type SeoValueSource = "seo" | "fallback" | "generated" | "fixed" | "none";
/** Where the sharing image came from: the entity's own, a post's cover, the site's default, or none at all. */
export type SeoImageSource = "own" | "cover" | "site" | "fixed" | "none";

/** The metadata a page's HTML carries once Next has applied the layout (src/lib/seo/metadata.ts `effectiveMetadata`). */
export type EffectiveMeta = {
  /** The final `<title>`, after the site's title template. */
  title: string;
  /** The entity's own title before the template: its SEO title, else the fallback the site uses. */
  rawTitle: string;
  titleSource: SeoValueSource;
  /** What the template adds around the title (" · Wroffy ERP"); "" for an absolute title. */
  templateAddition: string;
  /** The meta description; "" when the page has none. */
  description: string;
  descriptionSource: SeoValueSource;
  /** A site path ("/pricing", "/blog/category/guides?page=2"), or null when none is emitted. */
  canonical: string | null;
  robots: { index: boolean; follow: boolean };
  ogTitle: string;
  ogDescription: string;
  ogImage: SeoImage | null;
  ogImageSource: SeoImageSource;
  twitterCard: "summary" | "summary_large_image" | null;
  /** The `<meta name="keywords">` values — never a ranking factor, and never worth points. */
  keywords: string[];
};

// ─── Content, extracted from blocks or a post's body ─────────────────────────────────────────────

/**
 * `field` in every content item is where an editor fixes it: "blocks[<blockId>]" for a page's block,
 * "body[<blockId>]" for a post's, or a document field ("title", "excerpt", "description"); null for
 * text the site's code writes (an archive's post list).
 */
export type SeoHeading = { level: 1 | 2 | 3 | 4 | 5 | 6; text: string; field: string | null };
export type SeoParagraph = {
  text: string;
  words: number;
  field: string | null;
  /** Index into `headings` of the heading it sits under; -1 before any. */
  heading: number;
  /** The first text right after that heading. */
  leading: boolean;
};
export type SeoList = { items: string[]; ordered: boolean; field: string | null };
/** `text`: every cell, headings included, one per line. */
export type SeoTable = { columns: string[]; rows: number; text: string; field: string | null };
export type SeoFaq = { question: string; answer: string; field: string | null };
export type SeoContentImage = {
  src: string;
  alt: string;
  /** From the site's media library ("/media/<id>"), else an address typed in. */
  library: boolean;
  /** Shown with an empty alt on purpose (a testimonial's photo beside the person's name). */
  decorative: boolean;
  field: string | null;
};
export type SeoLink = { href: string; label: string; internal: boolean; field: string | null };
export type SeoCrumb = { name: string; path: string };

export type SeoContent = {
  h1s: string[];
  /** Every heading, h1 included, in document order. */
  headings: SeoHeading[];
  paragraphs: SeoParagraph[];
  lists: SeoList[];
  tables: SeoTable[];
  faqs: SeoFaq[];
  images: SeoContentImage[];
  /** Links in the content — not the header, footer, breadcrumb or term chips. */
  links: SeoLink[];
  /** Every visible word of the content, one text run per line. */
  text: string;
  wordCount: number;
  /** The opening text: paragraphs in order until about 100 words. */
  firstSection: string;
  /** The first paragraph of at least eight words — what the page says it is about. */
  firstParagraph: string;
  /** The visible breadcrumb, the entity itself left off (posts, archives, and nested pages: Home › Product); [] when the page shows none. */
  breadcrumbs: SeoCrumb[];
  /** Block types in order ("hero", "faq", "pricingTable"…); for a post, its body's. */
  blockTypes: string[];
};

export type SeoEditorial = {
  author: string | null;
  publishedAt: Date | null;
  updatedAt: Date | null;
  /** Names, the main one first. */
  categories: string[];
  tags: string[];
  excerpt: string | null;
  cover: SeoImage | null;
};

/** One JSON-LD object (src/lib/seo/schema.ts). */
export type JsonLd = { "@context"?: string; "@type": string; [key: string]: unknown };

// ─── The site around an entity ───────────────────────────────────────────────────────────────────

/** Another entity on the site, for the duplicate checks. */
export type SeoOtherEntity = { id: string; path: string; title: string; description: string; h1: string };

export type SeoSiteContext = {
  /** The published settings: tokens ({siteName}…) and actions are resolved with them. */
  settings: SiteSettings;
  trialDays: number;
  signupOpen: boolean;
  siteName: string;
  /** Null while it is unset or still the placeholder. */
  tagline: string | null;
  /** The site's default meta description, tokens filled. */
  description: string;
  /** The social profiles the footer links to (checked addresses only). */
  social: { network: string; href: string }[];
  /** "https://example.com", for absolute URLs in JSON-LD; "" when unknown (they are then site paths). */
  origin: string;
  /** The layout's title template and default title, tokens filled ("%s · Wroffy ERP"). */
  titleTemplate: string;
  defaultTitle: string;
  /** The site's default sharing image, when it has a usable one. */
  defaultOgImage: string | null;
  /** robots.txt lets the AI search crawlers in (owner decision S-D2). */
  aiSearchCrawlersAllowed: boolean;
  /** The site emits the JSON-LD from src/lib/seo/schema.ts. */
  emitsJsonLd: boolean;
  /** Paths robots.txt disallows for every crawler on the public site (prefixes). */
  robotsDisallow: string[];
  /** Paths an enabled redirect sends elsewhere: live, but left out of the sitemap. */
  redirectedPaths: string[];
  /** Posts live on the site: the sitemap lists the blog and its archives only when there is one. */
  livePostCount: number;
  /** Every other entity, for "is this title / description / H1 used elsewhere". May include this one; it is skipped by id. */
  others: SeoOtherEntity[];
};

// ─── The input every check reads ─────────────────────────────────────────────────────────────────

export type SeoInput = {
  kind: SeoEntityKind;
  /** The CMS id ("builtin-home" for an unsaved built-in page), or a key ("blog-index"). */
  id: string;
  /** "home", "pricing", a post's or term's slug; "blog" for the blog index. */
  slug: string;
  /** The address on the site: "/", "/pricing", "/blog/x", "/blog/category/y". */
  path: string;
  status: SeoStatus;
  /** On the public site now. */
  live: boolean;
  isBuiltin: boolean;
  pageType: SeoPageType;
  /** Its name in the CMS: a page's title, a post's title, a term's name. */
  name: string;
  meta: EffectiveMeta;
  /** The primary keywords as entered, normalised (0–3). May hold a duplicate; checks compare case-insensitively. */
  keywords: string[];
  content: SeoContent;
  editorial: SeoEditorial;
  /** The JSON-LD the site emits for it: [] while the site emits none. */
  jsonLd: JsonLd[];
  /** For an archive: which page of it this is and how many posts it has. */
  archive: { page: number; pages: number; total: number } | null;
  site: SeoSiteContext;
  /** "Now", for the freshness checks — never read from the clock inside a check. */
  now: Date;
};

// ─── Checks and scores ───────────────────────────────────────────────────────────────────────────

export type SeoCategory = "seo" | "aeo" | "geo";
export type SeoCheckGroup = "metadata" | "content" | "url" | "social" | "technical" | "structured-data" | "keywords" | "answers" | "entity" | "freshness" | "readability";

export type CheckStatus = "PASS" | "WARNING" | "FAIL" | "INFO" | "NOT_APPLICABLE";
export type CheckSeverity = "critical" | "improvement";

export type CheckResult = {
  id: string;
  category: SeoCategory;
  group: SeoCheckGroup;
  label: string;
  status: CheckStatus;
  pointsEarned: number;
  /** The check's weight when it is scored (PASS, WARNING, FAIL); 0 for INFO and NOT_APPLICABLE. */
  pointsAvailable: number;
  message: string;
  /** What to do about it; "" when there is nothing to do. */
  recommendation: string;
  /** The editor field to jump to: "seo.description", "slug", "blocks[<blockId>]", "body[<blockId>]". */
  field?: string;
  severity?: CheckSeverity;
};

/** What a check's `evaluate` answers — the engine adds the rest. */
export type CheckOutcome = Omit<CheckResult, "id" | "category" | "group" | "label" | "pointsAvailable"> & { pointsEarned: number };

export type CheckDef = {
  id: string;
  label: string;
  category: SeoCategory;
  group: SeoCheckGroup;
  weight: number;
  applicableTo: readonly SeoEntityKind[];
  /** Only matters for a page search engines may index: NOT_APPLICABLE for an intentionally excluded one. */
  indexedOnly?: boolean;
  /** `weight` is the check's own, passed so partial credit is a share of it. */
  evaluate(input: SeoInput, weight: number): CheckOutcome;
};

export type ScoreBreakdown = {
  score: number;
  maxScore: 100;
  checks: CheckResult[];
  /** Set when the score is not a measurement ("No checks apply…"). */
  note: string | null;
};

export type SeoLabel = "Poor" | "Needs improvement" | "Good" | "Excellent";

export type KeywordAnalysis = {
  keyword: string;
  inTitle: boolean;
  inDescription: boolean;
  /** Its words are in the address's slug, hyphenated. */
  inUrl: boolean;
  inH1: boolean;
  inFirstSection: boolean;
  /** In the text under the headings: paragraphs, lists, tables, FAQ answers. */
  inBody: boolean;
  inImageAlt: boolean;
  /** In an H2–H6. */
  inHeadings: boolean;
  /** Times it appears in the visible content. */
  occurrences: number;
  /** Share of the content's words it takes up, in percent (two decimals). */
  density: number;
};

export type EntityScore = {
  seo: ScoreBreakdown;
  aeo: ScoreBreakdown;
  geo: ScoreBreakdown;
  overall: number;
  label: SeoLabel;
  /** Intentionally kept out of search (noindex): shown as excluded, never penalised, left out of the site score. */
  excluded: boolean;
  /** Checks that failed or warned with severity "critical". */
  critical: number;
  /** Checks that warned. */
  warnings: number;
  keywords: KeywordAnalysis[];
};

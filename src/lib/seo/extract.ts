import type { RichInline, RichNode, SiteAction, SiteBlock, SiteMedia, SitePage, SiteSettings } from "@/components/site/blocks/types";
import { calendarDateLabel, comparisonMark, fill, isInternal, resolveAction, safeHref, safeSrc, sourceSite } from "@/components/site/links";
import { BUILTIN_PAGE_SLUGS } from "@/lib/cms/types";
import {
  archiveMetaSources,
  archiveSeoView,
  BLOG_INDEX_SOURCES,
  buildArchiveMetadata,
  buildBlogIndexMetadata,
  buildPageMetadata,
  buildPostMetadata,
  effectiveMetadata,
  layoutView,
  pageMetaSources,
  pagePath,
  postMetaSources,
  type ArchiveSeoView,
} from "@/lib/seo/metadata";
import { normaliseKeywords } from "@/lib/seo/keywords";
import { jsonLdFor, shownUpdatedAt } from "@/lib/seo/schema";
import { countWords, squash } from "@/lib/seo/text";
import type {
  SeoContent,
  SeoContentImage,
  SeoCrumb,
  SeoEditorial,
  SeoFaq,
  SeoHeading,
  SeoImage,
  SeoInput,
  SeoLink,
  SeoList,
  SeoOtherEntity,
  SeoPageType,
  SeoParagraph,
  SeoSiteContext,
  SeoStatus,
  SeoTable,
} from "@/lib/seo/types";

/**
 * Turns the CMS's own shapes — a page document, a post, a category's or tag's archive, the blog
 * index — into the one `SeoInput` every check reads, so no check ever touches a raw block. What is
 * extracted is what the site renders (src/components/site/blocks/*, the blog's routes): the same
 * headings at the same levels, tokens filled, only links and images that pass the site's own checks
 * (`safeHref`, `safeSrc`), internal or not by the same rule (`isInternal`). The header, footer,
 * breadcrumb and term chips are the site's frame, not the content, and are left out of it (the
 * breadcrumb is kept apart, for the checks that look for one).
 *
 * Pure and client-safe: the editors call these on the document being typed.
 */

/** Built-in pages that are forms, not articles: content-depth checks do not apply to them. */
export const FORM_PAGE_SLUGS: readonly string[] = ["signin", "signup"];
/** Built-in legal pages: scored for structure and readability, not asked to answer questions. */
export const LEGAL_PAGE_SLUGS: readonly string[] = ["terms", "privacy"];
/** What robots.txt disallows for every crawler on the public site — mirrors src/app/robots.ts (not imported: it is a route). */
export const PUBLIC_ROBOTS_DISALLOW: readonly string[] = ["/signup"];
/** The blog index's words, as blog/page.tsx writes them. */
export const BLOG_INDEX_INTRO = "News, product updates and notes from the team.";

/** The keywords as entered: normalised, repeats kept — the checks report a repeat; the metadata drops it. */
const enteredKeywords = (seo: unknown): string[] => normaliseKeywords(seo && typeof seo === "object" ? (seo as { keywords?: unknown }).keywords : undefined);

const isBuiltinSlug = (slug: string) => (BUILTIN_PAGE_SLUGS as readonly string[]).includes(slug);

/** The CMS's status as the engine's: "DEFAULT" (a built-in page never saved), "DRAFT", "PUBLISHED", "SCHEDULED". */
export function seoStatusOf(status: string): SeoStatus {
  switch (status) {
    case "DEFAULT":
      return "default";
    case "PUBLISHED":
      return "published";
    case "SCHEDULED":
      return "scheduled";
    default:
      return "draft";
  }
}

/**
 * A check's `field` taken apart, for an editor jumping to it: "blocks[<blockId>]" and
 * "body[<blockId>]" name a block (its id, or its index when it has none); anything else
 * ("seo.description", "slug", "title") is a document field.
 */
export function parseSeoField(field: string | undefined | null): { kind: "block"; root: "blocks" | "body"; blockId: string } | { kind: "field"; path: string } | null {
  if (!field) return null;
  const m = /^(blocks|body)\[([^\]]+)\]$/.exec(field);
  if (m) return { kind: "block", root: m[1] as "blocks" | "body", blockId: m[2] };
  return { kind: "field", path: field };
}

/** What sort of page an entity is. A CMS page whose address names help, FAQs or support is a help page. */
export function pageTypeFor(kind: SeoInput["kind"], slug: string): SeoPageType {
  if (kind === "home") return "home";
  if (kind === "post") return "article";
  if (kind === "category" || kind === "tag") return "archive";
  if (kind === "blog-index") return "blog-index";
  if (FORM_PAGE_SLUGS.includes(slug)) return "form";
  if (LEGAL_PAGE_SLUGS.includes(slug)) return "legal";
  if (slug === "pricing" || slug === "security" || slug === "contact") return slug;
  if (/(^|[/-])(help|faqs?|support)($|[/-])/.test(slug)) return "help";
  return "general";
}

// ─── Site context ────────────────────────────────────────────────────────────────────────────────

export type SiteContextOptions = {
  trialDays: number;
  signupOpen: boolean;
  /** "https://example.com" — the public site's address; "" or left out when unknown. */
  origin?: string;
  /** robots.txt lets AI search crawlers in (S-D2). The caller reads the site's current policy. */
  aiSearchCrawlersAllowed: boolean;
  /** The site emits schema.ts's JSON-LD. Defaults to true: S-D1's structured data is part of this work (S2 wires it). */
  emitsJsonLd?: boolean;
  /** The placeholder tagline (DEFAULT_SITE_SETTINGS.tagline): a tagline equal to it counts as unset. */
  placeholderTagline?: string | null;
  robotsDisallow?: readonly string[];
  redirectedPaths?: readonly string[];
  livePostCount?: number;
  others?: SeoOtherEntity[];
};

/** The site around every entity, from its published settings. */
export function siteContextFrom(settings: SiteSettings, options: SiteContextOptions): SeoSiteContext {
  const ctx = { settings, trialDays: options.trialDays };
  const tagline = squash(fill(settings.tagline, ctx));
  const layout = layoutView(ctx);
  return {
    settings,
    trialDays: options.trialDays,
    signupOpen: options.signupOpen,
    siteName: squash(settings.siteName),
    tagline: tagline && tagline !== squash(options.placeholderTagline) ? tagline : null,
    description: squash(layout.description),
    social: (settings.social ?? []).map((s) => ({ network: String(s.network), href: safeHref(s.href) ?? "" })).filter((s) => s.href),
    origin: (options.origin ?? "").replace(/\/+$/, ""),
    titleTemplate: layout.titleTemplate,
    defaultTitle: layout.defaultTitle,
    defaultOgImage: layout.ogImage,
    aiSearchCrawlersAllowed: options.aiSearchCrawlersAllowed,
    emitsJsonLd: options.emitsJsonLd ?? true,
    robotsDisallow: [...(options.robotsDisallow ?? PUBLIC_ROBOTS_DISALLOW)],
    redirectedPaths: [...(options.redirectedPaths ?? [])],
    livePostCount: Math.max(0, options.livePostCount ?? 0),
    others: options.others ?? [],
  };
}

/** What the duplicate checks compare an entity by. */
export function otherEntityOf(input: SeoInput): SeoOtherEntity {
  return { id: input.id, path: input.path, title: input.meta.title, description: input.meta.description, h1: input.content.h1s[0] ?? "" };
}

/** Every input with the whole set as its `site.others` — for scoring a site's entities together. */
export function crossReference(inputs: SeoInput[]): SeoInput[] {
  const others = inputs.map(otherEntityOf);
  return inputs.map((input) => ({ ...input, site: { ...input.site, others } }));
}

// ─── Reading blocks ──────────────────────────────────────────────────────────────────────────────

const arr = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

type Collector = {
  headings: SeoHeading[];
  paragraphs: SeoParagraph[];
  lists: SeoList[];
  tables: SeoTable[];
  faqs: SeoFaq[];
  images: SeoContentImage[];
  links: SeoLink[];
  texts: string[];
  blockTypes: string[];
  /** The last thing added was a heading. */
  afterHeading: boolean;
};

const collector = (): Collector => ({ headings: [], paragraphs: [], lists: [], tables: [], faqs: [], images: [], links: [], texts: [], blockTypes: [], afterHeading: false });

type FillCtx = { settings: SiteSettings; trialDays: number; signupOpen: boolean };

function heading(c: Collector, level: SeoHeading["level"], text: string, field: string | null) {
  const t = squash(text);
  if (!t) return;
  c.headings.push({ level, text: t, field });
  c.texts.push(t);
  c.afterHeading = true;
}

function paragraph(c: Collector, text: string, field: string | null) {
  const t = squash(text);
  if (!t) return;
  c.paragraphs.push({ text: t, words: countWords(t), field, heading: c.headings.length - 1, leading: c.afterHeading });
  c.texts.push(t);
  c.afterHeading = false;
}

/** Visible words that are neither a heading nor a paragraph: an eyebrow, a caption's title, a name. */
function label(c: Collector, text: string) {
  const t = squash(text);
  if (t) c.texts.push(t);
}

function list(c: Collector, items: string[], ordered: boolean, field: string | null) {
  const clean = items.map(squash).filter(Boolean);
  if (!clean.length) return;
  c.lists.push({ items: clean, ordered, field });
  c.texts.push(...clean);
  c.afterHeading = false;
}

function table(c: Collector, columns: string[], rows: string[][], field: string | null) {
  const cols = columns.map(squash);
  const cells = rows.map((r) => r.map(squash));
  const all = [...cols, ...cells.flat()].filter(Boolean);
  if (!all.length) return;
  c.tables.push({ columns: cols, rows: cells.length, text: all.join("\n"), field });
  c.texts.push(...all);
  c.afterHeading = false;
}

function faq(c: Collector, question: string, answers: string[], field: string | null) {
  const q = squash(question);
  const a = answers.map(squash).filter(Boolean);
  if (!q && !a.length) return;
  c.faqs.push({ question: q, answer: a.join("\n\n"), field });
  if (q) c.texts.push(q);
  // The answers are paragraphs the page shows — under a question, not a heading, so never "leading".
  c.afterHeading = false;
  for (const p of a) paragraph(c, p, field);
}

function image(c: Collector, src: unknown, alt: unknown, field: string | null, decorative = false) {
  const s = safeSrc(str(src));
  if (!s) return;
  c.images.push({ src: s, alt: squash(str(alt)), library: s.startsWith("/media/"), decorative, field });
}

function media(c: Collector, m: SiteMedia | undefined, field: string | null) {
  const o = obj(m);
  if (o.kind === "image") image(c, o.src, o.alt, field);
}

function link(c: Collector, href: unknown, text: string, field: string | null) {
  const h = safeHref(str(href));
  if (!h) return;
  c.links.push({ href: h, label: squash(text), internal: isInternal(h), field });
}

function action(c: Collector, a: SiteAction | undefined, ctx: FillCtx, field: string | null) {
  const o = obj(a);
  if (o.kind !== "signup" && o.kind !== "link") return;
  const resolved = resolveAction(o as SiteAction, ctx);
  link(c, resolved.href, resolved.label, field);
}

function inlineText(value: RichInline | undefined, ctx: FillCtx): string {
  if (typeof value === "string") return fill(value, ctx);
  return arr<{ text?: unknown }>(value)
    .map((span) => fill(str(obj(span).text), ctx))
    .join("");
}

function inlineLinks(c: Collector, value: RichInline | undefined, ctx: FillCtx, field: string | null) {
  if (typeof value === "string") return;
  for (const span of arr(value)) {
    const s = obj(span);
    if (s.href) link(c, s.href, fill(str(s.text), ctx), field);
  }
}

/** A SectionHead: the eyebrow, the h2, the introduction. */
function sectionHead(c: Collector, p: Record<string, unknown>, t: (s: unknown) => string, field: string) {
  label(c, t(p.eyebrow));
  heading(c, 2, t(p.heading), field);
  paragraph(c, t(p.intro), field);
}

function richNode(c: Collector, node: RichNode, ctx: FillCtx, field: string) {
  const n = obj(node);
  switch (n.type) {
    case "heading":
      heading(c, n.level === 3 ? 3 : 2, fill(str(n.text), ctx), field);
      break;
    case "paragraph":
    case "note":
      paragraph(c, inlineText(n.text as RichInline, ctx), field);
      inlineLinks(c, n.text as RichInline, ctx, field);
      break;
    case "list": {
      const items = arr<RichInline>(n.items);
      list(
        c,
        items.map((i) => inlineText(i, ctx)),
        n.ordered === true,
        field,
      );
      for (const i of items) inlineLinks(c, i, ctx, field);
      break;
    }
    case "table": {
      const rows = arr<RichInline[]>(n.rows).map((r) => arr<RichInline>(r));
      table(
        c,
        arr(n.columns).map((col) => fill(str(col), ctx)),
        rows.map((r) => r.map((cell) => inlineText(cell, ctx))),
        field,
      );
      for (const r of rows) for (const cell of r) inlineLinks(c, cell, ctx, field);
      break;
    }
  }
}

/** One block, as its component renders it. A block of an unknown type renders nothing, and adds nothing. */
function block(c: Collector, b: SiteBlock, index: number, root: "blocks" | "body", ctx: FillCtx) {
  const o = obj(b);
  const p = obj(o.props);
  const field = `${root}[${typeof o.id === "string" && o.id ? o.id : index}]`;
  const t = (s: unknown) => fill(str(s), ctx);
  c.blockTypes.push(str(o.type));
  switch (o.type) {
    case "hero":
      label(c, t(p.eyebrow));
      heading(c, 1, t(p.heading), field);
      paragraph(c, t(p.subheading), field);
      action(c, p.primary as SiteAction, ctx, field);
      action(c, p.secondary as SiteAction, ctx, field);
      paragraph(c, t(ctx.signupOpen ? p.note : p.noteInviteOnly), field);
      media(c, p.media as SiteMedia, field);
      break;
    case "pageHeader":
      label(c, t(p.eyebrow));
      heading(c, 1, t(p.heading), field);
      paragraph(c, t(p.intro), field);
      paragraph(c, t(obj(p.notice).text), field);
      break;
    case "featureGrid":
      sectionHead(c, p, t, field);
      for (const item of arr(p.items).map(obj)) {
        heading(c, 3, t(item.title), field);
        paragraph(c, t(item.body), field);
        list(c, arr(item.bullets).map(t), false, field);
        const l = obj(item.link);
        link(c, l.href, t(l.label), field);
      }
      break;
    case "moduleGrid":
      sectionHead(c, p, t, field);
      for (const group of arr(p.groups).map(obj)) {
        heading(c, 3, t(group.title), field);
        paragraph(c, t(group.summary), field);
        list(
          c,
          arr(group.modules)
            .map(obj)
            .map((m) => [t(m.label), t(m.blurb)].filter((s) => s.trim()).join(". ")),
          false,
          field,
        );
      }
      paragraph(c, t(p.footnote), field);
      break;
    case "richText":
      heading(c, 2, t(p.heading), field);
      for (const node of arr<RichNode>(p.content)) richNode(c, node, ctx, field);
      break;
    case "imageText":
      sectionHead(c, p, t, field);
      for (const para of arr(p.body)) paragraph(c, t(para), field);
      list(c, arr(p.bullets).map(t), false, field);
      action(c, p.action as SiteAction, ctx, field);
      media(c, p.media as SiteMedia, field);
      break;
    case "stats": {
      const items = arr(p.items).map(obj);
      if (!items.length) break;
      heading(c, 2, t(p.heading), field);
      list(
        c,
        items.map((i) => `${t(i.value)} ${t(i.label)}`),
        false,
        field,
      );
      break;
    }
    case "faq":
      sectionHead(c, p, t, field);
      for (const item of arr(p.items).map(obj)) faq(c, t(item.question), arr(item.answer).map(t), field);
      break;
    case "cta":
      heading(c, 2, t(p.heading), field);
      paragraph(c, t(p.body), field);
      action(c, p.primary as SiteAction, ctx, field);
      action(c, p.secondary as SiteAction, ctx, field);
      break;
    case "pricingTable":
      // The plans are read live when the page is served; what the content holds is the frame around them.
      label(c, t(p.countryLabel));
      heading(c, 2, t(p.editionsHeading), field);
      paragraph(c, t(p.trialNote), field);
      paragraph(c, t(p.footnote), field);
      break;
    case "securityHighlights":
      sectionHead(c, p, t, field);
      link(c, obj(p.link).href, t(obj(p.link).label), field);
      for (const item of arr(p.items).map(obj)) {
        heading(c, 3, t(item.title), field);
        paragraph(c, t(item.body), field);
      }
      break;
    case "contactForm": {
      heading(c, 2, t(p.heading), field);
      paragraph(c, t(p.intro), field);
      const aside = arr(p.aside).map(obj);
      if (aside.length) {
        heading(c, 2, t(p.asideHeading), field);
        for (const item of aside) {
          label(c, t(item.title));
          paragraph(c, t(item.body), field);
          link(c, obj(item.link).href, t(obj(item.link).label), field);
        }
      }
      break;
    }
    case "logoCloud": {
      const items = arr(p.items)
        .map(obj)
        .filter((i) => str(i.name).trim());
      if (!items.length) break;
      heading(c, 2, t(p.heading), field);
      for (const item of items) {
        const hasImage = !!safeSrc(str(item.imageUrl));
        if (hasImage) image(c, item.imageUrl, item.name, field);
        else label(c, str(item.name));
        if (safeHref(str(item.href))) link(c, item.href, str(item.name), field);
      }
      break;
    }
    case "testimonial": {
      const quoteText = t(p.quote).trim();
      if (!quoteText || !str(p.name).trim()) break;
      paragraph(c, quoteText, field);
      image(c, p.imageUrl, "", field, true);
      label(c, str(p.name));
      label(c, [str(p.role), str(p.company)].filter((s) => s.trim()).join(", "));
      break;
    }
    case "productPreviews":
      sectionHead(c, p, t, field);
      for (const item of arr(p.items).map(obj)) {
        label(c, t(item.title));
        paragraph(c, t(item.body), field);
      }
      break;
    case "workspaceSignin":
      heading(c, 2, t(p.goHeading), field);
      paragraph(c, t(p.goBody), field);
      heading(c, 2, t(p.findHeading), field);
      paragraph(c, t(p.findBody), field);
      break;
    case "signupForm": {
      heading(c, 1, t(p.heading), field);
      paragraph(c, t(ctx.signupOpen ? p.body : (p.bodyInviteOnly ?? p.body)), field);
      const asideItems = arr(p.asideItems);
      if (asideItems.length) {
        heading(c, 2, t(p.asideHeading), field);
        list(c, asideItems.map(t), false, field);
      }
      break;
    }
    case "comparisonTable": {
      // A table as the page shows it: a column per product, a row per feature, each answer as its word
      // ("Yes", "Partly", "No", or the words written); each row's source an external link, by its site's name.
      sectionHead(c, p, t, field);
      const competitor = t(p.competitor);
      const rows = arr(p.rows).map(obj);
      const mark = (v: unknown) => comparisonMark(t(v)).text;
      table(
        c,
        ["Feature", squash(ctx.settings.siteName), competitor],
        rows.map((r) => [[t(r.feature), t(r.note)].filter((x) => x.trim()).join(". "), mark(r.us), mark(r.them)]),
        field,
      );
      for (const r of rows) {
        const source = sourceSite(str(r.source));
        if (source) link(c, source.href, source.name, field);
      }
      const asOf = calendarDateLabel(str(p.asOf));
      if (asOf) paragraph(c, `Information about ${competitor} from its public website as of ${asOf}.`, field);
      paragraph(c, t(p.disclaimer), field);
      break;
    }
    case "relatedLinks":
      sectionHead(c, p, t, field);
      for (const l of arr(p.links).map(obj)) {
        if (!safeHref(str(l.href))?.startsWith("/")) continue;
        link(c, l.href, t(l.label), field);
        label(c, t(l.label));
        paragraph(c, t(l.description), field);
      }
      break;
    case "moduleHighlights":
      sectionHead(c, p, t, field);
      for (const group of arr(p.groups).map(obj)) {
        const items = arr(group.items)
          .map(obj)
          .filter((i) => safeHref(str(i.href))?.startsWith("/"));
        if (!items.length) continue;
        heading(c, 3, t(group.title), field);
        for (const item of items) {
          link(c, item.href, t(item.label), field);
          label(c, t(item.label));
          paragraph(c, t(item.description), field);
        }
      }
      break;
  }
}

function blocks(c: Collector, list: unknown, root: "blocks" | "body", ctx: FillCtx) {
  arr<SiteBlock>(list).forEach((b, i) => block(c, b, i, root, ctx));
}

/** A post card, as the blog and the archives list one: its title an h2 and a link, its excerpt, its cover. */
type PostCard = { title: string; path: string; excerpt: string | null; cover: SeoImage | null };

function postCards(c: Collector, posts: PostCard[]) {
  for (const post of posts) {
    if (post.cover) image(c, post.cover.src, post.cover.alt, null);
    heading(c, 2, str(post.title), null);
    link(c, post.path, str(post.title), null);
    paragraph(c, str(post.excerpt), null);
  }
}

function contentOf(c: Collector, breadcrumbs: SeoCrumb[]): SeoContent {
  const text = c.texts.join("\n");
  let firstSection = "";
  let words = 0;
  for (const p of c.paragraphs) {
    if (words >= 100) break;
    firstSection = firstSection ? `${firstSection}\n${p.text}` : p.text;
    words += p.words;
  }
  const firstParagraph = (c.paragraphs.find((p) => p.words >= 8) ?? c.paragraphs[0])?.text ?? "";
  return {
    h1s: c.headings.filter((h) => h.level === 1).map((h) => h.text),
    headings: c.headings,
    paragraphs: c.paragraphs,
    lists: c.lists,
    tables: c.tables,
    faqs: c.faqs,
    images: c.images,
    links: c.links,
    text,
    wordCount: countWords(text),
    firstSection,
    firstParagraph,
    breadcrumbs,
    blockTypes: c.blockTypes,
  };
}

const noEditorial: SeoEditorial = { author: null, publishedAt: null, updatedAt: null, categories: [], tags: [], excerpt: null, cover: null };

const withJsonLd = (input: Omit<SeoInput, "jsonLd">): SeoInput => ({ ...input, jsonLd: input.site.emitsJsonLd ? jsonLdFor(input) : [] });

const fillCtx = (site: SeoSiteContext): FillCtx => ({ settings: site.settings, trialDays: site.trialDays, signupOpen: site.signupOpen });

// ─── Pages ───────────────────────────────────────────────────────────────────────────────────────

export type PageSource = {
  /** The CMS id; "builtin-<slug>" for a built-in page never saved. Defaults to that. */
  id?: string;
  slug: string;
  /** Its name in the CMS. */
  title: string;
  /** SiteSeo, with the primary keywords (`keywords`, 0–3) once the CMS stores them. */
  // Stored keywords are read tolerantly (whatever an older or hand-edited document holds), so the
  // typed `keywords?: string[]` is swapped for `unknown` here rather than intersected with it.
  seo: Omit<SitePage["seo"], "keywords"> & { keywords?: unknown };
  blocks: SiteBlock[];
  /** Defaults to "published". */
  status?: SeoStatus;
  /** Defaults to whether the slug is a built-in page's. */
  isBuiltin?: boolean;
  /**
   * A nested page's ("product/crm") pages above it, nearest last, by title — those the site has; the
   * site shows them in its breadcrumb (Home › Product › CRM). Left out: the trail is Home › the page.
   */
  parents?: SeoCrumb[];
};

/** A page — the home page included — as the checks read it. */
export function inputFromPage(page: PageSource, site: SeoSiteContext, now: Date): SeoInput {
  const ctx = fillCtx(site);
  const slug = str(page.slug);
  // A nested page shows its place on the site above its content: Home, then the pages above it.
  const breadcrumbs: SeoCrumb[] = slug.includes("/") ? [{ name: "Home", path: "/" }, ...arr<SeoCrumb>(page.parents).filter((p) => str(p?.name).trim() && str(p?.path))] : [];
  const seo = (page.seo && typeof page.seo === "object" ? page.seo : { title: "", description: "" }) as SitePage["seo"];
  const doc = { slug, seo };
  const kind = slug === "home" ? "home" : "page";
  const metadata = buildPageMetadata(doc, ctx);
  const meta = effectiveMetadata(metadata, layoutView(ctx), pageMetaSources(doc, ctx));
  const c = collector();
  blocks(c, page.blocks, "blocks", ctx);
  const status = page.status ?? "published";
  return withJsonLd({
    kind,
    id: page.id ?? `builtin-${slug}`,
    slug,
    path: pagePath(slug),
    status,
    live: status === "published" || status === "default",
    isBuiltin: page.isBuiltin ?? isBuiltinSlug(slug),
    pageType: pageTypeFor(kind, slug),
    name: squash(fill(str(page.title), ctx)),
    meta,
    keywords: enteredKeywords(seo),
    content: contentOf(c, breadcrumbs),
    editorial: noEditorial,
    archive: null,
    site,
    now,
  });
}

// ─── Posts ───────────────────────────────────────────────────────────────────────────────────────

/** What a post is scored from — `SitePost` (src/lib/platform/site-content.ts) is one; the editor builds one from its draft. */
export type PostSource = {
  id?: string;
  slug: string;
  title: string;
  excerpt: string | null;
  cover: SeoImage | null;
  body: SiteBlock[];
  /** PostSeo, with the primary keywords (`keywords`, 0–3) once the CMS stores them. */
  seo: { title?: string; description?: string; ogImage?: string; noindex?: boolean; keywords?: unknown } | null;
  /** The author's name as the site shows it. */
  author: string | null;
  /** Its publishAt: when it went (or goes) live. */
  publishedAt: Date | null;
  updatedAt: Date | null;
  /** The main one first. */
  categories: { slug: string; name: string; path: string }[];
  tagLinks: { slug: string; name: string; path: string }[];
  /** Defaults to "published". */
  status?: SeoStatus;
};

/** A post as the checks read it: its header (the title is the H1, then the excerpt and the cover), then its body. */
export function inputFromPost(post: PostSource, site: SeoSiteContext, now: Date): SeoInput {
  const ctx = fillCtx(site);
  const slug = str(post.slug);
  const path = `/blog/${slug}`;
  const categories = arr<PostSource["categories"][number]>(post.categories);
  const tagLinks = arr<PostSource["tagLinks"][number]>(post.tagLinks);
  const validDate = (d: Date | null | undefined) => (d instanceof Date && Number.isFinite(d.getTime()) ? d : null);
  const publishedAt = validDate(post.publishedAt);
  const source = { title: str(post.title), path, excerpt: post.excerpt ?? null, seo: post.seo ?? null, cover: post.cover ?? null, publishedAt, categories, tagLinks };
  const metadata = buildPostMetadata(source);
  const meta = effectiveMetadata(metadata, layoutView(ctx), postMetaSources(source));
  const c = collector();
  heading(c, 1, source.title, "title");
  paragraph(c, str(post.excerpt), "excerpt");
  if (post.cover) image(c, post.cover.src, post.cover.alt, "coverMediaId");
  blocks(c, post.body, "body", ctx);
  const main = categories[0];
  const breadcrumbs: SeoCrumb[] = [{ name: "Blog", path: "/blog" }, ...(main ? [{ name: main.name, path: main.path }] : [])];
  const status = post.status ?? "published";
  return withJsonLd({
    kind: "post",
    id: post.id ?? path,
    slug,
    path,
    status,
    live: (status === "published" || status === "scheduled") && !!publishedAt && publishedAt.getTime() <= now.getTime(),
    isBuiltin: false,
    pageType: "article",
    name: squash(source.title),
    meta,
    keywords: enteredKeywords(post.seo),
    content: contentOf(c, breadcrumbs),
    editorial: {
      author: squash(post.author) || null,
      publishedAt,
      // The date the post shows as "Updated", if any (schema.ts `shownUpdatedAt`) — never an unseen one.
      updatedAt: shownUpdatedAt(publishedAt, validDate(post.updatedAt)),
      categories: categories.map((x) => x.name),
      tags: tagLinks.map((x) => x.name),
      excerpt: squash(post.excerpt) || null,
      cover: post.cover ?? null,
    },
    archive: null,
    site,
    now,
  });
}

// ─── Archives ────────────────────────────────────────────────────────────────────────────────────

/** A category's or tag's archive, from its record and its live posts. */
export type ArchiveSource = {
  kind: "category" | "tag";
  id?: string;
  slug: string;
  name: string;
  /** The term's own description — the text under its H1. */
  description: string | null;
  /** The stored TermSeo: title, description, imageMediaId, keywords. */
  seo: unknown;
  /** Its SEO image, looked up in the media library; null for none. */
  image: ArchiveSeoView["image"];
  /** The posts on this page of it, newest first. */
  posts: PostCard[];
  /** Live posts in it, every page. */
  total: number;
  page?: number;
  pages?: number;
  parent?: { name: string; path: string } | null;
};

export function inputFromArchive(archive: ArchiveSource, site: SeoSiteContext, now: Date): SeoInput {
  const slug = str(archive.slug);
  const name = str(archive.name);
  const path = archive.kind === "category" ? `/blog/category/${slug}` : `/blog/tag/${slug}`;
  const page = Math.max(1, Math.floor(archive.page ?? 1));
  const canonical = page <= 1 ? path : `${path}?page=${page}`;
  const description = archive.description?.trim() ? archive.description : null;
  const view = archiveSeoView(archive.seo, name, description, archive.image ?? null);
  const metadata = buildArchiveMetadata({ kind: archive.kind, name, page, canonical, seo: view }, site.settings);
  const meta = effectiveMetadata(metadata, layoutView(fillCtx(site)), archiveMetaSources(archive.seo, description, archive.image ?? null, site.settings));
  const c = collector();
  heading(c, 1, name, "name");
  paragraph(c, description ?? "", "description");
  postCards(c, arr<PostCard>(archive.posts));
  const breadcrumbs: SeoCrumb[] = [{ name: "Blog", path: "/blog" }, ...(archive.kind === "category" && archive.parent ? [{ name: archive.parent.name, path: archive.parent.path }] : [])];
  const total = Math.max(0, archive.total ?? 0);
  return withJsonLd({
    kind: archive.kind,
    id: archive.id ?? path,
    slug,
    path,
    status: "published",
    live: total > 0,
    isBuiltin: false,
    pageType: "archive",
    name: squash(name),
    meta,
    keywords: enteredKeywords(archive.seo),
    content: contentOf(c, breadcrumbs),
    editorial: noEditorial,
    archive: { page, pages: Math.max(archive.pages ?? 1, page), total },
    site,
    now,
  });
}

// ─── The blog index ──────────────────────────────────────────────────────────────────────────────

export function inputFromBlogIndex(source: { posts: PostCard[] }, site: SeoSiteContext, now: Date): SeoInput {
  const metadata = buildBlogIndexMetadata(site.settings);
  const meta = effectiveMetadata(metadata, layoutView(fillCtx(site)), BLOG_INDEX_SOURCES);
  const c = collector();
  label(c, site.siteName);
  heading(c, 1, "Blog", null);
  paragraph(c, BLOG_INDEX_INTRO, null);
  const posts = arr<PostCard>(source.posts);
  if (posts.length) postCards(c, posts);
  else {
    heading(c, 2, "No posts yet", null);
    paragraph(c, "Check back soon.", null);
  }
  return withJsonLd({
    kind: "blog-index",
    id: "blog-index",
    slug: "blog",
    path: "/blog",
    status: "published",
    live: true,
    isBuiltin: true,
    pageType: "blog-index",
    name: "Blog",
    meta,
    keywords: [],
    content: contentOf(c, []),
    editorial: noEditorial,
    archive: null,
    site,
    now,
  });
}

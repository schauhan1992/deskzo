import type { Metadata } from "next";
import type { SitePage, SiteSettings } from "@/components/site/blocks/types";
import { fill, safeSrc } from "@/components/site/links";
import { normaliseKeywords, uniqueKeywords } from "@/lib/seo/keywords";
import type { EffectiveMeta, SeoImage, SeoImageSource, SeoValueSource } from "@/lib/seo/types";

/**
 * The public site's metadata, built without a request: the same `Metadata` objects the site's
 * `generateMetadata` functions return today — src/components/site/page-view.tsx (the layout, pages,
 * the not-found page), src/app/platform-site/blog/page.tsx (the blog index), blog/[slug]/page.tsx
 * (a post) and blog/archive-view.tsx (a category's or tag's archive) — plus `keywords`, only when
 * the entity has some. `scripts/check-seo-core.ts` holds them equal to the site's own for every
 * built-in page, the layout, the blog index, an archive and a post.
 *
 * `effectiveMetadata` then resolves one the way Next does under the site's layout (the title
 * template, what a page inherits, the Twitter card Next fills in), so the engine scores what the
 * HTML actually carries.
 *
 * Pure and client-safe: the CMS editors build the same metadata live.
 */

/** What text tokens ({siteName}, {trialDays}…) are resolved with. */
export type MetaContext = { settings: SiteSettings; trialDays: number };

/** A page's address from its slug: "home" is "/". Mirrors `sitePath` in src/lib/platform/site-content.ts, which is server-only. */
export const pagePath = (slug: string): string => (slug === "home" ? "/" : `/${slug}`);

/** An entity's primary keywords from its stored SEO object, repeats dropped. */
export function keywordsOf(seo: unknown): string[] {
  const raw = seo && typeof seo === "object" ? (seo as { keywords?: unknown }).keywords : undefined;
  return uniqueKeywords(normaliseKeywords(raw));
}

/** `keywords` is added only when there are some: an entity without keeps the exact object the site has always built. */
const withKeywords = (metadata: Metadata, keywords: string[]): Metadata => (keywords.length ? { ...metadata, keywords } : metadata);

// ─── The builders ────────────────────────────────────────────────────────────────────────────────

/** The layout's: title template and default, description, Open Graph defaults (page-view.tsx `siteLayoutMetadata`). */
export function buildLayoutMetadata(ctx: MetaContext, origin: URL | undefined): Metadata {
  const { settings } = ctx;
  const image = safeSrc(settings.seo.ogImage);
  return {
    metadataBase: origin,
    title: { template: fill(settings.seo.titleTemplate, ctx), default: fill(settings.seo.defaultTitle, ctx) },
    description: fill(settings.seo.description, ctx),
    applicationName: settings.siteName,
    openGraph: { type: "website", siteName: settings.siteName, images: image ? [image] : undefined },
  };
}

/** An address the site has no page for (page-view.tsx `sitePageMetadata`'s not-found branch). */
export function buildNotFoundMetadata(ctx: MetaContext): Metadata {
  return { title: fill(ctx.settings.notFound.heading, ctx), robots: { index: false, follow: false } };
}

/** A page's: title, description, canonical, Open Graph, Twitter, robots when noindex (page-view.tsx `sitePageMetadata`). */
export function buildPageMetadata(page: Pick<SitePage, "slug" | "seo"> | null, ctx: MetaContext): Metadata {
  if (!page) return buildNotFoundMetadata(ctx);
  const title = fill(page.seo.title, ctx);
  const description = fill(page.seo.description, ctx);
  const image = safeSrc(page.seo.ogImage ?? ctx.settings.seo.ogImage);
  const path = pagePath(page.slug);
  return withKeywords(
    {
      title: page.seo.absoluteTitle ? { absolute: title } : title,
      description,
      alternates: { canonical: path },
      openGraph: {
        type: "website",
        siteName: ctx.settings.siteName,
        title: fill(page.seo.ogTitle, ctx) || title,
        description: fill(page.seo.ogDescription, ctx) || description,
        url: path,
        images: image ? [image] : undefined,
      },
      twitter: { card: image ? "summary_large_image" : "summary", title, description },
      robots: page.seo.noindex ? { index: false, follow: false } : undefined,
    },
    keywordsOf(page.seo),
  );
}

/** What a post's metadata reads — `SitePost` (src/lib/platform/site-content.ts) is one. */
export type PostMetaSource = {
  title: string;
  path: string;
  excerpt: string | null;
  seo: { title?: string; description?: string; ogImage?: string; noindex?: boolean; keywords?: unknown } | null;
  cover: { src: string } | null;
  /** Always set on the site; null only for a draft scored in the editor. */
  publishedAt: Date | null;
  categories: { name: string }[];
  tagLinks: { name: string }[];
};

/** A post's (blog/[slug]/page.tsx `generateMetadata`); null is the site's "Not found". */
export function buildPostMetadata(post: PostMetaSource | null): Metadata {
  if (!post) return { title: "Not found", robots: { index: false, follow: false } };
  const title = post.seo?.title || post.title;
  const description = post.seo?.description || post.excerpt || undefined;
  const image = safeSrc(post.seo?.ogImage ?? post.cover?.src);
  return withKeywords(
    {
      title,
      description,
      alternates: { canonical: post.path },
      openGraph: {
        type: "article",
        title,
        description,
        url: post.path,
        publishedTime: post.publishedAt ? post.publishedAt.toISOString() : undefined,
        section: post.categories[0]?.name,
        tags: post.tagLinks.map((t) => t.name),
        images: image ? [image] : undefined,
      },
      twitter: { card: image ? "summary_large_image" : "summary", title, description },
      robots: post.seo?.noindex ? { index: false, follow: false } : undefined,
    },
    keywordsOf(post.seo),
  );
}

/** An archive's search and sharing details as the site works them out: its own, else its name and description. */
export type ArchiveSeoView = { title: string; description: string | null; image: { src: string; alt: string; width: number | null; height: number | null } | null };

/** What an archive's metadata reads — `CategoryArchive` and `TagArchive` (src/lib/cms/taxonomy.ts) are. */
export type ArchiveMetaSource = { kind: "category" | "tag"; name: string; page: number; canonical: string; seo: ArchiveSeoView };

/**
 * A stored TermSeo worked out as the site does (src/lib/cms/taxonomy.ts `archiveSeo`): its title or
 * the name, its description or the term's, the image already looked up in the library. Carries the
 * keywords through for the metadata.
 */
export function archiveSeoView(stored: unknown, name: string, description: string | null, image: ArchiveSeoView["image"]): ArchiveSeoView & { keywords?: string[] } {
  const seo = (stored && typeof stored === "object" ? stored : {}) as { title?: unknown; description?: unknown };
  const own = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const keywords = keywordsOf(stored);
  return { title: own(seo.title) || name, description: own(seo.description) || description || null, image, ...(keywords.length ? { keywords } : {}) };
}

/** An archive page's (blog/archive-view.tsx `archiveMetadata`); null is the site's "Not found". */
export function buildArchiveMetadata(archive: ArchiveMetaSource | null, settings: SiteSettings): Metadata {
  if (!archive) return { title: "Not found", robots: { index: false, follow: false } };
  const title = archive.page > 1 ? `${archive.seo.title} (page ${archive.page})` : archive.seo.title;
  const description = archive.seo.description ?? `${archive.kind === "category" ? "Posts in" : "Posts tagged"} ${archive.name}, from ${settings.siteName}.`;
  const own = archive.seo.image;
  const ownSrc = own ? safeSrc(own.src) : null;
  const siteImage = safeSrc(settings.seo.ogImage);
  const images = own && ownSrc ? [{ url: ownSrc, alt: own.alt || undefined, width: own.width ?? undefined, height: own.height ?? undefined }] : siteImage ? [siteImage] : undefined;
  return withKeywords(
    {
      title,
      description,
      alternates: { canonical: archive.canonical },
      openGraph: { type: "website", siteName: settings.siteName, title, description, url: archive.canonical, images },
      twitter: { card: images ? "summary_large_image" : "summary", title, description },
    },
    keywordsOf(archive.seo),
  );
}

/** The blog index's, fixed in code (blog/page.tsx `generateMetadata`). */
export function buildBlogIndexMetadata(settings: SiteSettings): Metadata {
  return {
    title: "Blog",
    description: `News, product updates and notes from ${settings.siteName}.`,
    alternates: { canonical: "/blog" },
    openGraph: { type: "website", title: "Blog", url: "/blog" },
  };
}

// ─── Where each value came from ──────────────────────────────────────────────────────────────────

export type MetaSources = { title: SeoValueSource; description: SeoValueSource; ogImage: SeoImageSource };

/** A page: its own SEO title and description; its own sharing image, else the site's (`??`: an empty one is kept, and shows none). */
export function pageMetaSources(page: Pick<SitePage, "seo">, ctx: MetaContext): MetaSources {
  const image = safeSrc(page.seo.ogImage ?? ctx.settings.seo.ogImage);
  return {
    title: fill(page.seo.title, ctx).trim() ? "seo" : "none",
    description: fill(page.seo.description, ctx).trim() ? "seo" : "none",
    ogImage: !image ? "none" : page.seo.ogImage != null ? "own" : "site",
  };
}

/** A post: SEO title, else its title; SEO description, else the excerpt; its own image, else the cover — never the site's. */
export function postMetaSources(post: PostMetaSource): MetaSources {
  const image = safeSrc(post.seo?.ogImage ?? post.cover?.src);
  return {
    title: post.seo?.title ? "seo" : post.title ? "fallback" : "none",
    description: post.seo?.description ? "seo" : post.excerpt ? "fallback" : "none",
    ogImage: !image ? "none" : post.seo?.ogImage != null ? "own" : "cover",
  };
}

/** An archive: its SEO title, else its name; its SEO description, else its description, else a generated line; its image, else the site's. */
export function archiveMetaSources(stored: unknown, description: string | null, image: ArchiveSeoView["image"], settings: SiteSettings): MetaSources {
  const seo = (stored && typeof stored === "object" ? stored : {}) as { title?: unknown; description?: unknown };
  const own = (v: unknown) => typeof v === "string" && v.trim() !== "";
  return {
    title: own(seo.title) ? "seo" : "fallback",
    description: own(seo.description) ? "seo" : description ? "fallback" : "generated",
    ogImage: image && safeSrc(image.src) ? "own" : safeSrc(settings.seo.ogImage) ? "site" : "none",
  };
}

export const BLOG_INDEX_SOURCES: MetaSources = { title: "fixed", description: "fixed", ogImage: "fixed" };

// ─── What the HTML carries ───────────────────────────────────────────────────────────────────────

/** The layout's part in a page's metadata: the title template and default, the default description and sharing image. */
export type LayoutView = { titleTemplate: string; defaultTitle: string; description: string; ogImage: string | null };

export function layoutView(ctx: MetaContext): LayoutView {
  const { settings } = ctx;
  return {
    titleTemplate: fill(settings.seo.titleTemplate, ctx),
    defaultTitle: fill(settings.seo.defaultTitle, ctx),
    description: fill(settings.seo.description, ctx),
    ogImage: safeSrc(settings.seo.ogImage),
  };
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

function urlText(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v instanceof URL) return v.pathname + v.search;
  if (v && typeof v === "object" && "url" in v) return urlText((v as { url: unknown }).url);
  return null;
}

function firstImage(images: unknown): SeoImage | null {
  const first = Array.isArray(images) ? images[0] : images;
  if (!first) return null;
  if (typeof first === "string") return { src: first, alt: "" };
  if (first instanceof URL) return { src: first.href, alt: "" };
  if (typeof first === "object" && "url" in first) {
    const o = first as { url: unknown; alt?: unknown; width?: unknown; height?: unknown };
    const src = urlText(o.url);
    if (!src) return null;
    const num = (n: unknown) => (typeof n === "number" ? n : typeof n === "string" && n.trim() && Number.isFinite(Number(n)) ? Number(n) : null);
    return { src, alt: text(o.alt), width: num(o.width), height: num(o.height) };
  }
  return null;
}

/**
 * A page's `Metadata` as its HTML carries it under the site's layout, the way Next resolves it: a
 * string title goes into the template, an absolute one does not, no title is the layout's default;
 * a page's `openGraph` replaces the layout's whole (so no default image unless it says so); Open
 * Graph falls back to the title and description; with no `twitter`, Next fills a card from Open Graph.
 */
export function effectiveMetadata(metadata: Metadata, layout: LayoutView, sources?: Partial<MetaSources>): EffectiveMeta {
  const template = layout.titleTemplate;
  const t = metadata.title;
  let title = "";
  let rawTitle = "";
  let absolute = false;
  if (!("title" in metadata) || t === undefined) {
    title = rawTitle = layout.defaultTitle;
    absolute = true;
  } else if (typeof t === "string") {
    rawTitle = t;
    title = (template ? template.replace(/%s/g, t) : t) || t || "";
  } else if (t && typeof t === "object") {
    if ("absolute" in t && t.absolute) {
      title = rawTitle = t.absolute;
      absolute = true;
    } else if ("default" in t) {
      rawTitle = t.default;
      title = template ? template.replace(/%s/g, t.default) : t.default;
    }
  }
  const description = "description" in metadata ? (metadata.description ?? "") : layout.description;
  const robotsIn = metadata.robots;
  const robots =
    typeof robotsIn === "string"
      ? { index: !/\bnoindex\b/i.test(robotsIn), follow: !/\bnofollow\b/i.test(robotsIn) }
      : robotsIn
        ? { index: robotsIn.index !== false, follow: robotsIn.follow !== false }
        : { index: true, follow: true };
  const og = "openGraph" in metadata && metadata.openGraph ? metadata.openGraph : { images: layout.ogImage ?? undefined };
  const ogTitle = text((og as { title?: unknown }).title) || title;
  const ogDescription = text((og as { description?: unknown }).description) || description;
  const ogImage = firstImage((og as { images?: unknown }).images);
  const twitter = metadata.twitter;
  const hasOg = "openGraph" in metadata && !!metadata.openGraph;
  const twitterCard: EffectiveMeta["twitterCard"] =
    twitter && typeof twitter === "object" && "card" in twitter && (twitter.card === "summary" || twitter.card === "summary_large_image")
      ? twitter.card
      : twitter || hasOg
        ? ogImage
          ? "summary_large_image"
          : "summary"
        : null;
  const keywords = Array.isArray(metadata.keywords) ? metadata.keywords.filter((k): k is string => typeof k === "string") : typeof metadata.keywords === "string" && metadata.keywords ? [metadata.keywords] : [];
  return {
    title,
    rawTitle,
    titleSource: sources?.title ?? (rawTitle.trim() ? "seo" : "none"),
    templateAddition: absolute ? "" : template.replace(/%s/g, ""),
    description,
    descriptionSource: sources?.description ?? (description.trim() ? "seo" : "none"),
    canonical: urlText(metadata.alternates?.canonical),
    robots,
    ogTitle,
    ogDescription,
    ogImage,
    ogImageSource: sources?.ogImage ?? (ogImage ? "own" : "none"),
    twitterCard,
    keywords,
  };
}

import { safeHref, safeSrc } from "@/components/site/links";
import { istDateParts } from "@/lib/india-time";
import type { JsonLd, SeoCrumb, SeoInput } from "@/lib/seo/types";

/**
 * The site's structured data (owner decision S-D1): JSON-LD built only from what the page shows —
 * Organization and WebSite on the home page, WebPage and BreadcrumbList on pages, BlogPosting and
 * BreadcrumbList on posts, CollectionPage and BreadcrumbList on category and tag archives, FAQPage
 * only where the page has an FAQ block with a question and an answer. Nothing is invented to lift a
 * score: a missing author, date or image leaves the property out, never a placeholder.
 *
 * `serialiseLd` makes one safe inside a `<script type="application/ld+json">`. Pure and client-safe.
 */

const SCHEMA = "https://schema.org";

/**
 * The "Updated" date a post shows — and so the only `dateModified` its BlogPosting carries, since the
 * structured data describes what the page shows. A post counts as updated when its last change falls
 * on a later calendar day in India than the day it went live; otherwise null, and the BlogPosting's
 * dateModified is its published date.
 */
export function shownUpdatedAt(publishedAt: Date | null, updatedAt: Date | null): Date | null {
  if (!publishedAt || !updatedAt || Number.isNaN(publishedAt.getTime()) || Number.isNaN(updatedAt.getTime())) return null;
  const day = (d: Date) => {
    const p = istDateParts(d);
    return p.year * 10000 + (p.month + 1) * 100 + p.day;
  };
  return day(updatedAt) > day(publishedAt) ? updatedAt : null;
}

/** An absolute address from a site path and the site's origin; the path alone when the origin is unknown. */
export function absoluteUrl(origin: string, pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const base = origin.replace(/\/+$/, "");
  if (!base) return pathOrUrl;
  return `${base}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
}

const organizationId = (origin: string) => absoluteUrl(origin, "/#organization");
const websiteId = (origin: string) => absoluteUrl(origin, "/#website");

export type OrganizationLdSource = {
  siteName: string;
  origin: string;
  /** The social profiles the footer links to. */
  social: { href: string }[];
  /** A real logo image, when the site has one — the letter mark it shows today is not, so this is left out. */
  logo?: string | null;
};

/** The organisation behind the site: its name, address, social profiles, and a logo only when there is a real one. */
export function organizationLd(site: OrganizationLdSource): JsonLd {
  const sameAs = site.social.map((s) => safeHref(s.href)).filter((h): h is string => !!h && /^https?:/i.test(h));
  const logo = site.logo ? safeSrc(site.logo) : null;
  return {
    "@context": SCHEMA,
    "@type": "Organization",
    "@id": organizationId(site.origin),
    name: site.siteName,
    url: absoluteUrl(site.origin, "/"),
    ...(logo ? { logo: absoluteUrl(site.origin, logo) } : {}),
    ...(sameAs.length ? { sameAs } : {}),
  };
}

/** The site itself, for the home page: its name, address, what it says it is, and who publishes it. */
export function webSiteLd(site: { siteName: string; description?: string | null }, origin: string): JsonLd {
  return {
    "@context": SCHEMA,
    "@type": "WebSite",
    "@id": websiteId(origin),
    name: site.siteName,
    url: absoluteUrl(origin, "/"),
    ...(site.description?.trim() ? { description: site.description.trim() } : {}),
    publisher: { "@id": organizationId(origin) },
  };
}

/** A page: its address, its name (the H1 it shows) and its description. */
export function webPageLd(page: { path: string; name: string; description?: string | null }, origin: string): JsonLd {
  const url = absoluteUrl(origin, page.path);
  return {
    "@context": SCHEMA,
    "@type": "WebPage",
    "@id": `${url}#webpage`,
    url,
    name: page.name,
    ...(page.description?.trim() ? { description: page.description.trim() } : {}),
    isPartOf: { "@id": websiteId(origin) },
  };
}

/** A trail of pages, the current one last. Null for an empty trail. */
export function breadcrumbLd(trail: SeoCrumb[], origin: string): JsonLd | null {
  const items = trail.filter((c) => c.name.trim() && c.path);
  if (!items.length) return null;
  return {
    "@context": SCHEMA,
    "@type": "BreadcrumbList",
    itemListElement: items.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.name.trim(), item: absoluteUrl(origin, c.path) })),
  };
}

export type BlogPostingLdSource = {
  path: string;
  headline: string;
  description?: string | null;
  datePublished?: Date | null;
  dateModified?: Date | null;
  /** The author's name as the post shows it. */
  author?: string | null;
  /** The post's cover, which the page shows (a site path or https address) — not a sharing image it doesn't. */
  image?: string | null;
  /** The main category's name. */
  section?: string | null;
  /** Its tags' names. */
  keywords?: string[];
};

/** A post: headline, description, dates, author, publisher, image, main category, tags — each only when there is one. */
export function blogPostingLd(post: BlogPostingLdSource, site: { siteName: string; origin: string }): JsonLd {
  const url = absoluteUrl(site.origin, post.path);
  const image = post.image ? safeSrc(post.image) : null;
  const author = post.author?.trim();
  const valid = (d: Date | null | undefined): d is Date => d instanceof Date && Number.isFinite(d.getTime());
  return {
    "@context": SCHEMA,
    "@type": "BlogPosting",
    "@id": `${url}#article`,
    headline: post.headline,
    url,
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    ...(post.description?.trim() ? { description: post.description.trim() } : {}),
    ...(valid(post.datePublished) ? { datePublished: post.datePublished.toISOString() } : {}),
    ...(valid(post.dateModified) ? { dateModified: post.dateModified.toISOString() } : {}),
    ...(author ? { author: { "@type": "Person", name: author } } : {}),
    publisher: { "@type": "Organization", "@id": organizationId(site.origin), name: site.siteName, url: absoluteUrl(site.origin, "/") },
    ...(image ? { image: absoluteUrl(site.origin, image) } : {}),
    ...(post.section?.trim() ? { articleSection: post.section.trim() } : {}),
    ...(post.keywords?.length ? { keywords: post.keywords } : {}),
  };
}

/** A category's or tag's archive: a collection of posts. */
export function collectionPageLd(archive: { path: string; name: string; description?: string | null }, origin: string): JsonLd {
  const url = absoluteUrl(origin, archive.path);
  return {
    "@context": SCHEMA,
    "@type": "CollectionPage",
    "@id": `${url}#collection`,
    url,
    name: archive.name,
    ...(archive.description?.trim() ? { description: archive.description.trim() } : {}),
    isPartOf: { "@id": websiteId(origin) },
  };
}

/**
 * The page's visible questions and answers — only items with both, the answer as the page shows it.
 * Null when there are none: no FAQ block, no FAQPage.
 */
export function faqPageLd(faqs: { question: string; answer: string }[]): JsonLd | null {
  const items = faqs.filter((f) => f.question.trim() && f.answer.trim());
  if (!items.length) return null;
  return {
    "@context": SCHEMA,
    "@type": "FAQPage",
    mainEntity: items.map((f) => ({ "@type": "Question", name: f.question.trim(), acceptedAnswer: { "@type": "Answer", text: f.answer.trim() } })),
  };
}

/** The JSON-LD the site emits for an entity, in order. The blog index has none (S-D1 names none for it). */
export function jsonLdFor(input: Omit<SeoInput, "jsonLd">): JsonLd[] {
  const { site, content } = input;
  const origin = site.origin;
  const name = content.h1s[0]?.trim() || input.meta.rawTitle || input.name;
  const faq = faqPageLd(content.faqs);
  const out: (JsonLd | null)[] = [];
  switch (input.kind) {
    case "home":
      out.push(organizationLd({ siteName: site.siteName, origin, social: site.social }), webSiteLd({ siteName: site.siteName, description: site.description }, origin), faq);
      break;
    case "page":
      out.push(webPageLd({ path: input.path, name, description: input.meta.description }, origin), breadcrumbLd([{ name: "Home", path: "/" }, { name, path: input.path }], origin), faq);
      break;
    case "post": {
      const e = input.editorial;
      out.push(
        blogPostingLd(
          { path: input.path, headline: input.name, description: input.meta.description, datePublished: e.publishedAt, dateModified: e.updatedAt ?? e.publishedAt, author: e.author, image: e.cover?.src ?? null, section: e.categories[0] ?? null, keywords: e.tags },
          { siteName: site.siteName, origin },
        ),
        breadcrumbLd([...content.breadcrumbs, { name: input.name, path: input.path }], origin),
        faq,
      );
      break;
    }
    case "category":
    case "tag":
      out.push(collectionPageLd({ path: input.path, name: input.name, description: input.meta.description }, origin), breadcrumbLd([...content.breadcrumbs, { name: input.name, path: input.path }], origin));
      break;
    case "blog-index":
      break;
  }
  return out.filter((o): o is JsonLd => o !== null);
}

/**
 * JSON for inside a `<script>` element: `<`, `>` and `&` — and the two line separators JavaScript
 * once refused — become JSON unicode escapes, so no text in it ("</script>", "<!--") can end the
 * element or start markup. `JSON.parse` gives back exactly the original. The escapes are built from
 * character codes, never written into this file as escape sequences.
 */
export function serialiseLd(value: unknown): string {
  const backslash = String.fromCharCode(92);
  const unsafe = new RegExp(`[<>&${String.fromCharCode(0x2028, 0x2029)}]`, "g");
  return (JSON.stringify(value) ?? "null").replace(unsafe, (c) => `${backslash}u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

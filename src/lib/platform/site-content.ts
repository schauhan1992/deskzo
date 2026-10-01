import { cache as requestCache } from "react";
import type { Prisma } from "@deskzo/control-client";
import type { SiteBlock, SitePage, SiteSettings } from "@/components/site/blocks/types";
import { DEFAULT_SITE_PAGES, DEFAULT_SITE_SETTINGS } from "@/components/site/defaults";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { signupOpen, trialDays } from "@/lib/platform/settings";
import { PLATFORM_DOMAIN, protocolFor } from "@/lib/tenancy/host";

/**
 * The public website's content — the one way every page, the header, the footer and the blog get
 * their words.
 *
 * Published content comes from the website CMS (cms.<domain>, src/lib/cms), kept in the control
 * plane: a page the CMS has published replaces its default, settings the CMS has published are laid
 * over the defaults (so a field added later keeps its default), and posts appear once published —
 * or, when scheduled, once their time has come. Anything not published is the default in
 * src/components/site/defaults.ts. Drafts never reach here (a draft's preview is its own route).
 *
 *   · Reads are cached for the whole process for 45 seconds: the site's content is the same for every
 *     visitor and holds no workspace's data. Publishing in the CMS clears the cache in the process
 *     that published (`invalidateSiteContent`); other processes catch up within the 45 seconds.
 *   · Reads fail soft: without a control plane, or with it unreachable, the site shows its defaults
 *     (and no posts), and says so in the log at most once every ten minutes.
 *
 * Shapes: src/components/site/blocks/types.ts. Nothing here is about a workspace.
 */

/** A page's address on the site from its slug: "home" is "/". */
export function sitePath(slug: string): string {
  return slug === "home" ? "/" : `/${slug}`;
}

/** Lower-case words and hyphens, "/" between levels: "pricing", "solutions/retail". */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
/** A post's slug, and a category's or tag's (at most 60). */
const POST_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TERM_SLUG_MAX = 60;
export const POSTS_PER_PAGE = 12;

/** The public site's own address: <PLATFORM_DOMAIN>[:PLATFORM_PORT], for links made elsewhere (the CMS's preview links). */
export function siteOrigin(): string {
  const host = `${PLATFORM_DOMAIN}${process.env.PLATFORM_PORT?.trim() ? `:${process.env.PLATFORM_PORT.trim()}` : ""}`;
  return `${protocolFor(host)}://${host}`;
}

// ─── The cache ───────────────────────────────────────────────────────────────────────────────────

const TTL_MS = 45_000;
/** A failed read's fallback is kept briefly, so an unreachable database is not asked on every request. */
const FALLBACK_TTL_MS = 10_000;
const MAX_ENTRIES = 500;
type Entry = { at: number; ttl: number; value: unknown };
const cache = new Map<string, Entry>();
/** Bumped by every invalidation: a read that began before it does not store what it read. */
let generation = 0;
let lastFailureLog = 0;

/** Forgets every cached read — called by the CMS whenever something published changes. */
export function invalidateSiteContent(): void {
  generation += 1;
  cache.clear();
}

function logFailure(err: unknown) {
  const now = Date.now();
  if (now - lastFailureLog < 10 * 60_000) return;
  lastFailureLog = now;
  const code = (err as { code?: string } | null)?.code;
  console.warn(`[site] published content unavailable, showing the defaults: ${code ?? (err instanceof Error ? err.name : "error")}`);
}

async function cached<T>(key: string, load: () => Promise<T>, fallback: () => T): Promise<T> {
  if (!controlConfigured()) return fallback();
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < hit.ttl) return hit.value as T;
  const started = generation;
  let value: T;
  let ttl = TTL_MS;
  try {
    value = await load();
  } catch (err) {
    logFailure(err);
    value = fallback();
    ttl = FALLBACK_TTL_MS;
  }
  if (started === generation) {
    cache.delete(key);
    if (cache.size >= MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { at: now, ttl, value });
  }
  return value;
}

/**
 * A read of the site's published content through the same cache — for the blog's category and tag
 * archives (src/lib/cms/taxonomy.ts): 45 seconds, cleared by `invalidateSiteContent`, `fallback`
 * when the control plane is missing or fails. Keys are the caller's: prefix them ("taxonomy:…").
 */
export function cachedSiteRead<T>(key: string, load: () => Promise<T>, fallback: () => T): Promise<T> {
  return cached(key, load, fallback);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// ─── Settings ────────────────────────────────────────────────────────────────────────────────────

/**
 * Stored settings laid over the defaults, a level deep: a field the stored copy lacks keeps its default.
 * The header's `nav` is a list of links and menus; settings saved before menus existed hold links
 * only, which are items as they are (src/components/site/nav.ts reads either).
 */
export function mergeSiteSettings(stored: unknown): SiteSettings {
  if (!isObj(stored)) return DEFAULT_SITE_SETTINGS;
  const s = stored as Partial<SiteSettings>;
  const d = DEFAULT_SITE_SETTINGS;
  return {
    ...d,
    ...s,
    nav: Array.isArray(s.nav) ? s.nav : d.nav,
    signupCta: { ...d.signupCta, ...(isObj(s.signupCta) ? s.signupCta : {}) },
    footer: { ...d.footer, ...(isObj(s.footer) ? s.footer : {}) },
    seo: { ...d.seo, ...(isObj(s.seo) ? s.seo : {}) },
    notFound: { ...d.notFound, ...(isObj(s.notFound) ? s.notFound : {}) },
  };
}

export async function getSiteSettings(): Promise<SiteSettings> {
  return cached(
    "settings",
    async () => {
      const row = await controlDb().siteSettings.findUnique({ where: { key: "site" }, select: { published: true } });
      return mergeSiteSettings(row?.published);
    },
    () => DEFAULT_SITE_SETTINGS,
  );
}

// ─── Pages ───────────────────────────────────────────────────────────────────────────────────────

type PublishedPage = { page: SitePage; publishedAt: Date | null };

/** A stored page document as the site's SitePage, or null when it is not one (then the default stands). */
function asSitePage(slug: string, doc: unknown): SitePage | null {
  if (!isObj(doc) || !Array.isArray(doc.blocks) || !isObj(doc.seo)) return null;
  return { slug, title: String(doc.title ?? ""), seo: doc.seo as unknown as SitePage["seo"], blocks: doc.blocks as SiteBlock[] };
}

/** Every published, unarchived CMS page, by slug — one query for the whole site. */
async function publishedPages(): Promise<Map<string, PublishedPage>> {
  return cached(
    "pages",
    async () => {
      const rows = await controlDb().sitePage.findMany({ where: { status: "PUBLISHED", archivedAt: null }, select: { slug: true, published: true, publishedAt: true } });
      const map = new Map<string, PublishedPage>();
      for (const row of rows) {
        const page = asSitePage(row.slug, row.published);
        if (page) map.set(row.slug, { page, publishedAt: row.publishedAt });
      }
      return map;
    },
    () => new Map(),
  );
}

/** The page at this slug, or null when the site has none. */
export async function getSitePage(slug: string): Promise<SitePage | null> {
  if (!SLUG_PATTERN.test(slug)) return null;
  const published = (await publishedPages()).get(slug);
  return published?.page ?? DEFAULT_SITE_PAGES.find((page) => page.slug === slug) ?? null;
}

export type SitePageSummary = { slug: string; path: string; title: string; indexable: boolean; updatedAt: Date | null };

/** Every page — the built-in ones (as published, or their defaults) and those the CMS added — for the sitemap. */
export async function listSitePages(): Promise<SitePageSummary[]> {
  const published = await publishedPages();
  const builtins = DEFAULT_SITE_PAGES.map((page) => {
    const cms = published.get(page.slug);
    const shown = cms?.page ?? page;
    return { slug: page.slug, path: sitePath(page.slug), title: shown.title, indexable: !shown.seo.noindex, updatedAt: cms?.publishedAt ?? null };
  });
  const added = [...published.values()]
    .filter(({ page }) => !DEFAULT_SITE_PAGES.some((d) => d.slug === page.slug))
    .sort((a, b) => a.page.slug.localeCompare(b.page.slug))
    .map(({ page, publishedAt }) => ({ slug: page.slug, path: sitePath(page.slug), title: page.title, indexable: !page.seo.noindex, updatedAt: publishedAt }));
  return [...builtins, ...added];
}

// ─── Posts ───────────────────────────────────────────────────────────────────────────────────────

/** `keywords`: the post's primary keywords (0–3), absent when none — read tolerantly (`normaliseKeywords`), as older posts have none. */
export type SitePostSeo = { title?: string; description?: string; ogImage?: string; noindex?: boolean; keywords?: string[] };
export type SitePostCover = { src: string; alt: string; width: number | null; height: number | null };
/** A category or tag as the site links to it: its name and its archive's address. */
export type SiteTermLink = { slug: string; name: string; path: string };
export type SitePostSummary = {
  slug: string;
  path: string;
  title: string;
  excerpt: string | null;
  cover: SitePostCover | null;
  /** Its tags' slugs, by name (the same tags, linked: `tagLinks`). */
  tags: string[];
  /** Its categories, the main one first — the breadcrumb is Blog › categories[0] › the post. */
  categories: SiteTermLink[];
  tagLinks: SiteTermLink[];
  /** When it went (or goes) live: its publishAt. */
  publishedAt: Date;
  author: string;
};
export type SitePost = SitePostSummary & { body: SiteBlock[]; seo: SitePostSeo | null; updatedAt: Date };

/** On the site: published or scheduled, not archived, and its time has come. */
export const livePostWhere = (now: Date) => ({ status: { in: ["PUBLISHED" as const, "SCHEDULED" as const] }, archivedAt: null, publishAt: { lte: now } });
const liveWhere = livePostWhere;

/** Images from the media library by id, with their alt text and size — a post's cover, an archive's sharing image. */
export async function siteImages(ids: (string | null | undefined)[]): Promise<Map<string, SitePostCover>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (!wanted.length) return new Map();
  const rows = await controlDb().siteMedia.findMany({ where: { id: { in: wanted } }, select: { id: true, alt: true, width: true, height: true } });
  return new Map(rows.map((m) => [m.id, { src: `/media/${m.id}`, alt: m.alt, width: m.width, height: m.height }]));
}
const covers = siteImages;

const POST_SUMMARY_SELECT = {
  slug: true,
  title: true,
  excerpt: true,
  coverMediaId: true,
  publishAt: true,
  author: { select: { name: true } },
  categories: { orderBy: { position: "asc" }, select: { category: { select: { slug: true, name: true } } } },
  tagLinks: { orderBy: { tag: { name: "asc" } }, select: { tag: { select: { slug: true, name: true } } } },
} as const satisfies Prisma.SitePostSelect;
type PostSummaryRow = Prisma.SitePostGetPayload<{ select: typeof POST_SUMMARY_SELECT }>;

function summaryOf(r: PostSummaryRow, cover: SitePostCover | null): SitePostSummary {
  return {
    slug: r.slug,
    path: `/blog/${r.slug}`,
    title: r.title,
    excerpt: r.excerpt,
    cover,
    tags: r.tagLinks.map((l) => l.tag.slug),
    categories: r.categories.map((c) => ({ slug: c.category.slug, name: c.category.name, path: `/blog/category/${c.category.slug}` })),
    tagLinks: r.tagLinks.map((l) => ({ slug: l.tag.slug, name: l.tag.name, path: `/blog/tag/${l.tag.slug}` })),
    publishedAt: r.publishAt!,
    author: r.author.name,
  };
}

/**
 * One page of live posts matching `where` (laid over "live now"), newest first, 12 a page — not
 * cached: the callers cache (the blog here, the archives in src/lib/cms/taxonomy.ts).
 */
export async function livePostsPage(where: Prisma.SitePostWhereInput, page: number, now = new Date()): Promise<{ posts: SitePostSummary[]; total: number; page: number; pages: number }> {
  const filter: Prisma.SitePostWhereInput = { AND: [liveWhere(now), where] };
  const [rows, total] = await Promise.all([
    controlDb().sitePost.findMany({ where: filter, orderBy: [{ publishAt: "desc" }, { id: "desc" }], skip: (page - 1) * POSTS_PER_PAGE, take: POSTS_PER_PAGE, select: POST_SUMMARY_SELECT }),
    controlDb().sitePost.count({ where: filter }),
  ]);
  const coverMap = await covers(rows.map((r) => r.coverMediaId));
  return { posts: rows.map((r) => summaryOf(r, (r.coverMediaId && coverMap.get(r.coverMediaId)) || null)), total, page, pages: Math.ceil(total / POSTS_PER_PAGE) };
}

/** One page of the blog, newest first — optionally one tag's (by its slug). */
export async function getPublishedPosts(options: { tag?: string | null; page?: number } = {}): Promise<{ posts: SitePostSummary[]; total: number; page: number; pages: number; tag: string | null }> {
  const tag = options.tag && options.tag.length <= TERM_SLUG_MAX && POST_SLUG.test(options.tag) ? options.tag : null;
  const page = Math.min(1000, Math.max(1, Math.floor(Number(options.page) || 1)));
  const empty = { posts: [], total: 0, page, pages: 0, tag };
  return cached(
    `posts:${tag ?? ""}:${page}`,
    async () => ({ ...(await livePostsPage(tag ? { tagLinks: { some: { tag: { slug: tag } } } } : {}, page)), tag }),
    () => empty,
  );
}

/** A published post by its slug, or null (unknown, a draft, archived, or scheduled for later). */
export async function getPublishedPost(slug: string): Promise<SitePost | null> {
  if (!POST_SLUG.test(slug) || slug.length > 120) return null;
  return cached(
    `post:${slug}`,
    async () => {
      const row = await controlDb().sitePost.findFirst({ where: { slug, ...liveWhere(new Date()) }, select: { ...POST_SUMMARY_SELECT, body: true, seo: true, updatedAt: true } });
      if (!row) return null;
      const cover = row.coverMediaId ? ((await covers([row.coverMediaId])).get(row.coverMediaId) ?? null) : null;
      return {
        ...summaryOf(row, cover),
        body: Array.isArray(row.body) ? (row.body as unknown as SiteBlock[]) : [],
        seo: isObj(row.seo) ? (row.seo as SitePostSeo) : null,
        updatedAt: row.updatedAt,
      };
    },
    () => null,
  );
}

/** Every live post's address and last change, for the sitemap (at most 5,000). */
export async function listSitePosts(): Promise<{ path: string; updatedAt: Date; indexable: boolean }[]> {
  return cached(
    "posts:sitemap",
    async () => {
      const rows = await controlDb().sitePost.findMany({ where: liveWhere(new Date()), orderBy: { publishAt: "desc" }, take: 5000, select: { slug: true, updatedAt: true, seo: true } });
      return rows.map((r) => ({ path: `/blog/${r.slug}`, updatedAt: r.updatedAt, indexable: !(isObj(r.seo) && r.seo.noindex === true) }));
    },
    () => [],
  );
}

/**
 * What the site shows that is the platform's to decide, not the CMS's: whether anybody may sign up,
 * and how long the trial is (src/lib/platform/settings.ts). Once per request however many blocks ask.
 * Without a control plane, or with it unreachable, the site still renders — by invitation, the
 * usual trial — rather than failing every page.
 */
export const siteStatus = requestCache(async (): Promise<{ signupOpen: boolean; trialDays: number }> => {
  if (!controlConfigured()) return { signupOpen: false, trialDays: 14 };
  try {
    const [open, days] = await Promise.all([signupOpen(), trialDays()]);
    return { signupOpen: open, trialDays: days };
  } catch (err) {
    console.warn(`[site] platform settings unavailable, showing the defaults: ${err instanceof Error ? err.message : String(err)}`);
    return { signupOpen: false, trialDays: 14 };
  }
});

/** ".<PLATFORM_DOMAIN>[:port]" — what follows a workspace's name in its address. */
export function workspaceSuffix(): string {
  const port = process.env.PLATFORM_PORT?.trim() ? `:${process.env.PLATFORM_PORT.trim()}` : "";
  return `.${PLATFORM_DOMAIN}${port}`;
}

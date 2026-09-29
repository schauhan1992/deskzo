import { createHash } from "node:crypto";
import type { Prisma, SeoEntityType } from "@wroffy/control-client";
import type { SiteBlock, SiteSeo, SiteSettings } from "@/components/site/blocks/types";
import { DEFAULT_SITE_PAGES, DEFAULT_SITE_SETTINGS } from "@/components/site/defaults";
import { CMS_ROUTES } from "@/lib/cms/nav";
import { findRule, indexRules, normalisePath, redirectablePath } from "@/lib/cms/redirect-rules";
import {
  BUILTIN_PAGE_SLUGS,
  CmsRefused,
  SEO_BATCH_SIZE,
  SEO_BATCH_SIZE_MAX,
  SEO_BLOG_INDEX_KEY,
  SEO_ENTITY_TYPES,
  SEO_PAGE_SIZE,
  SEO_PAGE_SIZE_MAX,
  SEO_SCORE_STATUSES,
  SEO_SORTS,
  type Paged,
  type SeoBatchResult,
  type SeoEditorContext,
  type SeoListFilters,
  type SeoScoreDetail,
  type SeoScoreRow,
  type SeoScoreStatus,
  type SeoSiteSummary,
} from "@/lib/cms/types";
import { mediaIdsIn, PAGE_SLUG, stableJson } from "@/lib/cms/validate";
import { controlDb } from "@/lib/platform/control-db";
import { signupOpen, trialDays } from "@/lib/platform/settings";
import { mergeSiteSettings, POSTS_PER_PAGE, siteOrigin, sitePath } from "@/lib/platform/site-content";
import {
  ATTENTION_BELOW,
  ENGINE_VERSION,
  EXPECTED_LD,
  inputFromArchive,
  inputFromBlogIndex,
  inputFromPage,
  inputFromPost,
  labelFor,
  otherEntityOf,
  scoreEntity,
  seoStatusOf,
  siteContextFrom,
  siteScore,
  type CheckResult,
  type EntityScore,
  type SeoEntityKind,
  type SeoImage,
  type SeoInput,
  type SeoOtherEntity,
  type SeoSiteContext,
  type SiteScoreEntry,
} from "@/lib/seo";
import { aiSearchCrawlersAllowed, PUBLIC_SITE_DISALLOW } from "@/lib/seo/crawlers";

/**
 * SEO Intelligence's score cache (control `seo_scores`): the latest calculation of every page, post,
 * category and tag archive and the blog index, as the site shows it now — for the CMS's dashboard.
 * The content stays the source of truth; this is only what the pure engine (src/lib/seo) made of it.
 *
 * What is scored — each entity's **live** version:
 *   · a page (keyed by its slug): its published document; for a built-in page never published, its
 *     default content ("default"); for an added page never published, its draft ("draft");
 *   · every post not archived, live or not ("published", "scheduled", "draft");
 *   · every category and tag (their archive's first page: live posts, 12 a page), and the blog index.
 *
 * A cached row is **stale** when:
 *   · what was scored changed: its content timestamp moved (a page's publishedAt, or a draft's
 *     updatedAt; a post's updatedAt, its publishAt once that has passed, and its categories' and tags'
 *     updatedAt; an archive's updatedAt, its parent's, and the newest change among its live posts;
 *     the blog index's newest live post), or what a timestamp can't show did (`facts.version`: a
 *     built-in page's default content, fingerprinted; an archive's or the blog's live-post count), or
 *     the status it was scored in (published, draft…) is no longer the one it has;
 *   · the site settings were published after it was calculated;
 *   · the engine's version (ENGINE_VERSION) is not the one it was calculated with.
 * Something new has no row ("uncalculated"); a row for something deleted or archived is dropped
 * whenever the cache is assessed. Not tracked (documented in the report): a media library alt edit,
 * a redirect, the platform's trial length, an author's rename, and another entity's title changing
 * (the duplicate checks) — "Recalculate all" with `all: true` recalculates everything.
 *
 * Loading is by kind, never by entity: one query each for the settings, pages, posts (with their
 * term links), categories, tags, redirects and the cached rows — then, per batch, the bodies of the
 * posts being scored and every library image the batch shows, one query each. The site around the
 * entities (settings, the AI-crawler policy from src/lib/seo/crawlers.ts, the redirects, and every
 * live entity's title, description and H1 for the duplicate checks) is built once per call.
 *
 * Scoring never runs on a public request: only the CMS calls this (its dashboard's actions, and
 * content.ts / taxonomy.ts right after a publish or a live save, through `refreshSeoScores`).
 */

/** The site emits S-D1's JSON-LD (src/lib/seo/schema.ts, wired by the public site's routes). */
const SITE_EMITS_JSON_LD = true;
const TYPE_ORDER: Record<SeoEntityType, number> = { PAGE: 0, BLOG_INDEX: 1, POST: 2, CATEGORY: 3, TAG: 4 };
/** A media library id (always the app's own cuid). */
const CUID = /^[a-z0-9]{20,40}$/;
/** A post's, category's or tag's id: a cuid — or, for a tag the taxonomy migration backfilled from old free-text tags, a UUID. */
const ENTITY_ID = /^[a-z0-9][a-z0-9-]{19,39}$/;

export type SeoEntityRef = { type: SeoEntityType; key: string };

const refOf = (r: SeoEntityRef): string => `${r.type}:${r.key}`;

/** Why a (type, key) pair names nothing that can be scored, or null when it is well-formed. */
export function seoRefProblem(type: unknown, key: unknown): string | null {
  if (typeof type !== "string" || !(SEO_ENTITY_TYPES as readonly string[]).includes(type)) return "Not something the dashboard scores.";
  const k = typeof key === "string" ? key : "";
  switch (type as SeoEntityType) {
    case "PAGE":
      return k.length <= 120 && PAGE_SLUG.test(k) ? null : "Not a page's address.";
    case "BLOG_INDEX":
      return k === SEO_BLOG_INDEX_KEY ? null : `The blog index's key is "${SEO_BLOG_INDEX_KEY}".`;
    default:
      return ENTITY_ID.test(k) ? null : "Not an id.";
  }
}

/** A "Recalculate all" cursor ("POST:<id>"), checked; throws a refusal when it is not one. */
export function parseSeoCursor(cursor: unknown): SeoEntityRef | null {
  if (cursor === undefined || cursor === null || cursor === "") return null;
  const m = typeof cursor === "string" && cursor.length <= 160 ? /^([A-Z_]+):(.+)$/.exec(cursor) : null;
  if (!m || seoRefProblem(m[1], m[2])) throw new CmsRefused("That is not a recalculation cursor. Start again from the beginning.");
  return { type: m[1] as SeoEntityType, key: m[2] };
}

function compareRefs(a: SeoEntityRef, b: SeoEntityRef): number {
  return TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

// ─── The snapshot: what the site has now, loaded by kind ─────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const latest = (dates: (Date | null | undefined)[]): Date | null => {
  let out: Date | null = null;
  for (const d of dates) if (d && (!out || d.getTime() > out.getTime())) out = d;
  return out;
};
const sameTime = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);

type PageDoc = { title: string; seo: SiteSeo; blocks: SiteBlock[] };

/** A stored page document as the site reads one (site-content.ts asSitePage), or null. */
function pageDoc(doc: unknown): PageDoc | null {
  if (!isObj(doc) || !Array.isArray(doc.blocks) || !isObj(doc.seo)) return null;
  return { title: String(doc.title ?? ""), seo: doc.seo as unknown as SiteSeo, blocks: doc.blocks as SiteBlock[] };
}

/** A built-in page's default content, fingerprinted: it lives in code, so only a deploy changes it. */
const fingerprint = (value: unknown) => createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 16);

const PAGE_SELECT = { id: true, slug: true, title: true, status: true, draft: true, published: true, publishedAt: true, updatedAt: true } as const satisfies Prisma.SitePageSelect;
const POST_SELECT = {
  id: true,
  slug: true,
  title: true,
  excerpt: true,
  seo: true,
  status: true,
  publishAt: true,
  updatedAt: true,
  coverMediaId: true,
  author: { select: { name: true } },
  categories: { orderBy: { position: "asc" }, select: { categoryId: true } },
  tagLinks: { select: { tagId: true } },
} as const satisfies Prisma.SitePostSelect;
const TERM_SELECT = { id: true, slug: true, name: true, description: true, seo: true, updatedAt: true } as const;

type PageRow = Prisma.SitePageGetPayload<{ select: typeof PAGE_SELECT }>;
type PostRow = Prisma.SitePostGetPayload<{ select: typeof POST_SELECT }>;
type TermRow = { id: string; slug: string; name: string; description: string | null; seo: unknown; updatedAt: Date; parentId: string | null };

/** What a cached row's `breakdown` carries beside the EntityScore: what the dashboard needs without reading every check. */
type SeoScoreFacts = {
  kind: SeoEntityKind;
  slug: string;
  isBuiltin: boolean;
  live: boolean;
  keywords: string[];
  jsonLdTypes: string[];
  robotsConflict: boolean;
  /** See `Spec.version`. */
  version: string | null;
  cmsId: string | null;
};

/** A cached row, without its checks. */
type CacheRow = {
  type: SeoEntityType;
  key: string;
  path: string;
  title: string;
  status: string;
  indexable: boolean;
  seoScore: number;
  aeoScore: number;
  geoScore: number;
  overallScore: number;
  critical: number;
  warnings: number;
  missingMetadata: boolean;
  missingSchema: boolean;
  missingKeywords: boolean;
  engineVersion: number;
  contentUpdatedAt: Date | null;
  calculatedAt: Date;
  excluded: boolean;
  facts: SeoScoreFacts;
};

type Source =
  | { kind: "page"; doc: PageDoc; isBuiltin: boolean; row: PageRow | null }
  | { kind: "post"; post: PostRow }
  | { kind: "category" | "tag"; term: TermRow; parent: TermRow | null; members: PostRow[] }
  | { kind: "blog"; members: PostRow[] };

/** One thing on the site that can be scored, as it is now. */
type Spec = SeoEntityRef & {
  path: string;
  title: string;
  status: SeoScoreStatus;
  live: boolean;
  /** When what is scored last changed, as the database says. */
  contentAt: Date | null;
  /** What a timestamp can't show: "d:<hash>" of a built-in page's default content, "n:<count>" of an archive's or the blog's live posts. */
  version: string | null;
  /** The CMS's id: a page's row id (or "builtin-<slug>"), a post's, a term's; null for the blog index. */
  cmsId: string | null;
  source: Source;
};

type Snapshot = {
  now: Date;
  settings: SiteSettings;
  settingsPublishedAt: Date | null;
  signupOpen: boolean;
  trialDays: number;
  specs: Spec[];
  categories: Map<string, TermRow>;
  tags: Map<string, TermRow>;
  redirectRules: { id: string; fromPath: string; toUrl: string; match: "EXACT" | "PREFIX" }[];
  /** Every cached row by "TYPE:key" — loaded only when asked for. */
  cache: Map<string, CacheRow>;
};

function factsOf(raw: unknown): SeoScoreFacts {
  const f = isObj(raw) ? raw : {};
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    kind: (typeof f.kind === "string" ? f.kind : "page") as SeoEntityKind,
    slug: typeof f.slug === "string" ? f.slug : "",
    isBuiltin: f.isBuiltin === true,
    live: f.live === true,
    keywords: strings(f.keywords),
    jsonLdTypes: strings(f.jsonLdTypes),
    robotsConflict: f.robotsConflict === true,
    version: typeof f.version === "string" ? f.version : null,
    cmsId: typeof f.cmsId === "string" ? f.cmsId : null,
  };
}

async function loadCache(): Promise<Map<string, CacheRow>> {
  const rows = await controlDb().$queryRaw<(Omit<CacheRow, "facts" | "excluded"> & { facts: unknown; excluded: boolean | null })[]>`
    SELECT "entityType"::text AS "type", "entityKey" AS "key", path, title, status, indexable,
           "seoScore", "aeoScore", "geoScore", "overallScore", critical, warnings,
           "missingMetadata", "missingSchema", "missingKeywords", "engineVersion", "contentUpdatedAt", "calculatedAt",
           (breakdown->>'excluded')::boolean AS excluded, breakdown->'facts' AS facts
    FROM seo_scores`;
  return new Map(rows.map((r) => [refOf(r), { ...r, excluded: r.excluded === true, facts: factsOf(r.facts) }]));
}

/** The whole site, loaded by kind — a fixed number of queries however much there is. */
async function loadSnapshot(options: { cache: boolean }): Promise<Snapshot> {
  const now = new Date();
  const db = controlDb();
  const [settingsRow, open, days, pages, posts, categoryRows, tagRows, redirectRules, cache] = await Promise.all([
    db.siteSettings.findUnique({ where: { key: "site" }, select: { published: true, publishedAt: true } }),
    signupOpen(),
    trialDays(),
    db.sitePage.findMany({ where: { archivedAt: null }, select: PAGE_SELECT }),
    db.sitePost.findMany({ where: { archivedAt: null }, orderBy: [{ publishAt: "desc" }, { id: "desc" }], select: POST_SELECT }),
    db.siteCategory.findMany({ select: { ...TERM_SELECT, parentId: true } }),
    db.siteTag.findMany({ select: TERM_SELECT }),
    db.siteRedirect.findMany({ where: { enabled: true }, select: { id: true, fromPath: true, toUrl: true, match: true } }),
    options.cache ? loadCache() : Promise.resolve(new Map<string, CacheRow>()),
  ]);
  const categories = new Map(categoryRows.map((c) => [c.id, c]));
  const tags = new Map(tagRows.map((t) => [t.id, { ...t, parentId: null }]));
  const specs: Spec[] = [];

  // Pages: the built-in ones (published, else their defaults), then those added (published, else their draft).
  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  const builtin = (slug: string) => (BUILTIN_PAGE_SLUGS as readonly string[]).includes(slug);
  for (const slug of BUILTIN_PAGE_SLUGS) {
    const row = bySlug.get(slug) ?? null;
    const published = row?.status === "PUBLISHED" ? pageDoc(row.published) : null;
    const fallback = DEFAULT_SITE_PAGES.find((p) => p.slug === slug);
    const doc = published ?? (fallback ? { title: fallback.title, seo: fallback.seo, blocks: fallback.blocks } : null);
    if (!doc) continue;
    specs.push({
      type: "PAGE",
      key: slug,
      path: sitePath(slug),
      title: doc.title || slug,
      status: published ? "published" : "default",
      live: true,
      contentAt: published ? (row?.publishedAt ?? null) : null,
      version: published ? null : `d:${fingerprint(doc)}`,
      cmsId: row?.id ?? `builtin-${slug}`,
      source: { kind: "page", doc, isBuiltin: true, row },
    });
  }
  for (const row of pages) {
    if (builtin(row.slug)) continue;
    const published = row.status === "PUBLISHED" ? pageDoc(row.published) : null;
    const doc = published ?? pageDoc(row.draft) ?? { title: row.title, seo: { title: row.title, description: "" }, blocks: [] };
    specs.push({
      type: "PAGE",
      key: row.slug,
      path: sitePath(row.slug),
      title: doc.title || row.title,
      status: published ? "published" : "draft",
      live: !!published,
      contentAt: published ? row.publishedAt : row.updatedAt,
      version: null,
      cmsId: row.id,
      source: { kind: "page", doc, isBuiltin: false, row },
    });
  }

  // Posts, newest first; which are on the site now, and when each last changed as a card shows it.
  const isLive = (p: PostRow) => p.status !== "DRAFT" && !!p.publishAt && p.publishAt.getTime() <= now.getTime();
  const cardAt = (p: PostRow) => latest([p.updatedAt, p.publishAt && p.publishAt.getTime() <= now.getTime() ? p.publishAt : null]);
  const livePosts = posts.filter(isLive);
  for (const p of posts) {
    specs.push({
      type: "POST",
      key: p.id,
      path: `/blog/${p.slug}`,
      title: p.title,
      status: seoStatusOf(p.status),
      live: isLive(p),
      contentAt: latest([cardAt(p), ...p.categories.map((l) => categories.get(l.categoryId)?.updatedAt), ...p.tagLinks.map((l) => tags.get(l.tagId)?.updatedAt)]),
      version: null,
      cmsId: p.id,
      source: { kind: "post", post: p },
    });
  }

  // Archives: a category's live posts include its children's — each once, as a post's links are added one after another; newest first, as `posts` is.
  const inCategory = new Map<string, PostRow[]>();
  const inTag = new Map<string, PostRow[]>();
  const add = (map: Map<string, PostRow[]>, id: string, post: PostRow) => {
    const list = map.get(id);
    if (!list) map.set(id, [post]);
    else if (list[list.length - 1] !== post) list.push(post);
  };
  for (const p of livePosts) {
    for (const l of p.categories) {
      add(inCategory, l.categoryId, p);
      const parentId = categories.get(l.categoryId)?.parentId;
      if (parentId) add(inCategory, parentId, p);
    }
    for (const l of p.tagLinks) add(inTag, l.tagId, p);
  }
  const archive = (kind: "category" | "tag", term: TermRow, members: PostRow[]): Spec => {
    const parent = kind === "category" && term.parentId ? (categories.get(term.parentId) ?? null) : null;
    return {
      type: kind === "category" ? "CATEGORY" : "TAG",
      key: term.id,
      path: kind === "category" ? `/blog/category/${term.slug}` : `/blog/tag/${term.slug}`,
      title: term.name,
      status: "published",
      live: members.length > 0,
      contentAt: latest([term.updatedAt, parent?.updatedAt, ...members.map(cardAt)]),
      version: `n:${members.length}`,
      cmsId: term.id,
      source: { kind, term, parent, members },
    };
  };
  for (const c of categories.values()) specs.push(archive("category", c, inCategory.get(c.id) ?? []));
  for (const t of tags.values()) specs.push(archive("tag", t, inTag.get(t.id) ?? []));
  specs.push({
    type: "BLOG_INDEX",
    key: SEO_BLOG_INDEX_KEY,
    path: "/blog",
    title: "Blog",
    status: "published",
    live: true,
    contentAt: latest(livePosts.map(cardAt)),
    version: `n:${livePosts.length}`,
    cmsId: null,
    source: { kind: "blog", members: livePosts },
  });
  specs.sort(compareRefs);

  return {
    now,
    settings: mergeSiteSettings(settingsRow?.published),
    settingsPublishedAt: settingsRow?.published ? (settingsRow.publishedAt ?? null) : null,
    signupOpen: open,
    trialDays: days,
    specs,
    categories,
    tags,
    redirectRules,
    cache,
  };
}

// ─── Staleness ───────────────────────────────────────────────────────────────────────────────────

/** Why a spec's cached row needs recalculating, or null when it is current. */
function needs(spec: Spec, row: CacheRow | undefined, settingsPublishedAt: Date | null): "missing" | "stale" | null {
  if (!row) return "missing";
  if (row.engineVersion !== ENGINE_VERSION) return "stale";
  if (settingsPublishedAt && settingsPublishedAt.getTime() > row.calculatedAt.getTime()) return "stale";
  if (row.status !== spec.status) return "stale";
  if (!sameTime(row.contentUpdatedAt, spec.contentAt)) return "stale";
  if ((row.facts.version ?? null) !== spec.version) return "stale";
  return null;
}

type Assessment = { stale: Set<string>; missing: Set<string>; orphans: SeoEntityRef[] };

function assess(snap: Snapshot): Assessment {
  const stale = new Set<string>();
  const missing = new Set<string>();
  const known = new Set<string>();
  for (const spec of snap.specs) {
    const ref = refOf(spec);
    known.add(ref);
    const why = needs(spec, snap.cache.get(ref), snap.settingsPublishedAt);
    if (why === "missing") missing.add(ref);
    else if (why === "stale") stale.add(ref);
  }
  const orphans = [...snap.cache.values()].filter((r) => !known.has(refOf(r))).map((r) => ({ type: r.type, key: r.key }));
  return { stale, missing, orphans };
}

/** Rows for what is no longer on the site (deleted, archived, a page moved to another address). */
async function dropRows(refs: SeoEntityRef[]): Promise<number> {
  if (!refs.length) return 0;
  const done = await controlDb().seoScore.deleteMany({ where: { OR: refs.map((r) => ({ entityType: r.type, entityKey: r.key })) } });
  return done.count;
}

export type SeoAssessment = {
  /** Everything on the site that can be scored. */
  entities: number;
  stale: SeoEntityRef[];
  /** Never calculated. */
  missing: SeoEntityRef[];
  /** Rows dropped just now: their entity is gone. */
  dropped: number;
};

// ─── Scoring ─────────────────────────────────────────────────────────────────────────────────────

type MediaInfo = { alt: string; width: number | null; height: number | null };

const imageOf = (media: Map<string, MediaInfo>, id: string | null | undefined): SeoImage | null => {
  const m = id ? media.get(id) : undefined;
  return id && m ? { src: `/media/${id}`, alt: m.alt, width: m.width, height: m.height } : null;
};
const termImageId = (seo: unknown): string | null => {
  const id = isObj(seo) && typeof seo.imageMediaId === "string" ? seo.imageMediaId.replace(/^\/media\//, "") : "";
  return CUID.test(id) ? id : null;
};
const card = (p: PostRow, media: Map<string, MediaInfo>) => ({ title: p.title, path: `/blog/${p.slug}`, excerpt: p.excerpt, cover: imageOf(media, p.coverMediaId) });
const firstPage = (members: PostRow[]) => members.slice(0, POSTS_PER_PAGE);

/** The site around every entity: settings, crawler policy, redirects, how many posts are live. `others` is filled by `withOthers`. */
function baseContext(snap: Snapshot): SeoSiteContext {
  const index = indexRules(snap.redirectRules);
  const redirectedPaths = snap.specs
    .filter((s) => s.live && redirectablePath(s.path))
    .filter((s) => {
      const key = normalisePath(s.path);
      return !!key && !!findRule(index, key);
    })
    .map((s) => s.path);
  return siteContextFrom(snap.settings, {
    trialDays: snap.trialDays,
    signupOpen: snap.signupOpen,
    origin: siteOrigin(),
    aiSearchCrawlersAllowed: aiSearchCrawlersAllowed(),
    emitsJsonLd: SITE_EMITS_JSON_LD,
    placeholderTagline: DEFAULT_SITE_SETTINGS.tagline,
    robotsDisallow: PUBLIC_SITE_DISALLOW,
    redirectedPaths,
    livePostCount: snap.specs.filter((s) => s.type === "POST" && s.live).length,
  });
}

/** An entity's input. Without `media`/`bodies` it is enough for its title, description and H1 — what the duplicate checks compare. */
function inputOf(spec: Spec, site: SeoSiteContext, snap: Snapshot, media: Map<string, MediaInfo>, bodies: Map<string, SiteBlock[]> | null): SeoInput {
  const src = spec.source;
  switch (src.kind) {
    case "page":
      return inputFromPage({ id: spec.cmsId ?? undefined, slug: spec.key, title: src.doc.title, seo: src.doc.seo, blocks: src.doc.blocks, status: spec.status, isBuiltin: src.isBuiltin }, site, snap.now);
    case "post": {
      const p = src.post;
      const term = (t: TermRow | undefined, base: string) => (t ? [{ slug: t.slug, name: t.name, path: `${base}/${t.slug}` }] : []);
      return inputFromPost(
        {
          id: p.id,
          slug: p.slug,
          title: p.title,
          excerpt: p.excerpt,
          cover: imageOf(media, p.coverMediaId),
          body: bodies?.get(p.id) ?? [],
          seo: isObj(p.seo) ? (p.seo as { title?: string; description?: string; ogImage?: string; noindex?: boolean; keywords?: unknown }) : null,
          author: p.author.name,
          publishedAt: p.publishAt,
          updatedAt: p.updatedAt,
          categories: p.categories.flatMap((l) => term(snap.categories.get(l.categoryId), "/blog/category")),
          tagLinks: p.tagLinks.flatMap((l) => term(snap.tags.get(l.tagId), "/blog/tag")).sort((a, b) => a.name.localeCompare(b.name)),
          status: spec.status,
        },
        site,
        snap.now,
      );
    }
    case "category":
    case "tag": {
      const t = src.term;
      const total = src.members.length;
      return inputFromArchive(
        {
          kind: src.kind,
          id: t.id,
          slug: t.slug,
          name: t.name,
          description: t.description,
          seo: t.seo,
          image: imageOf(media, termImageId(t.seo)) as { src: string; alt: string; width: number | null; height: number | null } | null,
          posts: bodies ? firstPage(src.members).map((p) => card(p, media)) : [],
          total,
          page: 1,
          pages: Math.max(1, Math.ceil(total / POSTS_PER_PAGE)),
          parent: src.parent ? { name: src.parent.name, path: `/blog/category/${src.parent.slug}` } : null,
        },
        site,
        snap.now,
      );
    }
    case "blog":
      return inputFromBlogIndex({ posts: bodies ? firstPage(src.members).map((p) => card(p, media)) : [] }, site, snap.now);
  }
}

/** Every live entity's title, description and H1, for the duplicate checks — built once per call. */
function othersOf(snap: Snapshot, site: SeoSiteContext): SeoOtherEntity[] {
  const none = new Map<string, MediaInfo>();
  return snap.specs.filter((s) => s.live).map((s) => otherEntityOf(inputOf(s, site, snap, none, null)));
}

/** Library images a set of entities shows: covers, archives' sharing images, the cards on archive and blog pages. */
function mediaIdsOf(specs: Spec[]): string[] {
  const ids = new Set<string>();
  for (const s of specs) {
    const src = s.source;
    if (src.kind === "post" && src.post.coverMediaId) ids.add(src.post.coverMediaId);
    if (src.kind === "category" || src.kind === "tag") {
      const img = termImageId(src.term.seo);
      if (img) ids.add(img);
    }
    if (src.kind === "category" || src.kind === "tag" || src.kind === "blog") for (const p of firstPage(src.members)) if (p.coverMediaId) ids.add(p.coverMediaId);
  }
  return [...ids];
}

async function loadMedia(ids: string[]): Promise<Map<string, MediaInfo>> {
  const wanted = [...new Set(ids.filter((id) => CUID.test(id)))];
  if (!wanted.length) return new Map();
  const rows = await controlDb().siteMedia.findMany({ where: { id: { in: wanted } }, select: { id: true, alt: true, width: true, height: true } });
  return new Map(rows.map((m) => [m.id, { alt: m.alt, width: m.width, height: m.height }]));
}

const hasProblem = (score: EntityScore, ids: string[]) => [...score.seo.checks, ...score.aeo.checks, ...score.geo.checks].some((c) => ids.includes(c.id) && (c.status === "FAIL" || c.status === "WARNING"));

type Scored = { spec: Spec; data: Prisma.SeoScoreCreateManyInput; score: EntityScore; facts: SeoScoreFacts };

function scoredRow(spec: Spec, input: SeoInput, score: EntityScore, now: Date): Scored {
  const facts: SeoScoreFacts = {
    kind: input.kind,
    slug: input.slug,
    isBuiltin: input.isBuiltin,
    live: input.live,
    keywords: input.keywords,
    jsonLdTypes: input.jsonLd.map((o) => o["@type"]),
    robotsConflict: hasProblem(score, ["seo.robots-conflict"]),
    version: spec.version,
    cmsId: spec.cmsId,
  };
  return {
    spec,
    score,
    facts,
    data: {
      entityType: spec.type,
      entityKey: spec.key,
      path: spec.path,
      title: spec.title,
      status: spec.status,
      indexable: input.live && !score.excluded,
      seoScore: score.seo.score,
      aeoScore: score.aeo.score,
      geoScore: score.geo.score,
      overallScore: score.overall,
      critical: score.critical,
      warnings: score.warnings,
      missingMetadata: hasProblem(score, ["seo.title.present", "seo.description.present"]),
      missingSchema: hasProblem(score, ["seo.structured-data"]),
      missingKeywords: !score.excluded && input.kind !== "blog-index" && input.keywords.length === 0,
      breakdown: { ...score, facts } as unknown as Prisma.InputJsonValue,
      engineVersion: ENGINE_VERSION,
      contentUpdatedAt: spec.contentAt,
      calculatedAt: now,
    },
  };
}

/**
 * Scores `specs` against the snapshot, and (with `store`) replaces their cached rows in one
 * transaction. An entity whose scoring throws is left as it was and counted in `failed`.
 */
/** What scoring `specs` needs besides the snapshot: the site (with every live entity for the duplicate checks), the posts' bodies, the library images shown. */
async function prepare(snap: Snapshot, specs: Spec[]): Promise<{ site: SeoSiteContext; media: Map<string, MediaInfo>; bodies: Map<string, SiteBlock[]> }> {
  const postIds = specs.flatMap((s) => (s.source.kind === "post" ? [s.source.post.id] : []));
  const [bodyRows, media] = await Promise.all([
    postIds.length ? controlDb().sitePost.findMany({ where: { id: { in: postIds } }, select: { id: true, body: true } }) : Promise.resolve([]),
    loadMedia(mediaIdsOf(specs)),
  ]);
  const bodies = new Map(bodyRows.map((r) => [r.id, (Array.isArray(r.body) ? r.body : []) as unknown as SiteBlock[]]));
  const base = baseContext(snap);
  return { site: { ...base, others: othersOf(snap, base) }, media, bodies };
}

async function scoreSpecs(snap: Snapshot, specs: Spec[], store: boolean): Promise<{ scored: Scored[]; failed: { ref: string; error: string }[] }> {
  const { site, media, bodies } = await prepare(snap, specs);
  const scored: Scored[] = [];
  const failed: { ref: string; error: string }[] = [];
  for (const spec of specs) {
    try {
      const input = inputOf(spec, site, snap, media, bodies);
      scored.push(scoredRow(spec, input, scoreEntity(input), snap.now));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failed.push({ ref: refOf(spec), error });
      console.warn(`[seo] couldn't score ${refOf(spec)}: ${error}`);
    }
  }
  if (store && scored.length) {
    await controlDb().$transaction(async (tx) => {
      await tx.seoScore.deleteMany({ where: { OR: scored.map((s) => ({ entityType: s.spec.type, entityKey: s.spec.key })) } });
      await tx.seoScore.createMany({ data: scored.map((s) => s.data), skipDuplicates: true });
    });
  }
  return { scored, failed };
}

// ─── Rows as the dashboard shows them ────────────────────────────────────────────────────────────

function editHref(type: SeoEntityType, key: string, cmsId: string | null): string | null {
  switch (type) {
    case "PAGE":
      return CMS_ROUTES.page(cmsId ?? `builtin-${key}`);
    case "POST":
      return CMS_ROUTES.post(key);
    case "CATEGORY":
      return CMS_ROUTES.categories;
    case "TAG":
      return CMS_ROUTES.tags;
    default:
      return null;
  }
}

function rowView(r: CacheRow, stale: boolean): SeoScoreRow {
  return {
    type: r.type,
    key: r.key,
    path: r.path,
    title: r.title,
    status: (SEO_SCORE_STATUSES as readonly string[]).includes(r.status) ? (r.status as SeoScoreStatus) : "published",
    live: r.facts.live,
    excluded: r.excluded,
    indexable: r.indexable,
    seo: r.seoScore,
    aeo: r.aeoScore,
    geo: r.geoScore,
    overall: r.overallScore,
    label: labelFor(r.overallScore),
    critical: r.critical,
    warnings: r.warnings,
    missingMetadata: r.missingMetadata,
    missingSchema: r.missingSchema,
    missingKeywords: r.missingKeywords,
    indexingConflict: r.facts.robotsConflict,
    keywords: r.facts.keywords,
    stale,
    calculatedAt: r.calculatedAt,
    contentUpdatedAt: r.contentUpdatedAt,
    engineVersion: r.engineVersion,
    editHref: editHref(r.type, r.key, r.facts.cmsId),
  };
}

/** A just-scored entity as a cache row. */
function cacheRowOf(s: Scored): CacheRow {
  const d = s.data;
  return {
    type: s.spec.type,
    key: s.spec.key,
    path: d.path,
    title: d.title,
    status: d.status,
    indexable: d.indexable,
    seoScore: d.seoScore,
    aeoScore: d.aeoScore,
    geoScore: d.geoScore,
    overallScore: d.overallScore,
    critical: d.critical,
    warnings: d.warnings,
    missingMetadata: d.missingMetadata,
    missingSchema: d.missingSchema,
    missingKeywords: d.missingKeywords,
    engineVersion: d.engineVersion,
    contentUpdatedAt: s.spec.contentAt,
    calculatedAt: d.calculatedAt as Date,
    excluded: s.score.excluded,
    facts: s.facts,
  };
}

/** The EntityScore in a stored breakdown, without the facts kept beside it. */
function entityScoreOf(breakdown: unknown): EntityScore {
  const score: Record<string, unknown> = { ...(isObj(breakdown) ? breakdown : {}) };
  delete score.facts;
  return score as unknown as EntityScore;
}

// ─── The API ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Scores these entities now and stores the results; a ref whose entity is gone has its row dropped.
 * Answers the rows as stored (none for a dropped one).
 */
export async function recalculateEntities(refs: SeoEntityRef[]): Promise<SeoScoreRow[]> {
  const snap = await loadSnapshot({ cache: false });
  const wanted = new Set(refs.map(refOf));
  const specs = snap.specs.filter((s) => wanted.has(refOf(s)));
  const found = new Set(specs.map(refOf));
  await dropRows(refs.filter((r) => !found.has(refOf(r))));
  if (!specs.length) return [];
  const { scored, failed } = await scoreSpecs(snap, specs, true);
  if (failed.length && !scored.length) throw new Error(failed[0].error);
  return scored.map((s) => rowView(cacheRowOf(s), false));
}

/** Scores one entity now and stores it. Null when it no longer exists (its row, if any, is dropped). */
export async function recalculateEntity(type: SeoEntityType, key: string): Promise<SeoScoreRow | null> {
  const problem = seoRefProblem(type, key);
  if (problem) throw new CmsRefused(problem);
  return (await recalculateEntities([{ type, key }]))[0] ?? null;
}

/**
 * After a publish or a live save (src/lib/cms/content.ts, taxonomy.ts): recalculates what changed.
 * Never throws and never fails the save — a problem is logged, and the entity is simply left stale
 * for the dashboard to pick up.
 */
export async function refreshSeoScores(...refs: SeoEntityRef[]): Promise<void> {
  try {
    await recalculateEntities(refs);
  } catch (err) {
    console.warn(`[seo] couldn't recalculate ${refs.map(refOf).join(", ")} after a change: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The next batch of stale or never-calculated entities (every entity with `all`), in a stable order
 * — pages, the blog index, posts, categories, tags, each by key — scored and stored. The dashboard's
 * "Recalculate all" calls it in a loop, passing `cursor` back, until `done`; one call never scores
 * more than `size` (25 by default, at most 50), so no request scans the whole site's content.
 */
export async function recalculateBatch(options: { cursor?: string | null; size?: number; all?: boolean } = {}): Promise<SeoBatchResult> {
  const size = Math.min(SEO_BATCH_SIZE_MAX, Math.max(1, Math.floor(Number(options.size ?? SEO_BATCH_SIZE)) || SEO_BATCH_SIZE));
  const cursor = parseSeoCursor(options.cursor);
  const snap = await loadSnapshot({ cache: true });
  const a = assess(snap);
  await dropRows(a.orphans);
  const candidates = snap.specs.filter((s) => (options.all || a.stale.has(refOf(s)) || a.missing.has(refOf(s))) && (!cursor || compareRefs(s, cursor) > 0));
  const batch = candidates.slice(0, size);
  const { scored, failed } = batch.length ? await scoreSpecs(snap, batch, true) : { scored: [], failed: [] };
  return {
    done: candidates.length <= size,
    cursor: batch.length ? refOf(batch[batch.length - 1]) : cursor ? refOf(cursor) : null,
    processed: scored.length,
    failed: failed.length,
    remaining: Math.max(0, candidates.length - batch.length),
  };
}

/** Which cached rows are out of date and what has none — dropping the rows of what is gone. */
export async function markStale(): Promise<SeoAssessment> {
  const snap = await loadSnapshot({ cache: true });
  const a = assess(snap);
  const dropped = await dropRows(a.orphans);
  const refs = (set: Set<string>) => snap.specs.filter((s) => set.has(refOf(s))).map((s) => ({ type: s.type, key: s.key }));
  return { entities: snap.specs.length, stale: refs(a.stale), missing: refs(a.missing), dropped };
}

function filterRows(rows: SeoScoreRow[], f: SeoListFilters): SeoScoreRow[] {
  const q = typeof f.q === "string" ? f.q.trim().toLowerCase().slice(0, 100) : "";
  const min = Number.isFinite(f.scoreMin) ? Number(f.scoreMin) : 0;
  const max = Number.isFinite(f.scoreMax) ? Number(f.scoreMax) : 100;
  return rows.filter(
    (r) =>
      (!f.type || r.type === f.type) &&
      (!f.status || r.status === f.status) &&
      (f.indexable === undefined || r.indexable === f.indexable) &&
      r.overall >= min &&
      r.overall <= max &&
      (f.missingMetadata === undefined || r.missingMetadata === f.missingMetadata) &&
      (f.missingSchema === undefined || r.missingSchema === f.missingSchema) &&
      (f.missingKeywords === undefined || r.missingKeywords === f.missingKeywords) &&
      (f.critical === undefined || r.critical > 0 === f.critical) &&
      (f.excluded === undefined || r.excluded === f.excluded) &&
      (f.conflict === undefined || r.indexingConflict === f.conflict) &&
      (!q || r.title.toLowerCase().includes(q) || r.path.toLowerCase().includes(q)),
  );
}

function sortRows(rows: SeoScoreRow[], sort: SeoListFilters["sort"]): SeoScoreRow[] {
  const byRef = (a: SeoScoreRow, b: SeoScoreRow) => compareRefs(a, b);
  const by: Record<(typeof SEO_SORTS)[number], (a: SeoScoreRow, b: SeoScoreRow) => number> = {
    lowest: (a, b) => a.overall - b.overall || byRef(a, b),
    highest: (a, b) => b.overall - a.overall || byRef(a, b),
    issues: (a, b) => b.critical - a.critical || b.warnings - a.warnings || a.overall - b.overall || byRef(a, b),
    recent: (a, b) => b.calculatedAt.getTime() - a.calculatedAt.getTime() || byRef(a, b),
  };
  return [...rows].sort(by[sort && (SEO_SORTS as readonly string[]).includes(sort) ? sort : "lowest"]);
}

/**
 * The dashboard's table, from the cache only — nothing is scored here — each row flagged `stale`
 * when its content, the settings or the engine moved on since. Rows of entities that are gone are
 * dropped first; what has never been calculated is counted in the assessment, not listed.
 */
export async function markStaleAndList(filters: SeoListFilters = {}): Promise<{ list: Paged<SeoScoreRow>; assessment: SeoAssessment }> {
  const snap = await loadSnapshot({ cache: true });
  const a = assess(snap);
  const dropped = await dropRows(a.orphans);
  const orphaned = new Set(a.orphans.map(refOf));
  const all = [...snap.cache.values()].filter((r) => !orphaned.has(refOf(r))).map((r) => rowView(r, a.stale.has(refOf(r))));
  const matched = sortRows(filterRows(all, filters), filters.sort);
  const pageSize = Math.min(SEO_PAGE_SIZE_MAX, Math.max(1, Math.floor(Number(filters.pageSize) || SEO_PAGE_SIZE)));
  const page = Math.max(1, Math.floor(Number(filters.page) || 1));
  const refs = (set: Set<string>) => snap.specs.filter((s) => set.has(refOf(s))).map((s) => ({ type: s.type, key: s.key }));
  return {
    list: { rows: matched.slice((page - 1) * pageSize, page * pageSize), total: matched.length, page, pageSize },
    assessment: { entities: snap.specs.length, stale: refs(a.stale), missing: refs(a.missing), dropped },
  };
}

/** `markStaleAndList`'s page of rows. */
export async function listScores(filters: SeoListFilters = {}): Promise<Paged<SeoScoreRow>> {
  return (await markStaleAndList(filters)).list;
}

/** A cached row's scores as a site-score entry: the flags stand in for the checks the counts look at. */
function siteEntryOf(r: CacheRow): SiteScoreEntry {
  const flag = (id: string): CheckResult => ({ id, category: "seo", group: "metadata", label: id, status: "WARNING", pointsEarned: 0, pointsAvailable: 0, message: "", recommendation: "" });
  const flags = [r.missingMetadata ? flag("seo.title.present") : null, r.missingSchema ? flag("seo.structured-data") : null, r.facts.robotsConflict ? flag("seo.robots-conflict") : null].filter((c): c is CheckResult => !!c);
  const part = (score: number, checks: CheckResult[] = []) => ({ score, maxScore: 100 as const, checks, note: null });
  return {
    id: r.facts.cmsId ?? r.key,
    kind: r.facts.kind,
    slug: r.facts.slug,
    path: r.path,
    isBuiltin: r.facts.isBuiltin,
    live: r.facts.live,
    keywords: r.facts.keywords,
    jsonLdTypes: r.facts.jsonLdTypes,
    score: { seo: part(r.seoScore, flags), aeo: part(r.aeoScore), geo: part(r.geoScore), overall: r.overallScore, label: labelFor(r.overallScore), excluded: r.excluded, critical: r.critical, warnings: r.warnings, keywords: [] },
  };
}

const noindexOf = (spec: Spec): boolean => {
  const src = spec.source;
  if (src.kind === "page") return src.doc.seo?.noindex === true;
  if (src.kind === "post") return isObj(src.post.seo) && src.post.seo.noindex === true;
  return false;
};

/**
 * The dashboard's cards, from the cache: the site's weighted score (src/lib/seo `siteScore` — noindex
 * and not-live entities left out), the counts, the distribution, the site-wide checks, and how much
 * of the cache is out of date or missing. `indexableUrls` is read from the content itself: live,
 * not noindex, not disallowed by robots.txt, not taken over by a redirect.
 */
export async function siteSummary(): Promise<SeoSiteSummary> {
  const snap = await loadSnapshot({ cache: true });
  const a = assess(snap);
  await dropRows(a.orphans);
  const orphaned = new Set(a.orphans.map(refOf));
  const rows = [...snap.cache.values()].filter((r) => !orphaned.has(refOf(r)));
  const entries = rows.map(siteEntryOf);
  const base = baseContext(snap);
  const site = siteScore(entries, { aiSearchCrawlersAllowed: base.aiSearchCrawlersAllowed, defaultOgImage: base.defaultOgImage, titleTemplate: base.titleTemplate, siteName: base.siteName });
  const scored = entries.filter((e) => e.live && !e.score.excluded);
  const attention = (kinds: SeoEntityKind[]) => scored.filter((e) => kinds.includes(e.kind) && e.score.overall < ATTENTION_BELOW).length;
  const hidden = new Set(base.redirectedPaths);
  const disallowed = (path: string) => base.robotsDisallow.some((d) => path === d || path.startsWith(`${d}/`));
  return {
    overall: site.overall,
    seo: site.seo,
    aeo: site.aeo,
    geo: site.geo,
    label: site.label,
    scored: site.counts.scored,
    counts: {
      critical: site.counts.critical,
      warnings: scored.reduce((n, e) => n + e.score.warnings, 0),
      pagesNeedingAttention: attention(["page", "home"]),
      postsNeedingAttention: attention(["post"]),
      archivesNeedingAttention: attention(["category", "tag", "blog-index"]),
      missingMetadata: site.counts.missingMetadata,
      missingStructuredData: site.counts.missingStructuredData,
      noPrimaryKeywords: site.counts.noKeywords,
      indexingConflicts: site.counts.indexingConflicts,
      excluded: site.counts.excluded,
      notLive: site.counts.notLive,
    },
    distribution: site.distribution,
    indexableUrls: snap.specs.filter((s) => s.live && !noindexOf(s) && !hidden.has(s.path) && !disallowed(s.path)).length,
    entities: snap.specs.length,
    calculated: rows.length,
    stale: a.stale.size,
    uncalculated: a.missing.size,
    lastCalculatedAt: latest(rows.map((r) => r.calculatedAt)),
    siteChecks: site.siteChecks,
    engineVersion: ENGINE_VERSION,
  };
}

/**
 * One entity's whole calculation. From the cache when current; calculated afresh when stale or
 * missing — and stored only with `store` (a viewer's look changes nothing, not even the cache).
 */
export async function scoreDetail(type: SeoEntityType, key: string, options: { store: boolean }): Promise<SeoScoreDetail> {
  const problem = seoRefProblem(type, key);
  if (problem) throw new CmsRefused(problem);
  const snap = await loadSnapshot({ cache: true });
  const ref = refOf({ type, key });
  const spec = snap.specs.find((s) => refOf(s) === ref);
  if (!spec) {
    await dropRows([{ type, key }]);
    throw new CmsRefused("That is no longer on the site, so it has no score.");
  }
  const cached = snap.cache.get(ref);
  const jsonLd = (facts: SeoScoreFacts) => ({ emitted: facts.jsonLdTypes, expected: EXPECTED_LD[facts.kind] ?? [] });
  if (cached && !needs(spec, cached, snap.settingsPublishedAt)) {
    const stored = await controlDb().seoScore.findUnique({ where: { entityType_entityKey: { entityType: type, entityKey: key } }, select: { breakdown: true } });
    if (stored) return { row: rowView(cached, false), score: entityScoreOf(stored.breakdown), fresh: false, jsonLd: jsonLd(cached.facts) };
  }
  const { scored, failed } = await scoreSpecs(snap, [spec], options.store);
  if (!scored.length) throw new Error(failed[0]?.error ?? "The score could not be calculated.");
  return { row: rowView(cacheRowOf(scored[0]), false), score: scored[0].score, fresh: true, jsonLd: jsonLd(scored[0].facts) };
}

/**
 * The `SeoInput` the store scores one entity from — built exactly as a batch builds it (the same
 * snapshot, site, bodies and library images), and stored nowhere. For checks that hold the editors'
 * live scoring (src/components/cms/seo/editor-input.ts) to the dashboard's. Null when it is not on
 * the site to be scored.
 */
export async function storeInputFor(type: SeoEntityType, key: string): Promise<SeoInput | null> {
  const problem = seoRefProblem(type, key);
  if (problem) throw new CmsRefused(problem);
  const snap = await loadSnapshot({ cache: false });
  const spec = snap.specs.find((s) => s.type === type && s.key === key);
  if (!spec) return null;
  const { site, media, bodies } = await prepare(snap, [spec]);
  return inputOf(spec, site, snap, media, bodies);
}

export type SeoEditorKind = "page" | "post" | "category" | "tag";

/**
 * What an editor needs to score its entity live, in the browser, with the pure engine: the site
 * around it (the published settings, the AI-crawler policy, redirects, and every other live entity
 * for the duplicate checks — itself left out), the library images it refers to, for a category or
 * tag its archive's first page, and its cached row (what the dashboard says of the version on the
 * site, flagged stale when out of date). Loaded once when the editor opens.
 */
export async function editorContext(kind: SeoEditorKind, id: string): Promise<SeoEditorContext> {
  const ref = String(id ?? "");
  const builtinSlug = kind === "page" ? /^builtin-([a-z]+)$/.exec(ref)?.[1] : undefined;
  if (kind === "page" ? !builtinSlug && !CUID.test(ref) : !ENTITY_ID.test(ref)) throw new CmsRefused("That no longer exists.");
  if (builtinSlug && !(BUILTIN_PAGE_SLUGS as readonly string[]).includes(builtinSlug)) throw new CmsRefused("That no longer exists.");
  const snap = await loadSnapshot({ cache: true });
  const spec = snap.specs.find((s) => (kind === "page" ? s.type === "PAGE" && (s.cmsId === ref || (builtinSlug ? s.key === builtinSlug : false)) : s.cmsId === ref && s.type === kind.toUpperCase()));

  // Where it lives, to leave it out of `others` — also for what isn't scored (an archived post, a page's own row).
  let path = spec?.path ?? null;
  let self: string[] = [ref, ...(spec?.cmsId ? [spec.cmsId] : [])];
  const mediaIds = new Set<string>();
  const addIds = (value: unknown) => mediaIdsIn(value, mediaIds);
  if (kind === "page") {
    const row = await controlDb().sitePage.findFirst({ where: builtinSlug ? { slug: builtinSlug } : { id: ref }, select: { id: true, slug: true, draft: true, published: true } });
    if (!row && !builtinSlug) throw new CmsRefused("That page no longer exists.");
    const slug = row?.slug ?? builtinSlug!;
    path = sitePath(slug);
    self = [...self, row?.id ?? "", `builtin-${slug}`].filter(Boolean);
    addIds(row?.draft);
    addIds(row?.published);
    if (!row) addIds(DEFAULT_SITE_PAGES.find((p) => p.slug === slug));
  } else if (kind === "post") {
    const row = await controlDb().sitePost.findUnique({ where: { id: ref }, select: { slug: true, coverMediaId: true, body: true, seo: true } });
    if (!row) throw new CmsRefused("That post no longer exists.");
    path = `/blog/${row.slug}`;
    if (row.coverMediaId) mediaIds.add(row.coverMediaId);
    addIds(row.body);
    addIds(row.seo);
  } else {
    const term = (kind === "category" ? snap.categories : snap.tags).get(ref);
    if (!term) throw new CmsRefused(kind === "category" ? "That category no longer exists." : "That tag no longer exists.");
    path = kind === "category" ? `/blog/category/${term.slug}` : `/blog/tag/${term.slug}`;
    const img = termImageId(term.seo);
    if (img) mediaIds.add(img);
  }
  const archiveSource = spec && (spec.source.kind === "category" || spec.source.kind === "tag") ? spec.source : null;
  if (archiveSource) for (const p of firstPage(archiveSource.members)) if (p.coverMediaId) mediaIds.add(p.coverMediaId);

  const media = await loadMedia([...mediaIds]);
  const base = baseContext(snap);
  const others = othersOf(snap, base).filter((o) => !self.includes(o.id) && o.path !== path);
  const cachedRow = spec ? snap.cache.get(refOf(spec)) : undefined;
  return {
    cached: spec && cachedRow ? rowView(cachedRow, needs(spec, cachedRow, snap.settingsPublishedAt) !== null) : null,
    site: { ...base, others },
    aiSearchCrawlersAllowed: base.aiSearchCrawlersAllowed,
    media: Object.fromEntries(media),
    archive: archiveSource
      ? {
          posts: firstPage(archiveSource.members).map((p) => card(p, media)),
          total: archiveSource.members.length,
          pages: Math.max(1, Math.ceil(archiveSource.members.length / POSTS_PER_PAGE)),
          parent: archiveSource.parent ? { name: archiveSource.parent.name, path: `/blog/category/${archiveSource.parent.slug}` } : null,
        }
      : null,
    engineVersion: ENGINE_VERSION,
  };
}

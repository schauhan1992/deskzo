import { clampScore, labelFor } from "@/lib/seo/engine";
import type { CheckResult, EntityScore, SeoEntityKind, SeoInput, SeoLabel } from "@/lib/seo/types";

/**
 * The site's score — not a blind average. A weighted mean over the entities on the site that search
 * engines may index: the home page counts three times, the built-in marketing pages twice, other
 * pages and posts once, category and tag archives half. Intentionally excluded (noindex) entities
 * and anything not live are left out, and counted separately. SEO, AEO and GEO are weighed the same
 * way, each on its own. Beside the scores: counts for the dashboard's cards, and the site-level
 * checks (AI crawler policy, Organization on the home page, a default sharing image, the title
 * template), reported apart from the mean.
 */

export const SITE_WEIGHTS = { home: 3, builtinMarketing: 2, page: 1, post: 1, blogIndex: 1, archive: 0.5 } as const;
/** The built-in pages that sell: they count double. The others (legal, sign-in, sign-up) count once. */
export const BUILTIN_MARKETING_SLUGS: readonly string[] = ["pricing", "security", "contact"];
/** Below this an entity needs attention. */
export const ATTENTION_BELOW = 60;

/** One entity in the site's score: what it is, and its score. `siteEntry` makes one from an input. */
export type SiteScoreEntry = {
  id: string;
  kind: SeoEntityKind;
  slug: string;
  path: string;
  isBuiltin: boolean;
  live: boolean;
  /** Its keywords, as entered (0–3). */
  keywords: string[];
  /** The JSON-LD types it emits. */
  jsonLdTypes: string[];
  score: EntityScore;
};

export function siteEntry(input: SeoInput, score: EntityScore): SiteScoreEntry {
  return { id: input.id, kind: input.kind, slug: input.slug, path: input.path, isBuiltin: input.isBuiltin, live: input.live, keywords: input.keywords, jsonLdTypes: input.jsonLd.map((o) => o["@type"]), score };
}

/** What the site-level checks read. */
export type SiteMeta = {
  aiSearchCrawlersAllowed: boolean;
  /** The site's default sharing image (Settings → SEO), when it has a usable one. */
  defaultOgImage: string | null;
  /** The title template, tokens filled ("%s · Deskzo One"). */
  titleTemplate: string;
  siteName: string;
};

export type SiteCounts = {
  /** Entities in the mean: live and indexable. */
  scored: number;
  /** Live, intentionally kept out of search. */
  excluded: number;
  /** Not on the site (drafts, scheduled, empty archives) — never in the mean. */
  notLive: number;
  /** Critical issues across the scored entities. */
  critical: number;
  /** Scored entities whose overall score is under 60. */
  needsAttention: number;
  /** Scored entities missing a title or a meta description. */
  missingMetadata: number;
  /** Scored entities without the structured data their kind should carry. */
  missingStructuredData: number;
  /** Scored entities with no primary keywords (the blog index, which cannot have any, is not counted). */
  noKeywords: number;
  /** Scored entities with an indexing conflict (robots.txt, canonical, a redirect). */
  indexingConflicts: number;
};

export type SiteScore = {
  overall: number;
  seo: number;
  aeo: number;
  geo: number;
  label: SeoLabel;
  /** Sum of the weights of the scored entities; 0 means nothing was scored (every score is then 0). */
  weight: number;
  counts: SiteCounts;
  /** Scored entities by label. */
  distribution: Record<SeoLabel, number>;
  siteChecks: CheckResult[];
};

/** An entity's weight in the site's score. */
export function siteEntryWeight(entry: Pick<SiteScoreEntry, "kind" | "slug" | "isBuiltin">): number {
  switch (entry.kind) {
    case "home":
      return SITE_WEIGHTS.home;
    case "post":
      return SITE_WEIGHTS.post;
    case "blog-index":
      return SITE_WEIGHTS.blogIndex;
    case "category":
    case "tag":
      return SITE_WEIGHTS.archive;
    default:
      return entry.isBuiltin && BUILTIN_MARKETING_SLUGS.includes(entry.slug) ? SITE_WEIGHTS.builtinMarketing : SITE_WEIGHTS.page;
  }
}

const allChecks = (s: EntityScore) => [...s.seo.checks, ...s.aeo.checks, ...s.geo.checks];
const hasProblem = (s: EntityScore, ids: string[]) => allChecks(s).some((c) => ids.includes(c.id) && (c.status === "FAIL" || c.status === "WARNING"));

function siteCheck(id: string, category: CheckResult["category"], label: string, ok: boolean, weight: number, message: string, recommendation: string, extra: Partial<CheckResult> = {}): CheckResult {
  return {
    id,
    category,
    group: "technical",
    label,
    status: ok ? "PASS" : (extra.status ?? "WARNING"),
    pointsEarned: ok ? weight : 0,
    pointsAvailable: weight,
    message,
    recommendation: ok ? "" : recommendation,
    ...(ok ? {} : { severity: extra.severity ?? "improvement" }),
    ...(extra.field ? { field: extra.field } : {}),
  };
}

/** The site-level checks: things true of the whole site, not of one page. */
export function siteChecks(entries: SiteScoreEntry[], meta: SiteMeta): CheckResult[] {
  const home = entries.find((e) => e.kind === "home");
  const template = meta.titleTemplate.trim();
  const templateOk = template.includes("%s") && template.replace(/%s/g, "").trim().length > 0;
  return [
    siteCheck(
      "site.ai-crawlers",
      "geo",
      "AI search crawlers allowed",
      meta.aiSearchCrawlersAllowed,
      6,
      meta.aiSearchCrawlersAllowed ? "robots.txt lets AI search crawlers read the site; training crawlers stay blocked." : "robots.txt blocks AI search crawlers, so AI search can't read or cite any page.",
      "Site-wide, in code: allow the AI search crawlers in src/app/robots.ts and keep the training crawlers blocked (owner decision S-D2).",
      { status: "FAIL", severity: "critical" },
    ),
    siteCheck(
      "site.organization",
      "geo",
      "Organization on the home page",
      !!home?.jsonLdTypes.includes("Organization"),
      4,
      home?.jsonLdTypes.includes("Organization") ? "The home page carries Organization structured data." : home ? "The home page carries no Organization structured data." : "No home page among the entities scored.",
      "A developer change: the home page's JSON-LD (S-D1) should include Organization.",
    ),
    siteCheck(
      "site.og-default",
      "seo",
      "Default sharing image",
      !!meta.defaultOgImage,
      3,
      meta.defaultOgImage ? "The site has a default sharing image for pages without their own." : "No default sharing image: pages without an image of their own are shared as text only.",
      "Set one in the CMS's Settings → SEO.",
      { field: "settings.seo.ogImage" },
    ),
    siteCheck(
      "site.title-template",
      "seo",
      "Title template",
      templateOk,
      3,
      templateOk ? `Titles are written as “${template}”.` : `The title template ${template ? `“${template}”` : "is empty and"} adds nothing to page titles.`,
      "Set a template in the CMS's Settings → SEO, e.g. “%s · {siteName}”.",
      { field: "settings.seo.titleTemplate" },
    ),
  ];
}

/** The site's scores, counts and site-level checks from every entity's score. */
export function siteScore(entries: SiteScoreEntry[], meta: SiteMeta): SiteScore {
  const live = entries.filter((e) => e.live);
  const scored = live.filter((e) => !e.score.excluded);
  let weight = 0;
  const sums = { overall: 0, seo: 0, aeo: 0, geo: 0 };
  for (const e of scored) {
    const w = siteEntryWeight(e);
    weight += w;
    sums.overall += w * e.score.overall;
    sums.seo += w * e.score.seo.score;
    sums.aeo += w * e.score.aeo.score;
    sums.geo += w * e.score.geo.score;
  }
  const mean = (n: number) => (weight > 0 ? clampScore(n / weight) : 0);
  const overall = mean(sums.overall);
  const distribution: Record<SeoLabel, number> = { Poor: 0, "Needs improvement": 0, Good: 0, Excellent: 0 };
  for (const e of scored) distribution[e.score.label] += 1;
  return {
    overall,
    seo: mean(sums.seo),
    aeo: mean(sums.aeo),
    geo: mean(sums.geo),
    label: labelFor(overall),
    weight,
    counts: {
      scored: scored.length,
      excluded: live.length - scored.length,
      notLive: entries.length - live.length,
      critical: scored.reduce((n, e) => n + e.score.critical, 0),
      needsAttention: scored.filter((e) => e.score.overall < ATTENTION_BELOW).length,
      missingMetadata: scored.filter((e) => hasProblem(e.score, ["seo.title.present", "seo.description.present"])).length,
      missingStructuredData: scored.filter((e) => hasProblem(e.score, ["seo.structured-data"])).length,
      noKeywords: scored.filter((e) => e.kind !== "blog-index" && e.keywords.length === 0).length,
      indexingConflicts: scored.filter((e) => hasProblem(e.score, ["seo.robots-conflict"])).length,
    },
    distribution,
    siteChecks: siteChecks(entries, meta),
  };
}

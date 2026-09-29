import { SCORE_BANDS } from "@/components/cms/seo/score-view";
import { withParams, type RawParams } from "@/lib/console-shared/params";
import { CMS_ROUTES } from "@/lib/cms/nav";
import { SEO_PAGE_SIZE, SEO_SORTS, type SeoEntityType, type SeoListFilters, type SeoScoreStatus, type SeoSort } from "@/lib/cms/types";

/**
 * The SEO Intelligence dashboard's address: every filter, the order, the page and the open detail
 * are in it, so a filtered view or one entity's analysis is a link that can be shared. Each value is
 * whitelisted here; anything else is ignored, never trusted (the store checks the filters again).
 *
 *   type      page | post | category | tag | blog
 *   status    published | draft | default | scheduled
 *   band      excellent | good | needs-improvement | poor | attention (below 60)
 *   index     indexable | noindex
 *   meta=1 · schema=1 · keywords=1 · critical=1 · conflict=1   (missing metadata, missing structured
 *             data, no primary keywords, critical issues, indexing conflicts)
 *   q · sort (lowest | highest | issues | recent) · page
 *   open      <type>:<key> — "post:<id>", "page:<slug>", "blog:blog"
 *
 * Pure and client-safe.
 */

export const SEO_PATH = CMS_ROUTES.seo;

export type SeoTypeParam = "page" | "post" | "category" | "tag" | "blog";

export const TYPE_BY_PARAM: Record<SeoTypeParam, SeoEntityType> = { page: "PAGE", post: "POST", category: "CATEGORY", tag: "TAG", blog: "BLOG_INDEX" };
export const PARAM_BY_TYPE: Record<SeoEntityType, SeoTypeParam> = { PAGE: "page", POST: "post", CATEGORY: "category", TAG: "tag", BLOG_INDEX: "blog" };
export const TYPE_LABEL: Record<SeoEntityType, string> = { PAGE: "Page", POST: "Post", CATEGORY: "Category", TAG: "Tag", BLOG_INDEX: "Blog index" };
export const TYPE_OPTIONS: readonly { value: SeoTypeParam; label: string }[] = [
  { value: "page", label: "Pages" },
  { value: "post", label: "Posts" },
  { value: "category", label: "Categories" },
  { value: "tag", label: "Tags" },
  { value: "blog", label: "Blog index" },
];

export const STATUS_LABEL: Record<SeoScoreStatus, string> = { published: "Published", draft: "Draft", default: "Built-in default", scheduled: "Scheduled" };
export const STATUS_OPTIONS = (Object.keys(STATUS_LABEL) as SeoScoreStatus[]).map((value) => ({ value, label: STATUS_LABEL[value] }));

/** The score filter: the four bands, and everything below 60 — what "needs attention" means. */
export const BAND_OPTIONS: readonly { value: string; label: string; min: number; max: number }[] = [
  ...SCORE_BANDS.map((b) => ({ value: b.param, label: `${b.label} (${b.min}–${b.max})`, min: b.min, max: b.max })),
  { value: "attention", label: "Needs attention (below 60)", min: 0, max: 59 },
];

export const INDEX_OPTIONS = [
  { value: "indexable", label: "Indexable" },
  { value: "noindex", label: "Excluded (noindex)" },
] as const;

export const SORT_LABEL: Record<SeoSort, string> = { lowest: "Lowest score first", highest: "Highest score first", issues: "Most issues first", recent: "Recently calculated" };

/** The yes/no filters: their parameter, their words, the store's filter. */
export const FLAG_FILTERS = [
  { param: "meta", label: "Missing metadata", filter: "missingMetadata" },
  { param: "schema", label: "Missing structured data", filter: "missingSchema" },
  { param: "keywords", label: "No primary keywords", filter: "missingKeywords" },
  { param: "critical", label: "Critical issues", filter: "critical" },
  { param: "conflict", label: "Indexing conflicts", filter: "conflict" },
] as const satisfies readonly { param: string; label: string; filter: keyof SeoListFilters }[];

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined);
const isOne = <T extends string>(values: readonly T[], v: string | undefined): v is T => !!v && (values as readonly string[]).includes(v);

export type ParsedSeoParams = {
  filters: SeoListFilters;
  type: SeoTypeParam | undefined;
  status: SeoScoreStatus | undefined;
  band: string | undefined;
  index: "indexable" | "noindex" | undefined;
  flags: Record<(typeof FLAG_FILTERS)[number]["param"], boolean>;
  q: string;
  sort: SeoSort;
  page: number;
  /** The open detail, as written ("post:<id>"); the store checks the key. */
  open: { type: SeoEntityType; key: string } | null;
};

/** The dashboard's params, whitelisted, and the store's filters from them. */
export function parseSeoParams(sp: RawParams): ParsedSeoParams {
  const typeRaw = one(sp.type)?.toLowerCase();
  const type = isOne(Object.keys(TYPE_BY_PARAM) as SeoTypeParam[], typeRaw) ? typeRaw : undefined;
  const statusRaw = one(sp.status)?.toLowerCase();
  const status = isOne(Object.keys(STATUS_LABEL) as SeoScoreStatus[], statusRaw) ? statusRaw : undefined;
  const bandRaw = one(sp.band)?.toLowerCase();
  const band = BAND_OPTIONS.find((b) => b.value === bandRaw);
  const indexRaw = one(sp.index)?.toLowerCase();
  const index = indexRaw === "indexable" || indexRaw === "noindex" ? indexRaw : undefined;
  const on = (param: string) => ["1", "true"].includes((one(sp[param]) ?? "").toLowerCase());
  const flags = Object.fromEntries(FLAG_FILTERS.map((f) => [f.param, on(f.param)])) as ParsedSeoParams["flags"];
  const q = (one(sp.q) ?? "").trim().slice(0, 100);
  const sortRaw = one(sp.sort)?.toLowerCase();
  const sort: SeoSort = isOne(SEO_SORTS, sortRaw) ? sortRaw : "lowest";
  const page = Math.min(10_000, Math.max(1, Math.floor(Number(one(sp.page)) || 1)));
  const filters: SeoListFilters = {
    type: type ? TYPE_BY_PARAM[type] : undefined,
    status,
    scoreMin: band?.min,
    scoreMax: band?.max,
    indexable: index === "indexable" ? true : undefined,
    excluded: index === "noindex" ? true : undefined,
    q: q || undefined,
    sort,
    page,
    pageSize: SEO_PAGE_SIZE,
  };
  for (const f of FLAG_FILTERS) if (flags[f.param]) filters[f.filter] = true;
  return { filters, type, status, band: band?.value, index, flags, q, sort, page, open: parseOpen(one(sp.open)) };
}

/** "post:<id>" → the entity it names (its key unchecked); anything else → null. */
export function parseOpen(raw: string | undefined): { type: SeoEntityType; key: string } | null {
  if (!raw || raw.length > 200) return null;
  const at = raw.indexOf(":");
  if (at <= 0) return null;
  const typeParam = raw.slice(0, at).toLowerCase();
  const key = raw.slice(at + 1);
  if (!key || !(typeParam in TYPE_BY_PARAM)) return null;
  return { type: TYPE_BY_PARAM[typeParam as SeoTypeParam], key };
}

/** The `open` value for an entity. */
export const openParam = (type: SeoEntityType, key: string) => `${PARAM_BY_TYPE[type]}:${key}`;

/** This view with one entity's detail open (or, with null, closed) — its filters and page kept. */
export function withOpen(sp: RawParams, open: string | null): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (key === "open") continue;
    for (const v of Array.isArray(value) ? value : [value]) if (typeof v === "string" && v !== "") params.append(key, v);
  }
  if (open) params.set("open", open);
  const query = params.toString();
  return query ? `${SEO_PATH}?${query}` : SEO_PATH;
}

/** What the table is filtered by, each chip removable on its own. */
export function filterChips(p: ParsedSeoParams, sp: RawParams): { key: string; label: string; removeHref: string }[] {
  const drop = (changes: Record<string, null>) => withParams(SEO_PATH, sp, { ...changes, open: null });
  const chips: { key: string; label: string; removeHref: string }[] = [];
  if (p.q) chips.push({ key: "q", label: `Search: ${p.q}`, removeHref: drop({ q: null }) });
  if (p.status) chips.push({ key: "status", label: `Status: ${STATUS_LABEL[p.status]}`, removeHref: drop({ status: null }) });
  const band = BAND_OPTIONS.find((b) => b.value === p.band);
  if (band) chips.push({ key: "band", label: `Score: ${band.label}`, removeHref: drop({ band: null }) });
  if (p.index) chips.push({ key: "index", label: p.index === "indexable" ? "Indexable only" : "Excluded (noindex) only", removeHref: drop({ index: null }) });
  for (const f of FLAG_FILTERS) if (p.flags[f.param]) chips.push({ key: f.param, label: f.label, removeHref: drop({ [f.param]: null }) });
  return chips;
}

/** Everything the "Clear filters" link takes off (the type tabs and the order stay). */
export const clearFiltersHref = (sp: RawParams) => withParams(SEO_PATH, sp, { q: null, status: null, band: null, index: null, meta: null, schema: null, keywords: null, critical: null, conflict: null, open: null });

/** A fresh view of the table: only these filters. */
export const seoViewHref = (params: Record<string, string>) => withParams(SEO_PATH, {}, params);

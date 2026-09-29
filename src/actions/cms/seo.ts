"use server";

import { cmsAction, revalidateCms } from "@/lib/cms/guard";
import { editorContext, listScores, parseSeoCursor, recalculateBatch, recalculateEntity, scoreDetail, seoRefProblem, siteSummary, type SeoEditorKind } from "@/lib/cms/seo-scores";
import {
  CMS_EVERYONE,
  CMS_WRITERS,
  CmsRefused,
  SEO_ENTITY_TYPES,
  SEO_PAGE_SIZE_MAX,
  SEO_SCORE_STATUSES,
  SEO_SORTS,
  type CmsResult,
  type Paged,
  type SeoBatchResult,
  type SeoEditorContext,
  type SeoEntityType,
  type SeoListFilters,
  type SeoScoreDetail,
  type SeoScoreRow,
  type SeoSiteSummary,
} from "@/lib/cms/types";

/**
 * SEO Intelligence: the score cache behind the CMS's dashboard (src/lib/cms/seo-scores.ts). The
 * scores are internal indicators, not Google's or any AI platform's. Every CMS role reads them — a
 * viewer already reads every page and post, drafts included, so nothing here shows a viewer more
 * than the CMS does — and writers recalculate, which writes the cache and nothing else.
 *
 *   cmsSeoSummary             everybody   the site's score, the counts, the distribution, site-wide checks,
 *                                         and how much of the cache is stale or never calculated
 *   cmsSeoList                everybody   the table: filters, sort, 25 a page — from the cache, each row
 *                                         flagged `stale` when out of date
 *   cmsSeoDetail              everybody   one entity's checks; recalculated when stale (stored for writers only)
 *   cmsSeoEditorContext       everybody   what an editor needs to score live in the browser
 *   cmsSeoRecalculate         writers     one entity now
 *   cmsSeoRecalculateBatch    writers     the next batch for "Recalculate all": loop with the cursor until `done`
 */

const EDITOR_KINDS: readonly SeoEditorKind[] = ["page", "post", "category", "tag"];

function entityRef(type: unknown, key: unknown): { type: SeoEntityType; key: string } {
  const problem = seoRefProblem(type, key);
  if (problem) throw new CmsRefused(problem);
  return { type: type as SeoEntityType, key: key as string };
}

const flag = (value: unknown, name: string): boolean | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new CmsRefused(`"${name}" is yes or no.`);
  return value;
};

const whole = (value: unknown, name: string, min: number, max: number): number | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw new CmsRefused(`"${name}" is a whole number from ${min} to ${max}.`);
  return n;
};

function oneOf<T extends string>(value: unknown, values: readonly T[], name: string): T | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) throw new CmsRefused(`"${name}" is one of: ${values.join(", ")}.`);
  return value as T;
}

/** The list's filters, checked: anything out of bounds is refused, not quietly clamped. */
function checkedFilters(raw: unknown): SeoListFilters {
  const f = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (f.q !== undefined && f.q !== null && typeof f.q !== "string") throw new CmsRefused("Search for words.");
  const scoreMin = whole(f.scoreMin, "scoreMin", 0, 100);
  const scoreMax = whole(f.scoreMax, "scoreMax", 0, 100);
  if (scoreMin !== undefined && scoreMax !== undefined && scoreMin > scoreMax) throw new CmsRefused("The lowest score is above the highest.");
  return {
    type: oneOf(f.type, SEO_ENTITY_TYPES, "type"),
    status: oneOf(f.status, SEO_SCORE_STATUSES, "status"),
    indexable: flag(f.indexable, "indexable"),
    scoreMin,
    scoreMax,
    missingMetadata: flag(f.missingMetadata, "missingMetadata"),
    missingSchema: flag(f.missingSchema, "missingSchema"),
    missingKeywords: flag(f.missingKeywords, "missingKeywords"),
    critical: flag(f.critical, "critical"),
    excluded: flag(f.excluded, "excluded"),
    conflict: flag(f.conflict, "conflict"),
    q: typeof f.q === "string" ? f.q.slice(0, 100) : undefined,
    sort: oneOf(f.sort, SEO_SORTS, "sort"),
    page: whole(f.page, "page", 1, 10_000),
    pageSize: whole(f.pageSize, "pageSize", 1, SEO_PAGE_SIZE_MAX),
  };
}

export async function cmsSeoSummary(): Promise<CmsResult<SeoSiteSummary>> {
  return cmsAction(CMS_EVERYONE, async () => siteSummary());
}

export async function cmsSeoList(filters: SeoListFilters = {}): Promise<CmsResult<Paged<SeoScoreRow>>> {
  return cmsAction(CMS_EVERYONE, async () => listScores(checkedFilters(filters)));
}

export async function cmsSeoDetail(type: SeoEntityType, key: string): Promise<CmsResult<SeoScoreDetail>> {
  return cmsAction(CMS_EVERYONE, async ({ user }) => {
    const ref = entityRef(type, key);
    return scoreDetail(ref.type, ref.key, { store: CMS_WRITERS.includes(user.role) });
  });
}

export async function cmsSeoEditorContext(kind: SeoEditorKind, id: string): Promise<CmsResult<SeoEditorContext>> {
  return cmsAction(CMS_EVERYONE, async () => {
    const k = oneOf(kind, EDITOR_KINDS, "kind");
    if (!k) throw new CmsRefused("Say which kind of editor: page, post, category or tag.");
    return editorContext(k, String(id ?? "").slice(0, 60));
  });
}

export async function cmsSeoRecalculate(type: SeoEntityType, key: string): Promise<CmsResult<SeoScoreRow>> {
  return cmsAction(CMS_WRITERS, async () => {
    const ref = entityRef(type, key);
    const row = await recalculateEntity(ref.type, ref.key);
    if (!row) throw new CmsRefused("That is no longer on the site, so it has no score.");
    revalidateCms();
    return row;
  });
}

export async function cmsSeoRecalculateBatch(cursor: string | null = null, options: { all?: boolean } = {}): Promise<CmsResult<SeoBatchResult>> {
  return cmsAction(CMS_WRITERS, async () => {
    parseSeoCursor(cursor);
    const all = flag(options?.all, "all") ?? false;
    const result = await recalculateBatch({ cursor, all });
    if (result.processed > 0) revalidateCms();
    return result;
  });
}

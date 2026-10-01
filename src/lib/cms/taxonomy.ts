import { Prisma, type CmsRole, type SiteCategory, type SiteTag } from "@deskzo/control-client";
import { actorOfMe, actorRef, cmsAudit, refLabels, type CmsActor } from "@/lib/cms/audit";
import { missingMediaIds } from "@/lib/cms/media";
import { autoRedirect } from "@/lib/cms/redirects";
import { refreshSeoScores } from "@/lib/cms/seo-scores";
import {
  CATEGORY_NAME_MAX,
  CMS_PUBLISHERS,
  CMS_WRITERS,
  CmsRefused,
  TAG_NAME_MAX,
  TERM_DESCRIPTION_MAX,
  TERM_SLUG_MAX,
  type AutoRedirect,
  type CategoryInput,
  type CategoryNode,
  type CategoryRow,
  type CmsIssue,
  type CmsMe,
  type CmsTermRef,
  type Paged,
  type TagInput,
  type TagRow,
  type TermSeo,
} from "@/lib/cms/types";
import { checkKeywords, slugify, TERM_SLUG } from "@/lib/cms/validate";
import { controlDb } from "@/lib/platform/control-db";
import { cachedSiteRead, invalidateSiteContent, livePostWhere, livePostsPage, siteImages, type SitePostCover, type SitePostSummary, type SiteTermLink } from "@/lib/platform/site-content";
import { archiveSeoView } from "@/lib/seo/metadata";

/**
 * The blog's categories and tags (spec §1.1–§1.4, §1.11): managed records, not free text.
 *
 *   · Categories are a curated list editors and admins keep, nested one level (a parent, then its
 *     children). A post may be in several; the first is its main one (breadcrumbs). A category with
 *     children can't be deleted; deleting one takes it off its posts.
 *   · Tags are looser: any writer (authors too) adds one, here or while writing a post; only editors
 *     and admins rename, merge or delete them. Merging moves the posts and leaves a 301 from the old
 *     tag's archive to the other's.
 *   · Each has a public archive — /blog/category/<slug> (its children's posts too) and
 *     /blog/tag/<slug> — 12 posts a page, newest first, only what is live; none when nothing is.
 *     Read through the site's content cache (src/lib/platform/site-content.ts), cleared on every
 *     change here that shows on the site.
 *   · A slug change of an archive with posts on the site leaves a 301 behind (src/lib/cms/redirects.ts).
 *   · Every change is in the CMS's activity log: category.* and tag.*.
 *
 * The role sets are checked here as well as by the actions (src/actions/cms/categories.ts, tags.ts),
 * because a post's save creates tags through here too.
 */

const actorOf = (me: CmsMe): CmsActor => actorOfMe(me);
const MEDIA_ID = /^[a-z0-9]{20,40}$/;
/**
 * A category's or tag's id: a cuid when the CMS made it, or a UUID when the taxonomy migration
 * backfilled it from a post's old free-text tags (gen_random_uuid()). Refusing the UUIDs made every
 * backfilled tag impossible to rename, merge or delete ("That tag no longer exists").
 */
const TERM_ID = /^(?:[a-z0-9]{20,40}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const TAGS_PAGE_SIZE = 50;
export const MAX_POST_TAGS = 10;
export const MAX_POST_CATEGORIES = 10;
export const categoryPath = (slug: string) => `/blog/category/${slug}`;
export const tagPath = (slug: string) => `/blog/tag/${slug}`;

function assertRole(me: CmsMe, roles: readonly CmsRole[]): void {
  if (!roles.includes(me.role)) throw new CmsRefused("Your role cannot do that.");
}

function refusal(issues: CmsIssue[]): CmsRefused {
  return new CmsRefused(issues.length === 1 ? issues[0].message : "Some fields need attention.", { issues });
}

/** One line: control characters become spaces, runs of space one. */
function cleanLine(raw: unknown): string {
  let out = "";
  for (const ch of String(raw ?? "")) {
    const c = ch.charCodeAt(0);
    out += c < 32 || c === 127 ? " " : ch;
  }
  return out.replace(/\s{2,}/g, " ").trim();
}

/** Plain text that may have lines: control characters other than a line break dropped. */
function cleanText(raw: unknown): string {
  let out = "";
  for (const ch of String(raw ?? "").replace(/\r\n?/g, "\n")) {
    const c = ch.charCodeAt(0);
    if ((c < 32 && c !== 10) || c === 127) continue;
    out += ch;
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

function checkSlug(raw: unknown, name: string, issues: CmsIssue[]): string {
  const given = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  const slug = given || slugify(name, TERM_SLUG_MAX);
  if (!slug) issues.push({ path: "slug", message: "Give it an address: lower-case letters, digits and hyphens." });
  else if (slug.length > TERM_SLUG_MAX || !TERM_SLUG.test(slug)) issues.push({ path: "slug", message: `Use lower-case letters, digits and hyphens for the address (at most ${TERM_SLUG_MAX}).` });
  return slug;
}

function checkName(raw: unknown, max: number, issues: CmsIssue[]): string {
  const name = cleanLine(raw);
  if (!name) issues.push({ path: "name", message: "Give it a name." });
  else if (name.length > max) issues.push({ path: "name", message: `Keep the name to ${max} characters.` });
  return name;
}

function checkDescription(raw: unknown, issues: CmsIssue[]): string | null {
  const text = cleanText(raw);
  if (text.length > TERM_DESCRIPTION_MAX) issues.push({ path: "description", message: `Keep the description to ${TERM_DESCRIPTION_MAX} characters.` });
  return text || null;
}

/**
 * A category's or tag's { title, description, imageMediaId, keywords } — the image from the media
 * library, the keywords checked as a page's are (validate.ts `checkKeywords`) and stored normalised.
 */
async function checkSeo(raw: unknown, issues: CmsIssue[]): Promise<TermSeo | null> {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    issues.push({ path: "seo", message: "Search and sharing details are a title, a description, an image and keywords." });
    return null;
  }
  const r = raw as Record<string, unknown>;
  const out: TermSeo = {};
  const title = cleanLine(r.title);
  if (title.length > 120) issues.push({ path: "seo.title", message: "Keep the search title to 120 characters." });
  else if (title) out.title = title;
  const description = cleanLine(r.description);
  if (description.length > 300) issues.push({ path: "seo.description", message: "Keep the search description to 300 characters." });
  else if (description) out.description = description;
  const image = typeof r.imageMediaId === "string" ? r.imageMediaId.trim().replace(/^\/media\//, "") : "";
  if (image) {
    if (!MEDIA_ID.test(image) || (await missingMediaIds([image])).length) issues.push({ path: "seo.imageMediaId", message: "Choose an image from the media library." });
    else out.imageMediaId = image;
  }
  const keywords = checkKeywords(r.keywords);
  for (const p of keywords.issues) issues.push({ path: p.index === null ? "seo.keywords" : `seo.keywords[${p.index}]`, message: p.message });
  if (keywords.keywords.length) out.keywords = keywords.keywords;
  return Object.keys(out).length ? out : null;
}

const seoOf = (value: unknown): TermSeo | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as TermSeo) : null);
const seoJson = (seo: TermSeo | null) => (seo ? (seo as Prisma.InputJsonValue) : Prisma.DbNull);

// ─── Counts ──────────────────────────────────────────────────────────────────────────────────────

async function categoryCounts(now: Date): Promise<{ all: Map<string, number>; live: Map<string, number> }> {
  const [all, live] = await Promise.all([
    controlDb().sitePostCategory.groupBy({ by: ["categoryId"], where: { post: { archivedAt: null } }, _count: { _all: true } }),
    controlDb().sitePostCategory.groupBy({ by: ["categoryId"], where: { post: livePostWhere(now) }, _count: { _all: true } }),
  ]);
  return { all: new Map(all.map((g) => [g.categoryId, g._count._all])), live: new Map(live.map((g) => [g.categoryId, g._count._all])) };
}

async function tagCounts(ids: string[] | null, now: Date): Promise<{ all: Map<string, number>; live: Map<string, number> }> {
  const only = ids ? { tagId: { in: ids } } : {};
  const [all, live] = await Promise.all([
    controlDb().sitePostTag.groupBy({ by: ["tagId"], where: { ...only, post: { archivedAt: null } }, _count: { _all: true } }),
    controlDb().sitePostTag.groupBy({ by: ["tagId"], where: { ...only, post: livePostWhere(now) }, _count: { _all: true } }),
  ]);
  return { all: new Map(all.map((g) => [g.tagId, g._count._all])), live: new Map(live.map((g) => [g.tagId, g._count._all])) };
}

/** Live posts in a category and its children, or in a tag — for "does its archive exist". */
async function liveInCategory(id: string, now = new Date()): Promise<number> {
  return controlDb().sitePost.count({ where: { AND: [livePostWhere(now), { categories: { some: { category: { OR: [{ id }, { parentId: id }] } } } }] } });
}

async function liveInTag(id: string, now = new Date()): Promise<number> {
  return controlDb().sitePost.count({ where: { AND: [livePostWhere(now), { tagLinks: { some: { tagId: id } } }] } });
}

// ─── Categories ──────────────────────────────────────────────────────────────────────────────────

function categoryRow(c: SiteCategory, counts: { all: Map<string, number>; live: Map<string, number> }, labels: Map<string, string>): CategoryRow {
  return {
    id: c.id,
    slug: c.slug,
    name: c.name,
    description: c.description,
    parentId: c.parentId,
    position: c.position,
    seo: seoOf(c.seo),
    path: categoryPath(c.slug),
    posts: counts.all.get(c.id) ?? 0,
    livePosts: counts.live.get(c.id) ?? 0,
    updatedAt: c.updatedAt,
    updatedBy: labels.get(c.updatedBy) ?? c.updatedBy,
  };
}

async function categoryOrRefuse(id: string): Promise<SiteCategory> {
  const row = TERM_ID.test(String(id ?? "")) ? await controlDb().siteCategory.findUnique({ where: { id } }) : null;
  if (!row) throw new CmsRefused("That category no longer exists.");
  return row;
}

/** Every category as a tree: the top-level ones by position, each with its children by position. Post counts are each one's own. */
export async function listCategories(now = new Date()): Promise<CategoryNode[]> {
  const [rows, counts] = await Promise.all([controlDb().siteCategory.findMany({ orderBy: [{ position: "asc" }, { name: "asc" }] }), categoryCounts(now)]);
  const labels = await refLabels(rows.map((r) => r.updatedBy));
  const ids = new Set(rows.map((r) => r.id));
  const tops = rows.filter((r) => !r.parentId || !ids.has(r.parentId));
  return tops.map((top) => ({ ...categoryRow(top, counts, labels), children: rows.filter((r) => r.parentId === top.id).map((r) => categoryRow(r, counts, labels)) }));
}

export async function getCategory(id: string, now = new Date()): Promise<CategoryRow> {
  const row = await categoryOrRefuse(id);
  const [counts, labels] = await Promise.all([categoryCounts(now), refLabels([row.updatedBy])]);
  return categoryRow(row, counts, labels);
}

/** The parent a category may have: an existing top-level one, not itself — and never for one with children. */
async function checkParent(parentId: string | null, self: SiteCategory | null, issues: CmsIssue[]): Promise<SiteCategory | null> {
  if (!parentId) return null;
  if (self && parentId === self.id) {
    issues.push({ path: "parentId", message: "A category can't be inside itself." });
    return null;
  }
  const parent = TERM_ID.test(parentId) ? await controlDb().siteCategory.findUnique({ where: { id: parentId } }) : null;
  if (!parent) issues.push({ path: "parentId", message: "That category no longer exists." });
  else if (parent.parentId) issues.push({ path: "parentId", message: "Categories nest one level: choose a top-level category." });
  else if (self && (await controlDb().siteCategory.count({ where: { parentId: self.id } }))) issues.push({ path: "parentId", message: "It has subcategories of its own, and categories nest one level only." });
  return parent;
}

async function nextPosition(parentId: string | null): Promise<number> {
  const last = await controlDb().siteCategory.aggregate({ where: { parentId }, _max: { position: true } });
  return (last._max.position ?? -1) + 1;
}

/** Adds a category (editors and admins): a name, an address (made from the name when blank), a description, a parent, search details. */
export async function createCategory(input: CategoryInput, me: CmsMe): Promise<CategoryRow> {
  assertRole(me, CMS_PUBLISHERS);
  const issues: CmsIssue[] = [];
  const name = checkName(input?.name, CATEGORY_NAME_MAX, issues);
  const slug = checkSlug(input?.slug, name, issues);
  const description = checkDescription(input?.description, issues);
  const seo = await checkSeo(input?.seo, issues);
  const parent = await checkParent(input?.parentId ? String(input.parentId) : null, null, issues);
  if (slug && !issues.some((i) => i.path === "slug") && (await controlDb().siteCategory.findUnique({ where: { slug }, select: { id: true } }))) {
    issues.push({ path: "slug", message: "Another category has that address." });
  }
  if (issues.length) throw refusal(issues);
  const row = await controlDb().siteCategory.create({
    data: { slug, name, description, parentId: parent?.id ?? null, position: await nextPosition(parent?.id ?? null), seo: seoJson(seo), updatedBy: actorRef(actorOf(me)) },
    select: { id: true },
  });
  await cmsAudit(actorOf(me), "category.create", "category", row.id, { slug, name, ...(parent ? { parent: parent.slug } : {}) });
  return getCategory(row.id);
}

/**
 * Changes a category (editors and admins): only the fields given. A blank `slug` is made from the
 * name. A new parent puts it last among its new siblings. A new address for an archive with posts on
 * the site leaves a 301 from the old one (`redirect`).
 */
export async function updateCategory(id: string, input: Partial<CategoryInput>, me: CmsMe): Promise<CategoryRow & { redirect: AutoRedirect | null }> {
  assertRole(me, CMS_PUBLISHERS);
  const current = await categoryOrRefuse(id);
  const issues: CmsIssue[] = [];
  const name = input?.name !== undefined ? checkName(input.name, CATEGORY_NAME_MAX, issues) : current.name;
  const slug = input?.slug !== undefined ? checkSlug(input.slug, name, issues) : current.slug;
  const description = input?.description !== undefined ? checkDescription(input.description, issues) : current.description;
  const seo = input?.seo !== undefined ? await checkSeo(input.seo, issues) : seoOf(current.seo);
  const parentId = input?.parentId !== undefined ? (input.parentId ? String(input.parentId) : null) : current.parentId;
  const parentChanged = parentId !== current.parentId;
  if (parentChanged) await checkParent(parentId, current, issues);
  if (slug !== current.slug && !issues.some((i) => i.path === "slug") && (await controlDb().siteCategory.findUnique({ where: { slug }, select: { id: true } }))) {
    issues.push({ path: "slug", message: "Another category has that address." });
  }
  if (issues.length) throw refusal(issues);
  const changed = [
    name !== current.name && "name",
    slug !== current.slug && "slug",
    description !== current.description && "description",
    JSON.stringify(seo) !== JSON.stringify(seoOf(current.seo)) && "seo",
    parentChanged && "parent",
  ].filter((f): f is string => !!f);
  if (!changed.length) return { ...(await getCategory(current.id)), redirect: null };
  const wasLive = slug !== current.slug ? await liveInCategory(current.id) : 0;
  await controlDb().siteCategory.update({
    where: { id: current.id },
    data: { name, slug, description, seo: seoJson(seo), parentId, ...(parentChanged ? { position: await nextPosition(parentId) } : {}), updatedBy: actorRef(actorOf(me)) },
  });
  const redirect = wasLive ? await autoRedirect(categoryPath(current.slug), categoryPath(slug), actorOf(me)) : null;
  invalidateSiteContent();
  await cmsAudit(actorOf(me), "category.update", "category", current.id, { slug, name, changed, ...(slug !== current.slug ? { from: current.slug } : {}), ...(redirect ? { redirectId: redirect.id } : {}) });
  await refreshSeoScores({ type: "CATEGORY", key: current.id });
  return { ...(await getCategory(current.id)), redirect };
}

/** Deletes a category (editors and admins) — refused while it has subcategories. Its posts lose it; they are not deleted. */
export async function deleteCategory(id: string, me: CmsMe): Promise<void> {
  assertRole(me, CMS_PUBLISHERS);
  const current = await categoryOrRefuse(id);
  const children = await controlDb().siteCategory.count({ where: { parentId: current.id } });
  if (children) throw new CmsRefused(`It has ${children === 1 ? "a subcategory" : `${children} subcategories`}. Move or delete ${children === 1 ? "it" : "them"} first.`);
  const posts = await controlDb().$transaction(async (tx) => {
    const removed = await tx.sitePostCategory.deleteMany({ where: { categoryId: current.id } });
    await tx.siteCategory.delete({ where: { id: current.id } });
    return removed.count;
  });
  invalidateSiteContent();
  await cmsAudit(actorOf(me), "category.delete", "category", current.id, { slug: current.slug, name: current.name, posts });
  await refreshSeoScores({ type: "CATEGORY", key: current.id });
}

/** Puts one parent's children (null: the top level) in this order — every one of them, each once. */
export async function reorderCategories(parentId: string | null, orderedIds: string[], me: CmsMe): Promise<CategoryNode[]> {
  assertRole(me, CMS_PUBLISHERS);
  const parent = parentId ? await categoryOrRefuse(parentId) : null;
  const siblings = await controlDb().siteCategory.findMany({ where: { parentId: parent?.id ?? null }, select: { id: true } });
  const wanted = Array.isArray(orderedIds) ? orderedIds.map((v) => String(v)) : [];
  const same = wanted.length === siblings.length && new Set(wanted).size === wanted.length && wanted.every((id) => siblings.some((s) => s.id === id));
  if (!same) throw new CmsRefused("The categories changed since you opened the list. Reload it and try again.");
  await controlDb().$transaction(async (tx) => {
    for (const [position, id] of wanted.entries()) await tx.siteCategory.update({ where: { id }, data: { position }, select: { id: true } });
  });
  invalidateSiteContent();
  await cmsAudit(actorOf(me), "category.update", "category", parent?.id ?? null, { reorder: true, parent: parent?.slug ?? null, categories: wanted.length });
  return listCategories();
}

// ─── Tags ────────────────────────────────────────────────────────────────────────────────────────

function tagRow(t: SiteTag, counts: { all: Map<string, number>; live: Map<string, number> }, labels: Map<string, string>): TagRow {
  return {
    id: t.id,
    slug: t.slug,
    name: t.name,
    description: t.description,
    seo: seoOf(t.seo),
    path: tagPath(t.slug),
    posts: counts.all.get(t.id) ?? 0,
    livePosts: counts.live.get(t.id) ?? 0,
    updatedAt: t.updatedAt,
    updatedBy: labels.get(t.updatedBy) ?? t.updatedBy,
  };
}

async function tagOrRefuse(id: string): Promise<SiteTag> {
  const row = TERM_ID.test(String(id ?? "")) ? await controlDb().siteTag.findUnique({ where: { id } }) : null;
  if (!row) throw new CmsRefused("That tag no longer exists.");
  return row;
}

/** Tags by name, 50 a page, each with its post counts; `q` matches the name or the address. */
export async function listTags(filters: { q?: string; page?: number } = {}, now = new Date()): Promise<Paged<TagRow>> {
  const page = Math.max(1, Math.floor(Number(filters.page) || 1));
  const q = typeof filters.q === "string" ? filters.q.trim().slice(0, 100) : "";
  const where: Prisma.SiteTagWhereInput = q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { slug: { contains: q.toLowerCase() } }] } : {};
  const [rows, total] = await Promise.all([
    controlDb().siteTag.findMany({ where, orderBy: [{ name: "asc" }, { id: "asc" }], skip: (page - 1) * TAGS_PAGE_SIZE, take: TAGS_PAGE_SIZE }),
    controlDb().siteTag.count({ where }),
  ]);
  const [counts, labels] = await Promise.all([tagCounts(rows.map((r) => r.id), now), refLabels(rows.map((r) => r.updatedBy))]);
  return { rows: rows.map((r) => tagRow(r, counts, labels)), total, page, pageSize: TAGS_PAGE_SIZE };
}

/** Tags for the post editor's token input: names or addresses containing `q` (those starting with it first), at most `limit`. */
export async function searchTags(q: string, limit = 20): Promise<CmsTermRef[]> {
  const text = typeof q === "string" ? q.trim().slice(0, 60) : "";
  const take = Math.min(50, Math.max(1, Math.floor(Number(limit) || 20)));
  const rows = await controlDb().siteTag.findMany({
    where: text ? { OR: [{ name: { contains: text, mode: "insensitive" } }, { slug: { contains: slugify(text, TERM_SLUG_MAX) || text.toLowerCase() } }] } : {},
    orderBy: { name: "asc" },
    take: text ? 200 : take,
    select: { id: true, slug: true, name: true },
  });
  const lower = text.toLowerCase();
  return rows.sort((a, b) => Number(!a.name.toLowerCase().startsWith(lower)) - Number(!b.name.toLowerCase().startsWith(lower))).slice(0, take);
}

export async function getTag(id: string, now = new Date()): Promise<TagRow> {
  const row = await tagOrRefuse(id);
  const [counts, labels] = await Promise.all([tagCounts([row.id], now), refLabels([row.updatedBy])]);
  return tagRow(row, counts, labels);
}

/** Adds a tag (any writer): a name (at most 40), an address (made from the name when blank), a description, search details. */
export async function createTag(input: TagInput, me: CmsMe): Promise<TagRow> {
  assertRole(me, CMS_WRITERS);
  const issues: CmsIssue[] = [];
  const name = checkName(input?.name, TAG_NAME_MAX, issues);
  const slug = checkSlug(input?.slug, name, issues);
  const description = checkDescription(input?.description, issues);
  const seo = await checkSeo(input?.seo, issues);
  if (slug && !issues.some((i) => i.path === "slug")) {
    const taken = await controlDb().siteTag.findUnique({ where: { slug }, select: { name: true } });
    if (taken) issues.push({ path: "slug", message: `The tag “${taken.name}” has that address already.` });
  }
  if (issues.length) throw refusal(issues);
  const row = await controlDb().siteTag.create({ data: { slug, name, description, seo: seoJson(seo), updatedBy: actorRef(actorOf(me)) }, select: { id: true } });
  await cmsAudit(actorOf(me), "tag.create", "tag", row.id, { slug, name });
  return getTag(row.id);
}

/** Renames or re-describes a tag (editors and admins); a new address for an archive with posts on the site leaves a 301 (`redirect`). */
export async function updateTag(id: string, input: Partial<TagInput>, me: CmsMe): Promise<TagRow & { redirect: AutoRedirect | null }> {
  assertRole(me, CMS_PUBLISHERS);
  const current = await tagOrRefuse(id);
  const issues: CmsIssue[] = [];
  const name = input?.name !== undefined ? checkName(input.name, TAG_NAME_MAX, issues) : current.name;
  const slug = input?.slug !== undefined ? checkSlug(input.slug, name, issues) : current.slug;
  const description = input?.description !== undefined ? checkDescription(input.description, issues) : current.description;
  const seo = input?.seo !== undefined ? await checkSeo(input.seo, issues) : seoOf(current.seo);
  if (slug !== current.slug && !issues.some((i) => i.path === "slug")) {
    const taken = await controlDb().siteTag.findUnique({ where: { slug }, select: { name: true } });
    if (taken) issues.push({ path: "slug", message: `The tag “${taken.name}” has that address already. Merge them instead?` });
  }
  if (issues.length) throw refusal(issues);
  const changed = [name !== current.name && "name", slug !== current.slug && "slug", description !== current.description && "description", JSON.stringify(seo) !== JSON.stringify(seoOf(current.seo)) && "seo"].filter(
    (f): f is string => !!f,
  );
  if (!changed.length) return { ...(await getTag(current.id)), redirect: null };
  const wasLive = slug !== current.slug ? await liveInTag(current.id) : 0;
  await controlDb().siteTag.update({ where: { id: current.id }, data: { name, slug, description, seo: seoJson(seo), updatedBy: actorRef(actorOf(me)) } });
  const redirect = wasLive ? await autoRedirect(tagPath(current.slug), tagPath(slug), actorOf(me)) : null;
  invalidateSiteContent();
  await cmsAudit(actorOf(me), "tag.update", "tag", current.id, { slug, name, changed, ...(slug !== current.slug ? { from: current.slug } : {}), ...(redirect ? { redirectId: redirect.id } : {}) });
  await refreshSeoScores({ type: "TAG", key: current.id });
  return { ...(await getTag(current.id)), redirect };
}

/**
 * Merges `sourceId` into `targetId` (editors and admins): the source's posts get the target tag, the
 * source is deleted, and a 301 goes from the source's archive to the target's (`redirect`).
 */
export async function mergeTags(sourceId: string, targetId: string, me: CmsMe): Promise<{ tag: TagRow; moved: number; redirect: AutoRedirect | null }> {
  assertRole(me, CMS_PUBLISHERS);
  if (String(sourceId) === String(targetId)) throw new CmsRefused("Choose two different tags.");
  const source = await tagOrRefuse(sourceId);
  const target = await tagOrRefuse(targetId);
  const moved = await controlDb().$transaction(async (tx) => {
    const links = await tx.sitePostTag.findMany({ where: { tagId: source.id }, select: { postId: true } });
    if (links.length) await tx.sitePostTag.createMany({ data: links.map((l) => ({ postId: l.postId, tagId: target.id })), skipDuplicates: true });
    await tx.siteTag.delete({ where: { id: source.id } });
    return links.length;
  });
  const redirect = await autoRedirect(tagPath(source.slug), tagPath(target.slug), actorOf(me));
  invalidateSiteContent();
  await cmsAudit(actorOf(me), "tag.merge", "tag", target.id, { from: source.slug, fromName: source.name, into: target.slug, posts: moved, ...(redirect ? { redirectId: redirect.id } : {}) });
  await refreshSeoScores({ type: "TAG", key: source.id }, { type: "TAG", key: target.id });
  return { tag: await getTag(target.id), moved, redirect };
}

/** Deletes a tag (editors and admins); its posts lose it. */
export async function deleteTag(id: string, me: CmsMe): Promise<void> {
  assertRole(me, CMS_PUBLISHERS);
  const current = await tagOrRefuse(id);
  const posts = await controlDb().sitePostTag.count({ where: { tagId: current.id } });
  await controlDb().siteTag.delete({ where: { id: current.id } });
  invalidateSiteContent();
  await cmsAudit(actorOf(me), "tag.delete", "tag", current.id, { slug: current.slug, name: current.name, posts });
  await refreshSeoScores({ type: "TAG", key: current.id });
}

// ─── A post's categories and tags (src/lib/cms/content.ts) ───────────────────────────────────────

/** What a post's save will do to its terms: tags it keeps or joins, tags to add, and its categories (null: unchanged). */
export type PostTermsPlan = { tagIds: string[]; newTags: { slug: string; name: string }[]; categoryIds: string[] | null };

/**
 * Reads a post's tags and categories as its editor sent them, before anything is written. Each tag is
 * an existing tag's slug, its name (any case), or its name's slug — or a new tag, which a writer may
 * add (a name of at most 40, with a letter or digit). Categories are ids that must exist. Issues at
 * "tags[i]" / "categories[i]"; at most ten of each.
 */
export async function planPostTerms(input: { tags: string[]; categories: string[] | null }, me: CmsMe): Promise<PostTermsPlan> {
  const issues: CmsIssue[] = [];
  const entries = input.tags;
  const tagIds: string[] = [];
  const newTags: { slug: string; name: string }[] = [];
  if (entries.length) {
    const derived = entries.map((e) => slugify(e, TERM_SLUG_MAX));
    const slugs = [...new Set([...entries.map((e) => e.toLowerCase()).filter((e) => e.length <= TERM_SLUG_MAX && TERM_SLUG.test(e)), ...derived.filter(Boolean)])];
    const found = await controlDb().siteTag.findMany({
      where: { OR: [{ slug: { in: slugs } }, ...entries.map((e) => ({ name: { equals: e, mode: "insensitive" as const } }))] },
      select: { id: true, slug: true, name: true },
    });
    entries.forEach((entry, i) => {
      const lower = entry.toLowerCase();
      const tag = found.find((t) => t.slug === lower) ?? found.find((t) => t.name.toLowerCase() === lower) ?? (derived[i] ? found.find((t) => t.slug === derived[i]) : undefined);
      if (tag) {
        if (!tagIds.includes(tag.id)) tagIds.push(tag.id);
        return;
      }
      if (!CMS_WRITERS.includes(me.role)) issues.push({ path: `tags[${i}]`, message: "Your role can't add tags." });
      else if (!derived[i]) issues.push({ path: `tags[${i}]`, message: "A tag needs a letter or a digit." });
      else if (entry.length > TAG_NAME_MAX) issues.push({ path: `tags[${i}]`, message: `Keep a new tag's name to ${TAG_NAME_MAX} characters.` });
      else if (!newTags.some((t) => t.slug === derived[i])) newTags.push({ slug: derived[i], name: entry });
    });
    if (tagIds.length + newTags.length > MAX_POST_TAGS) issues.push({ path: "tags", message: `At most ${MAX_POST_TAGS} tags.` });
  }
  let categoryIds: string[] | null = null;
  if (input.categories) {
    categoryIds = [...new Set(input.categories)];
    if (categoryIds.length > MAX_POST_CATEGORIES) issues.push({ path: "categories", message: `At most ${MAX_POST_CATEGORIES} categories.` });
    const valid = categoryIds.filter((id) => TERM_ID.test(id));
    const found = valid.length ? await controlDb().siteCategory.findMany({ where: { id: { in: valid } }, select: { id: true } }) : [];
    input.categories.forEach((id, i) => {
      if (!found.some((f) => f.id === id)) issues.push({ path: `categories[${i}]`, message: "That category no longer exists." });
    });
  }
  if (issues.length) throw new CmsRefused(issues.length === 1 ? issues[0].message : "Some fields need attention.", { issues });
  return { tagIds, newTags, categoryIds };
}

/** Writes a post's terms in the save's transaction; answers the tags it added (for the activity log). */
export async function writePostTerms(tx: Prisma.TransactionClient, postId: string, plan: PostTermsPlan, by: string): Promise<CmsTermRef[]> {
  let created: CmsTermRef[] = [];
  const newIds: string[] = [];
  if (plan.newTags.length) {
    const slugs = plan.newTags.map((t) => t.slug);
    const before = new Set((await tx.siteTag.findMany({ where: { slug: { in: slugs } }, select: { slug: true } })).map((t) => t.slug));
    await tx.siteTag.createMany({ data: plan.newTags.map((t) => ({ slug: t.slug, name: t.name, updatedBy: by })), skipDuplicates: true });
    const rows = await tx.siteTag.findMany({ where: { slug: { in: slugs } }, select: { id: true, slug: true, name: true } });
    newIds.push(...rows.map((r) => r.id));
    created = rows.filter((r) => !before.has(r.slug));
  }
  const tagIds = [...new Set([...plan.tagIds, ...newIds])];
  await tx.sitePostTag.deleteMany({ where: { postId, tagId: { notIn: tagIds } } });
  if (tagIds.length) await tx.sitePostTag.createMany({ data: tagIds.map((tagId) => ({ postId, tagId })), skipDuplicates: true });
  if (plan.categoryIds) {
    await tx.sitePostCategory.deleteMany({ where: { postId } });
    if (plan.categoryIds.length) await tx.sitePostCategory.createMany({ data: plan.categoryIds.map((categoryId, position) => ({ postId, categoryId, position })) });
  }
  return created;
}

/** The activity log's lines for tags a post's save added. */
export async function auditNewTags(created: CmsTermRef[], me: CmsMe, postId: string): Promise<void> {
  for (const t of created) await cmsAudit(actorOf(me), "tag.create", "tag", t.id, { slug: t.slug, name: t.name, post: postId });
}

// ─── The public site ─────────────────────────────────────────────────────────────────────────────

/** An archive's search and sharing details: its own, else its name and description; the image from the library; its primary keywords, when it has some. */
export type ArchiveSeo = { title: string; description: string | null; image: SitePostCover | null; keywords?: string[] };

type ArchiveBase = {
  slug: string;
  name: string;
  description: string | null;
  /** "/blog/category/<slug>" or "/blog/tag/<slug>". */
  path: string;
  /** The page's canonical address: `path` for page 1 (so "?page=1" is the bare path), else `path?page=N`. */
  canonical: string;
  seo: ArchiveSeo;
  /** 12 a page, newest first. */
  posts: SitePostSummary[];
  total: number;
  page: number;
  pages: number;
  /** The neighbouring pages' addresses, or null. */
  prev: string | null;
  next: string | null;
};

export type CategoryArchive = ArchiveBase & {
  kind: "category";
  /** Its parent, for a child category. */
  parent: SiteTermLink | null;
  /** Its children with posts on the site, and how many each has. */
  children: (SiteTermLink & { count: number })[];
};

export type TagArchive = ArchiveBase & { kind: "tag" };

/** A category with posts on the site, for the /blog chips: `count` includes a parent's children's posts (each once). */
export type BlogCategory = SiteTermLink & { count: number; parentSlug: string | null };

const pageOf = (page: unknown) => Math.min(1000, Math.max(1, Math.floor(Number(page) || 1)));
const slugOf = (slug: unknown) => {
  const s = typeof slug === "string" ? slug.trim().toLowerCase() : "";
  return s && s.length <= TERM_SLUG_MAX && TERM_SLUG.test(s) ? s : null;
};
const pageUrl = (path: string, page: number) => (page <= 1 ? path : `${path}?page=${page}`);

async function archiveSeo(stored: unknown, name: string, description: string | null): Promise<ArchiveSeo> {
  const seo = seoOf(stored) ?? {};
  const image = seo.imageMediaId ? ((await siteImages([seo.imageMediaId])).get(seo.imageMediaId) ?? null) : null;
  // The SEO engine's own reading (src/lib/seo/metadata.ts), so the site and the score panels agree; it carries the keywords through.
  return archiveSeoView(stored, name, description, image);
}

/**
 * A category's archive page: its live posts and its children's, 12 a page, newest first. Null — a
 * 404 — for an unknown category, one with nothing live, or a page past the last.
 */
export async function categoryArchive(slug: string, page: number | string = 1): Promise<CategoryArchive | null> {
  const key = slugOf(slug);
  if (!key) return null;
  const p = pageOf(page);
  return cachedSiteRead(
    `taxonomy:category:${key}:${p}`,
    async () => {
      const cat = await controlDb().siteCategory.findUnique({
        where: { slug: key },
        select: { id: true, slug: true, name: true, description: true, seo: true, parent: { select: { slug: true, name: true } }, children: { orderBy: [{ position: "asc" }, { name: "asc" }], select: { id: true, slug: true, name: true } } },
      });
      if (!cat) return null;
      const now = new Date();
      const ids = [cat.id, ...cat.children.map((c) => c.id)];
      const list = await livePostsPage({ categories: { some: { categoryId: { in: ids } } } }, p, now);
      if (list.total === 0 || p > list.pages) return null;
      const childCounts = cat.children.length
        ? await controlDb().sitePostCategory.groupBy({ by: ["categoryId"], where: { categoryId: { in: cat.children.map((c) => c.id) }, post: livePostWhere(now) }, _count: { _all: true } })
        : [];
      const path = categoryPath(cat.slug);
      return {
        kind: "category" as const,
        slug: cat.slug,
        name: cat.name,
        description: cat.description,
        path,
        canonical: pageUrl(path, p),
        seo: await archiveSeo(cat.seo, cat.name, cat.description),
        ...list,
        prev: p > 1 ? pageUrl(path, p - 1) : null,
        next: p < list.pages ? pageUrl(path, p + 1) : null,
        parent: cat.parent ? { slug: cat.parent.slug, name: cat.parent.name, path: categoryPath(cat.parent.slug) } : null,
        children: cat.children
          .map((c) => ({ slug: c.slug, name: c.name, path: categoryPath(c.slug), count: childCounts.find((g) => g.categoryId === c.id)?._count._all ?? 0 }))
          .filter((c) => c.count > 0),
      };
    },
    () => null,
  );
}

/** A tag's archive page: its live posts, 12 a page, newest first. Null (a 404) for an unknown tag, nothing live, or a page past the last. */
export async function tagArchive(slug: string, page: number | string = 1): Promise<TagArchive | null> {
  const key = slugOf(slug);
  if (!key) return null;
  const p = pageOf(page);
  return cachedSiteRead(
    `taxonomy:tag:${key}:${p}`,
    async () => {
      const tag = await controlDb().siteTag.findUnique({ where: { slug: key }, select: { id: true, slug: true, name: true, description: true, seo: true } });
      if (!tag) return null;
      const list = await livePostsPage({ tagLinks: { some: { tagId: tag.id } } }, p);
      if (list.total === 0 || p > list.pages) return null;
      const path = tagPath(tag.slug);
      return {
        kind: "tag" as const,
        slug: tag.slug,
        name: tag.name,
        description: tag.description,
        path,
        canonical: pageUrl(path, p),
        seo: await archiveSeo(tag.seo, tag.name, tag.description),
        ...list,
        prev: p > 1 ? pageUrl(path, p - 1) : null,
        next: p < list.pages ? pageUrl(path, p + 1) : null,
      };
    },
    () => null,
  );
}

type LiveStats = Map<string, { posts: Set<string>; updatedAt: Date }>;

function addStat(stats: LiveStats, id: string, postId: string, at: Date) {
  const s = stats.get(id);
  if (!s) stats.set(id, { posts: new Set([postId]), updatedAt: at });
  else {
    s.posts.add(postId);
    if (at > s.updatedAt) s.updatedAt = at;
  }
}

/** Every category, and its live posts (a parent's include its children's) with the latest change among them. */
async function liveCategoryStats(now: Date) {
  const [cats, links] = await Promise.all([
    controlDb().siteCategory.findMany({ orderBy: [{ position: "asc" }, { name: "asc" }], select: { id: true, slug: true, name: true, parentId: true } }),
    controlDb().sitePostCategory.findMany({ where: { post: livePostWhere(now) }, select: { categoryId: true, postId: true, post: { select: { updatedAt: true } } } }),
  ]);
  const parentOf = new Map(cats.map((c) => [c.id, c.parentId]));
  const stats: LiveStats = new Map();
  for (const l of links) {
    addStat(stats, l.categoryId, l.postId, l.post.updatedAt);
    const parent = parentOf.get(l.categoryId);
    if (parent) addStat(stats, parent, l.postId, l.post.updatedAt);
  }
  return { cats, stats };
}

/** The categories with posts on the site, for the /blog chips: each top-level one, then its children, by position; with counts. */
export async function blogCategories(): Promise<BlogCategory[]> {
  return cachedSiteRead(
    "taxonomy:blog-categories",
    async () => {
      const { cats, stats } = await liveCategoryStats(new Date());
      const ids = new Set(cats.map((c) => c.id));
      const bySlug = new Map(cats.map((c) => [c.id, c.slug]));
      const out: BlogCategory[] = [];
      const push = (c: (typeof cats)[number]) => {
        const count = stats.get(c.id)?.posts.size ?? 0;
        if (count > 0) out.push({ slug: c.slug, name: c.name, path: categoryPath(c.slug), count, parentSlug: c.parentId ? (bySlug.get(c.parentId) ?? null) : null });
      };
      for (const top of cats.filter((c) => !c.parentId || !ids.has(c.parentId))) {
        push(top);
        for (const child of cats.filter((c) => c.parentId === top.id)) push(child);
      }
      return out;
    },
    () => [],
  );
}

/** For the sitemap: every category and tag archive with at least one post on the site, and when its newest change was. */
export async function taxonomySitemapEntries(): Promise<{ path: string; updatedAt: Date }[]> {
  return cachedSiteRead(
    "taxonomy:sitemap",
    async () => {
      const now = new Date();
      const [{ cats, stats }, tagLinks] = await Promise.all([
        liveCategoryStats(now),
        controlDb().sitePostTag.findMany({ where: { post: livePostWhere(now) }, select: { tagId: true, postId: true, tag: { select: { slug: true } }, post: { select: { updatedAt: true } } } }),
      ]);
      const tagStats: LiveStats = new Map();
      const tagSlugs = new Map<string, string>();
      for (const l of tagLinks) {
        addStat(tagStats, l.tagId, l.postId, l.post.updatedAt);
        tagSlugs.set(l.tagId, l.tag.slug);
      }
      const categories = cats.filter((c) => (stats.get(c.id)?.posts.size ?? 0) > 0).map((c) => ({ path: categoryPath(c.slug), updatedAt: stats.get(c.id)!.updatedAt }));
      const tags = [...tagStats].map(([id, s]) => ({ path: tagPath(tagSlugs.get(id)!), updatedAt: s.updatedAt }));
      return [...categories, ...tags].sort((a, b) => a.path.localeCompare(b.path));
    },
    () => [],
  );
}

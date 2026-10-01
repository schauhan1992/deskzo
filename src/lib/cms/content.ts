import { Prisma, type SitePage as PageRowModel, type SitePost as PostRowModel } from "@deskzo/control-client";
import type { SiteSettings } from "@/components/site/blocks/types";
import { DEFAULT_SITE_PAGES, DEFAULT_SITE_SETTINGS } from "@/components/site/defaults";
import { actorOfMe, actorRef, cmsAudit, listCmsAudit, refLabels, type CmsActor } from "@/lib/cms/audit";
import { missingMediaIds, mediaWithoutAlt } from "@/lib/cms/media";
import { mintPreviewToken, previewUrl, PREVIEW_TTL_MS } from "@/lib/cms/preview";
import { autoRedirect, checkRedirect, releasePath, saveRedirectFrom } from "@/lib/cms/redirects";
import { refreshSeoScores } from "@/lib/cms/seo-scores";
import { auditNewTags, MAX_POST_CATEGORIES, MAX_POST_TAGS, planPostTerms, writePostTerms } from "@/lib/cms/taxonomy";
import {
  BUILTIN_PAGE_SLUGS,
  CmsRefused,
  POST_BLOCK_TYPES,
  REQUIRED_BLOCKS,
  type BuiltinPageSlug,
  type CmsDashboard,
  type CmsIssue,
  type CmsMe,
  type PageDetail,
  type PageDocument,
  type PageListRow,
  type PageSaved,
  type PageStatus,
  type PageVersionRow,
  type Paged,
  type PostDetail,
  type PostInput,
  type PostListRow,
  type PostSaved,
  type PostSeo,
  type RedirectRow,
  type SettingsDetail,
  type SitePostStatus,
} from "@/lib/cms/types";
import {
  checkPageDocument,
  checkPostBody,
  checkPostSeo,
  checkSiteSettings,
  isReservedPostSlug,
  mediaIssues,
  PAGE_SLUG,
  PAGE_SLUG_MAX_DEPTH,
  PAGE_SLUG_MAX_LENGTH,
  pageSlugProblem,
  POST_SLUG,
  slugify,
  stableJson,
  TERM_SLUG,
  type ValidationMode,
} from "@/lib/cms/validate";
import { controlDb } from "@/lib/platform/control-db";
import { parseIstDateTime } from "@/lib/india-time";
import { invalidateSiteContent, mergeSiteSettings, sitePath } from "@/lib/platform/site-content";

/**
 * The website's content, as the CMS edits it: pages (draft and published copies, versions), posts
 * (one body; scheduled publishing), and the site's settings and navigation (draft and published).
 *
 *   · Every document is checked against the site's content model (./validate.ts) before it is stored;
 *     every image it uses must be in the media library, and — to be published — have alt text.
 *   · Saves are optimistic: the editor sends back the `version` it loaded, and a save over somebody
 *     else's newer one is refused with a `conflict` (unless it says `force`).
 *   · Whatever changes what the site shows clears the site's content cache in this process
 *     (src/lib/platform/site-content.ts invalidateSiteContent), and a publish or a live save
 *     recalculates that page's or post's SEO score (src/lib/cms/seo-scores.ts refreshSeoScores —
 *     it never fails the save).
 *   · Every change writes the CMS's activity log — ids, slugs, titles and counts, never a body.
 *     Repeated saves of one thing by one person within ten minutes (autosave) are one entry.
 *
 * Role sets are checked by the actions (src/actions/cms/*); the rules that depend on the thing
 * itself — an author may change only their own draft posts, a built-in page is never unpublished or
 * deleted — are checked here.
 */

const actorOf = (me: CmsMe): CmsActor => actorOfMe(me);
const json = (value: unknown) => value as Prisma.InputJsonValue;
const SAVE_AUDIT_WINDOW_MS = 10 * 60_000;
const MEDIA_ID = /^[a-z0-9]{20,40}$/;
/** A category's or tag's slug, as a list filter. */
const termSlug = (value: unknown): string | null => (typeof value === "string" && value.length <= 60 && TERM_SLUG.test(value) ? value : null);

function cleanLine(raw: unknown, max: number): string {
  return String(raw ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, max);
}

async function auditSave(me: CmsMe, action: "page.save" | "post.save" | "settings.save", entity: string, entityId: string, detail: Record<string, unknown>) {
  const recent = await controlDb().cmsAuditLog.findFirst({ where: { action, entityId, actorId: me.id, at: { gt: new Date(Date.now() - SAVE_AUDIT_WINDOW_MS) } }, select: { id: true } });
  if (!recent) await cmsAudit(actorOf(me), action, entity, entityId, detail);
}

function conflictOf(what: string, updatedAt: Date, updatedBy: string): CmsRefused {
  return new CmsRefused(`Somebody else saved this ${what} since you opened it.`, { conflict: { version: updatedAt.toISOString(), updatedBy } });
}

function versionDate(version: unknown): Date | null {
  if (typeof version !== "string" || !version) return null;
  const at = new Date(version);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** Every image a document uses is in the library — and, to publish, has alt text. */
async function assertMedia(value: unknown, ids: string[], publish: boolean, extra: CmsIssue[] = []): Promise<void> {
  const issues = [...extra];
  const missing = await missingMediaIds(ids);
  if (missing.length) issues.push(...mediaIssues(value, new Set(missing), () => "This image is no longer in the media library."));
  if (publish) {
    const noAlt = await mediaWithoutAlt(ids.filter((id) => !missing.includes(id)));
    const names = new Map(noAlt.map((m) => [m.id, m.filename]));
    if (names.size) issues.push(...mediaIssues(value, new Set(names.keys()), (id) => `"${names.get(id)}" has no alt text yet — add it in the media library.`));
  }
  if (issues.length) throw new CmsRefused("Some images need attention.", { issues });
}

// ─── Pages ───────────────────────────────────────────────────────────────────────────────────────

const isBuiltin = (slug: string): slug is BuiltinPageSlug => (BUILTIN_PAGE_SLUGS as readonly string[]).includes(slug);

/** A built-in page's default content, as a document — for "Reset to the default" in the editor. */
export function defaultPageDocument(slug: string): PageDocument | null {
  const page = DEFAULT_SITE_PAGES.find((p) => p.slug === slug);
  return page ? (structuredClone({ title: page.title, seo: page.seo, blocks: page.blocks }) as PageDocument) : null;
}

type Target = { row: PageRowModel | null; slug: string; builtin: boolean };

/** A page by its id — or by "builtin-<slug>" for a built-in page, saved or not. */
async function findPage(ref: string): Promise<Target> {
  const r = String(ref ?? "").slice(0, 60);
  const builtin = /^builtin-([a-z]+)$/.exec(r)?.[1];
  if (builtin && isBuiltin(builtin)) return { row: await controlDb().sitePage.findUnique({ where: { slug: builtin } }), slug: builtin, builtin: true };
  const row = /^[a-z0-9]{20,40}$/.test(r) ? await controlDb().sitePage.findUnique({ where: { id: r } }) : null;
  if (!row) throw new CmsRefused("That page no longer exists.");
  return { row, slug: row.slug, builtin: isBuiltin(row.slug) };
}

const pageChanged = (row: PageRowModel) => row.status === "PUBLISHED" && stableJson(row.draft) !== stableJson(row.published);

function savedOf(row: PageRowModel): PageSaved {
  return { id: row.id, slug: row.slug, version: row.updatedAt.toISOString(), status: row.status, changed: pageChanged(row), updatedAt: row.updatedAt, publishedAt: row.publishedAt };
}

export async function getPage(ref: string): Promise<PageDetail> {
  const { row, slug, builtin } = await findPage(ref);
  const requiredBlock = builtin ? (REQUIRED_BLOCKS[slug as BuiltinPageSlug] ?? null) : null;
  if (!row) {
    return {
      id: `builtin-${slug}`,
      saved: false,
      slug,
      path: sitePath(slug),
      builtin,
      status: "DEFAULT",
      draft: defaultPageDocument(slug)!,
      published: null,
      changed: false,
      archived: false,
      version: "",
      updatedAt: null,
      updatedBy: null,
      publishedAt: null,
      publishedBy: null,
      createdAt: null,
      createdBy: null,
      requiredBlock,
    };
  }
  const labels = await refLabels([row.updatedBy, row.publishedBy, row.createdBy]);
  return {
    id: row.id,
    saved: true,
    slug,
    path: sitePath(slug),
    builtin,
    status: row.status,
    draft: row.draft as unknown as PageDocument,
    published: (row.published as unknown as PageDocument | null) ?? null,
    changed: pageChanged(row),
    archived: !!row.archivedAt,
    version: row.updatedAt.toISOString(),
    updatedAt: row.updatedAt,
    updatedBy: labels.get(row.updatedBy) ?? row.updatedBy,
    publishedAt: row.publishedAt,
    publishedBy: row.publishedBy ? (labels.get(row.publishedBy) ?? row.publishedBy) : null,
    createdAt: row.createdAt,
    createdBy: labels.get(row.createdBy) ?? row.createdBy,
    requiredBlock,
  };
}

/** Every page: the built-in ones first (saved or not), then the rest, most recently changed first. */
export async function listPages(filters: { q?: string; status?: PageStatus; archived?: boolean } = {}): Promise<PageListRow[]> {
  const [rows, changed] = await Promise.all([
    controlDb().sitePage.findMany({
      orderBy: { updatedAt: "desc" },
      select: { id: true, slug: true, title: true, status: true, updatedAt: true, updatedBy: true, publishedAt: true, archivedAt: true },
    }),
    controlDb().$queryRaw<{ id: string }[]>`SELECT id FROM site_pages WHERE status = 'PUBLISHED' AND draft IS DISTINCT FROM published`,
  ]);
  const changedIds = new Set(changed.map((c) => c.id));
  const labels = await refLabels(rows.map((r) => r.updatedBy));
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const toRow = (r: (typeof rows)[number]): PageListRow => ({
    id: r.id,
    slug: r.slug,
    path: sitePath(r.slug),
    title: r.title,
    status: r.status,
    builtin: isBuiltin(r.slug),
    changed: changedIds.has(r.id),
    archived: !!r.archivedAt,
    updatedAt: r.updatedAt,
    updatedBy: labels.get(r.updatedBy) ?? r.updatedBy,
    publishedAt: r.publishedAt,
  });
  const builtins = BUILTIN_PAGE_SLUGS.map((slug): PageListRow => {
    const saved = bySlug.get(slug);
    if (saved) return toRow(saved);
    const page = DEFAULT_SITE_PAGES.find((p) => p.slug === slug)!;
    return { id: `builtin-${slug}`, slug, path: sitePath(slug), title: page.title, status: "DEFAULT", builtin: true, changed: false, archived: false, updatedAt: null, updatedBy: null, publishedAt: null };
  });
  const added = rows.filter((r) => !isBuiltin(r.slug)).map(toRow);
  const q = typeof filters.q === "string" ? filters.q.trim().toLowerCase().slice(0, 100) : "";
  return [...builtins, ...added].filter(
    (p) =>
      (filters.archived ? p.archived : !p.archived) &&
      (!filters.status || p.status === filters.status) &&
      (!q || p.title.toLowerCase().includes(q) || p.slug.includes(q)),
  );
}

/**
 * A new page's address, checked: the format and depth, the site's own routes, the built-in pages
 * (validate.ts `pageSlugProblem`, which the CMS's dialogs run as they are typed), and every page there is.
 */
async function checkNewPageSlug(raw: unknown, exceptId?: string): Promise<string> {
  const slug = String(raw ?? "").trim().toLowerCase().replace(/^\/+|\/+$/g, "");
  const problem = pageSlugProblem(slug);
  if (problem) {
    const reserved = PAGE_SLUG.test(slug) && slug.length <= PAGE_SLUG_MAX_LENGTH && slug.split("/").length <= PAGE_SLUG_MAX_DEPTH;
    const taken = reserved && isBuiltin(slug);
    throw new CmsRefused(problem, { issues: [{ path: "slug", message: taken ? "Taken." : reserved ? "Reserved." : "Not a valid address." }] });
  }
  const existing = await controlDb().sitePage.findUnique({ where: { slug }, select: { id: true, archivedAt: true } });
  if (existing && existing.id !== exceptId) {
    throw new CmsRefused(existing.archivedAt ? "An archived page has that address. Restore or delete it first." : "A page already has that address.", { issues: [{ path: "slug", message: "Taken." }] });
  }
  return slug;
}

export async function createPage(input: { slug: string; title: string }, me: CmsMe): Promise<PageDetail> {
  const title = cleanLine(input?.title, 120);
  if (!title) throw new CmsRefused("Give the page a title.", { issues: [{ path: "title", message: "Fill this in." }] });
  const slug = await checkNewPageSlug(input?.slug);
  const doc: PageDocument = { title, seo: { title, description: "" }, blocks: [{ id: "header", type: "pageHeader", props: { heading: title } }] };
  const by = actorRef(actorOf(me));
  const row = await controlDb().sitePage.create({ data: { slug, title, draft: json(doc), createdBy: by, updatedBy: by }, select: { id: true } });
  await cmsAudit(actorOf(me), "page.create", "page", row.id, { slug, title });
  return getPage(row.id);
}

/** Writes a checked document as the draft — creating a built-in page's row on its first save. */
async function writeDraft(target: Target, doc: PageDocument, version: unknown, force: boolean, me: CmsMe): Promise<PageRowModel> {
  const by = actorRef(actorOf(me));
  const title = (doc.title || target.slug).slice(0, 200);
  if (!target.row) {
    if (!target.builtin) throw new CmsRefused("That page no longer exists.");
    try {
      return await controlDb().sitePage.create({ data: { slug: target.slug, title, draft: json(doc), createdBy: by, updatedBy: by } });
    } catch (err) {
      const now = await controlDb().sitePage.findUnique({ where: { slug: target.slug } });
      if (now) throw conflictOf("page", now.updatedAt, (await refLabels([now.updatedBy])).get(now.updatedBy) ?? now.updatedBy);
      throw err;
    }
  }
  if (target.row.archivedAt) throw new CmsRefused("This page is archived. Restore it before changing it.");
  const expected = versionDate(version);
  if (!force && !expected) throw conflictOf("page", target.row.updatedAt, (await refLabels([target.row.updatedBy])).get(target.row.updatedBy) ?? target.row.updatedBy);
  const written = await controlDb().sitePage.updateMany({ where: { id: target.row.id, ...(force ? {} : { updatedAt: expected! }) }, data: { draft: json(doc), title, updatedBy: by } });
  const row = await controlDb().sitePage.findUniqueOrThrow({ where: { id: target.row.id } });
  if (written.count === 0) throw conflictOf("page", row.updatedAt, (await refLabels([row.updatedBy])).get(row.updatedBy) ?? row.updatedBy);
  return row;
}

function checkedPage(document: unknown, mode: ValidationMode): { doc: PageDocument; media: string[] } {
  const checked = checkPageDocument(document, mode);
  if (!checked.ok) throw new CmsRefused(mode === "publish" ? "Some fields need attention before this can be published." : "Some fields need attention.", { issues: checked.issues });
  return { doc: checked.value, media: checked.media };
}

/** Saves the draft. `version` is the one loaded ("" for a built-in page never saved); `force` overwrites a newer save. */
export async function savePageDraft(ref: string, input: { document: unknown; version: string; force?: boolean }, me: CmsMe): Promise<PageSaved> {
  const target = await findPage(ref);
  const { doc, media } = checkedPage(input?.document, "draft");
  await assertMedia(doc, media, false);
  const row = await writeDraft(target, doc, input?.version, !!input?.force, me);
  await auditSave(me, "page.save", "page", row.id, { slug: row.slug, blocks: doc.blocks.length });
  return savedOf(row);
}

/**
 * Publishes: the draft (or `document`, saved first) is checked in full, copied to what the site
 * shows, and kept as a version with `note`. Built-in form pages must keep their form block.
 */
export async function publishPage(ref: string, input: { document?: unknown; version?: string; force?: boolean; note?: string }, me: CmsMe): Promise<PageSaved> {
  const target = await findPage(ref);
  if (target.row?.archivedAt) throw new CmsRefused("This page is archived. Restore it before publishing it.");
  const source = input?.document !== undefined ? input.document : (target.row?.draft ?? defaultPageDocument(target.slug));
  const { doc, media } = checkedPage(source, "publish");
  const required = target.builtin ? REQUIRED_BLOCKS[target.slug as BuiltinPageSlug] : undefined;
  if (required && !doc.blocks.some((b) => b.type === required)) {
    throw new CmsRefused(`This page exists for its ${required} block — put it back before publishing.`, { issues: [{ path: "blocks", message: `Keep the ${required} block.` }] });
  }
  await assertMedia(doc, media, true);
  const note = cleanLine(input?.note, 200) || null;
  const by = actorRef(actorOf(me));
  const now = new Date();
  const expected = versionDate(input?.version);
  const checkVersion = !input?.force && (input?.document !== undefined || !!expected);
  const title = (doc.title || target.slug).slice(0, 200);
  const published = await controlDb().$transaction(async (tx) => {
    let id: string;
    if (!target.row) {
      const made = await tx.sitePage.create({
        data: { slug: target.slug, title, draft: json(doc), published: json(doc), status: "PUBLISHED", publishedAt: now, publishedBy: by, createdBy: by, updatedBy: by },
        select: { id: true },
      });
      id = made.id;
    } else {
      if (checkVersion && !expected) return null;
      const written = await tx.sitePage.updateMany({
        where: { id: target.row.id, archivedAt: null, ...(checkVersion ? { updatedAt: expected! } : {}) },
        data: { draft: json(doc), published: json(doc), title, status: "PUBLISHED", publishedAt: now, publishedBy: by, updatedBy: by },
      });
      if (written.count === 0) return null;
      id = target.row.id;
    }
    const version = await tx.sitePageVersion.create({ data: { pageId: id, document: json(doc), note, createdBy: by }, select: { id: true } });
    return { id, versionId: version.id };
  });
  if (!published) {
    const row = await controlDb().sitePage.findUniqueOrThrow({ where: { id: target.row!.id } });
    throw conflictOf("page", row.updatedAt, (await refLabels([row.updatedBy])).get(row.updatedBy) ?? row.updatedBy);
  }
  // A redirect from this address would hide the page now live there.
  await releasePath(sitePath(target.slug), actorOf(me));
  invalidateSiteContent();
  await cmsAudit(actorOf(me), "page.publish", "page", published.id, { slug: target.slug, title, blocks: doc.blocks.length, versionId: published.versionId });
  await refreshSeoScores({ type: "PAGE", key: target.slug });
  return savedOf(await controlDb().sitePage.findUniqueOrThrow({ where: { id: published.id } }));
}

/** Takes an added page off the site. A built-in page is never unpublished: publish the content it should have instead. */
export async function unpublishPage(ref: string, me: CmsMe): Promise<PageSaved> {
  const target = await findPage(ref);
  if (target.builtin) throw new CmsRefused("The site's own pages can't be unpublished — the site would have a hole. Publish the content it should show instead, or reset it to the default.");
  const row = target.row!;
  if (row.status !== "PUBLISHED") throw new CmsRefused("This page isn't published.");
  const updated = await controlDb().sitePage.update({ where: { id: row.id }, data: { status: "DRAFT", published: Prisma.DbNull, publishedAt: null, publishedBy: null, updatedBy: actorRef(actorOf(me)) } });
  invalidateSiteContent();
  await cmsAudit(actorOf(me), "page.unpublish", "page", row.id, { slug: row.slug, title: row.title });
  await refreshSeoScores({ type: "PAGE", key: row.slug });
  return savedOf(updated);
}

/** Publish history, newest first (the last 100). */
export async function listPageVersions(ref: string): Promise<PageVersionRow[]> {
  const { row } = await findPage(ref);
  if (!row) return [];
  const rows = await controlDb().$queryRaw<{ id: string; note: string | null; createdAt: Date; createdBy: string; title: string; blocks: number }[]>`
    SELECT id, note, "createdAt", "createdBy", coalesce(document->>'title', '') AS title,
           coalesce(jsonb_array_length(CASE WHEN jsonb_typeof(document->'blocks') = 'array' THEN document->'blocks' END), 0)::int AS blocks
    FROM site_page_versions WHERE "pageId" = ${row.id} ORDER BY "createdAt" DESC LIMIT 100`;
  const labels = await refLabels(rows.map((r) => r.createdBy));
  return rows.map((r) => ({ ...r, blocks: Number(r.blocks), createdBy: labels.get(r.createdBy) ?? r.createdBy }));
}

/** One version's document, to look at before restoring it. */
export async function getPageVersionDocument(ref: string, versionId: string): Promise<PageDocument> {
  const { row } = await findPage(ref);
  const version = row ? await controlDb().sitePageVersion.findFirst({ where: { id: String(versionId ?? "").slice(0, 40), pageId: row.id }, select: { document: true } }) : null;
  if (!version) throw new CmsRefused("That version no longer exists.");
  return version.document as unknown as PageDocument;
}

/** Copies a version into the draft (nothing on the site changes until it is published). */
export async function restorePageVersion(ref: string, versionId: string, input: { version?: string; force?: boolean }, me: CmsMe): Promise<PageSaved> {
  const target = await findPage(ref);
  const document = await getPageVersionDocument(ref, versionId);
  const { doc, media } = checkedPage(document, "draft");
  await assertMedia(doc, media, false);
  const row = await writeDraft(target, doc, input?.version, input?.force ?? !input?.version, me);
  await cmsAudit(actorOf(me), "page.version.restore", "page", row.id, { slug: row.slug, versionId });
  return savedOf(row);
}

/** Keeps the current draft as a version, with a note — a checkpoint without publishing. */
export async function savePageVersion(ref: string, noteInput: string, me: CmsMe): Promise<PageVersionRow> {
  const { row } = await findPage(ref);
  if (!row) throw new CmsRefused("Save the page first.");
  const note = cleanLine(noteInput, 200) || null;
  const by = actorRef(actorOf(me));
  const version = await controlDb().sitePageVersion.create({ data: { pageId: row.id, document: json(row.draft), note, createdBy: by } });
  await cmsAudit(actorOf(me), "page.version.save", "page", row.id, { slug: row.slug, versionId: version.id });
  const doc = row.draft as unknown as PageDocument;
  return { id: version.id, note, createdAt: version.createdAt, createdBy: me.name, title: String(doc.title ?? ""), blocks: Array.isArray(doc.blocks) ? doc.blocks.length : 0 };
}

/**
 * Moves an added page to another address. A published page's old address answers with a 301 to the
 * new one, made automatically (`redirect` says which); a draft's simply stops.
 */
export async function changePageSlug(ref: string, slugInput: string, me: CmsMe): Promise<PageSaved> {
  const target = await findPage(ref);
  if (target.builtin || !target.row) throw new CmsRefused("The site's own pages keep their addresses.");
  const slug = await checkNewPageSlug(slugInput, target.row.id);
  if (slug === target.row.slug) return savedOf(target.row);
  const row = await controlDb().sitePage.update({ where: { id: target.row.id }, data: { slug, updatedBy: actorRef(actorOf(me)) } });
  const redirect = row.status === "PUBLISHED" && !row.archivedAt ? await autoRedirect(sitePath(target.row.slug), sitePath(slug), actorOf(me)) : null;
  if (row.status === "PUBLISHED") invalidateSiteContent();
  await cmsAudit(actorOf(me), "page.slug", "page", row.id, { from: target.row.slug, to: slug, ...(redirect ? { redirectId: redirect.id } : {}) });
  // Its score moves with it: the old address's row is dropped, the new one calculated.
  await refreshSeoScores({ type: "PAGE", key: target.row.slug }, { type: "PAGE", key: slug });
  return { ...savedOf(row), redirect };
}

/** Takes an added page off the site and out of the list; its content and versions are kept. */
export async function archivePage(ref: string, me: CmsMe): Promise<void> {
  const target = await findPage(ref);
  if (target.builtin || !target.row) throw new CmsRefused("The site's own pages can't be archived.");
  if (target.row.archivedAt) return;
  await controlDb().sitePage.update({
    where: { id: target.row.id },
    data: { archivedAt: new Date(), status: "DRAFT", published: Prisma.DbNull, publishedAt: null, publishedBy: null, updatedBy: actorRef(actorOf(me)) },
  });
  if (target.row.status === "PUBLISHED") invalidateSiteContent();
  await cmsAudit(actorOf(me), "page.archive", "page", target.row.id, { slug: target.row.slug, title: target.row.title });
}

export async function unarchivePage(ref: string, me: CmsMe): Promise<void> {
  const target = await findPage(ref);
  if (!target.row?.archivedAt) return;
  await controlDb().sitePage.update({ where: { id: target.row.id }, data: { archivedAt: null, updatedBy: actorRef(actorOf(me)) } });
  await cmsAudit(actorOf(me), "page.unarchive", "page", target.row.id, { slug: target.row.slug });
}

/** Deletes an archived page, with its versions, for good. */
export async function deletePage(ref: string, me: CmsMe): Promise<void> {
  const target = await findPage(ref);
  if (target.builtin || !target.row) throw new CmsRefused("The site's own pages can't be deleted.");
  if (!target.row.archivedAt) throw new CmsRefused("Archive the page first — it comes off the site, and can still be brought back until it is deleted.");
  await controlDb().sitePage.delete({ where: { id: target.row.id } });
  await cmsAudit(actorOf(me), "page.delete", "page", target.row.id, { slug: target.row.slug, title: target.row.title });
}

/** A 15-minute link to the page's draft on the public site. */
export async function pagePreviewLink(ref: string, me: CmsMe): Promise<{ url: string; expiresAt: Date }> {
  const target = await findPage(ref);
  const id = target.row?.id ?? `builtin-${target.slug}`;
  const token = mintPreviewToken("page", id, target.row?.updatedAt ?? null);
  await cmsAudit(actorOf(me), "preview.link", "page", id, { slug: target.slug });
  return { url: previewUrl(token), expiresAt: new Date(Date.now() + PREVIEW_TTL_MS) };
}

// ─── Posts ───────────────────────────────────────────────────────────────────────────────────────

const POSTS_PAGE_SIZE = 30;
const POST_ROW_SELECT = {
  id: true,
  slug: true,
  title: true,
  status: true,
  publishAt: true,
  publishedAt: true,
  coverMediaId: true,
  archivedAt: true,
  updatedAt: true,
  updatedBy: true,
  author: { select: { id: true, name: true } },
  categories: { orderBy: { position: "asc" }, select: { category: { select: { id: true, slug: true, name: true } } } },
  tagLinks: { orderBy: { tag: { name: "asc" } }, select: { tag: { select: { id: true, slug: true, name: true } } } },
} as const satisfies Prisma.SitePostSelect;
type PostRowData = Prisma.SitePostGetPayload<{ select: typeof POST_ROW_SELECT }>;

const postLive = (p: { status: SitePostStatus; archivedAt: Date | null; publishAt: Date | null }, now: Date) =>
  p.status !== "DRAFT" && !p.archivedAt && !!p.publishAt && p.publishAt <= now;

function postRow(p: PostRowData, labels: Map<string, string>, now: Date): PostListRow {
  return {
    id: p.id,
    slug: p.slug,
    path: `/blog/${p.slug}`,
    title: p.title,
    status: p.status,
    live: postLive(p, now),
    publishAt: p.publishAt,
    publishedAt: p.publishedAt,
    tags: p.tagLinks.map((l) => l.tag.slug),
    tagRefs: p.tagLinks.map((l) => l.tag),
    categories: p.categories.map((c) => c.category),
    coverMediaId: p.coverMediaId,
    author: p.author,
    archived: !!p.archivedAt,
    updatedAt: p.updatedAt,
    updatedBy: labels.get(p.updatedBy) ?? p.updatedBy,
  };
}

/** The CMS's post list. `tag` and `category` are slugs (a category's own posts, not its children's). */
export async function listPosts(
  filters: { status?: SitePostStatus; tag?: string; category?: string; authorId?: string; q?: string; archived?: boolean; page?: number } = {},
  now = new Date(),
): Promise<Paged<PostListRow>> {
  const page = Math.max(1, Math.floor(Number(filters.page) || 1));
  const q = typeof filters.q === "string" ? filters.q.trim().slice(0, 100) : "";
  const tag = termSlug(filters.tag);
  const category = termSlug(filters.category);
  const where: Prisma.SitePostWhereInput = {
    archivedAt: filters.archived ? { not: null } : null,
    ...(filters.status ? { status: filters.status } : {}),
    ...(tag ? { tagLinks: { some: { tag: { slug: tag } } } } : {}),
    ...(category ? { categories: { some: { category: { slug: category } } } } : {}),
    ...(filters.authorId ? { authorId: String(filters.authorId).slice(0, 40) } : {}),
    ...(q ? { OR: [{ title: { contains: q, mode: "insensitive" } }, { slug: { contains: q.toLowerCase() } }] } : {}),
  };
  const [rows, total] = await Promise.all([
    controlDb().sitePost.findMany({ where, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], skip: (page - 1) * POSTS_PAGE_SIZE, take: POSTS_PAGE_SIZE, select: POST_ROW_SELECT }),
    controlDb().sitePost.count({ where }),
  ]);
  const labels = await refLabels(rows.map((r) => r.updatedBy));
  return { rows: rows.map((r) => postRow(r, labels, now)), total, page, pageSize: POSTS_PAGE_SIZE };
}

/** Every tag's slug (at most 500, by slug), for the tag filter and the editor's suggestions. Names and counts: src/lib/cms/taxonomy.ts. */
export async function listPostTags(): Promise<string[]> {
  const rows = await controlDb().siteTag.findMany({ orderBy: { slug: "asc" }, take: 500, select: { slug: true } });
  return rows.map((r) => r.slug);
}

async function postOrRefuse(id: string): Promise<PostRowModel> {
  const row = /^[a-z0-9]{20,40}$/.test(String(id ?? "")) ? await controlDb().sitePost.findUnique({ where: { id } }) : null;
  if (!row) throw new CmsRefused("That post no longer exists.");
  return row;
}

/** Live now, or ever published or scheduled (the activity log says so) — its address may be known out there. */
async function everPublished(row: { id: string; status: SitePostStatus; archivedAt: Date | null; publishAt: Date | null }, now: Date): Promise<boolean> {
  if (postLive(row, now) || row.status !== "DRAFT") return true;
  return !!(await controlDb().cmsAuditLog.findFirst({ where: { entity: "post", entityId: row.id, action: { in: ["post.publish", "post.schedule"] } }, select: { id: true } }));
}

export async function getPost(id: string, now = new Date()): Promise<PostDetail> {
  await postOrRefuse(id);
  const row = await controlDb().sitePost.findUniqueOrThrow({ where: { id }, select: { ...POST_ROW_SELECT, excerpt: true, body: true, seo: true, createdAt: true } });
  const [labels, wasPublished] = await Promise.all([refLabels([row.updatedBy]), everPublished(row, now)]);
  return {
    ...postRow(row, labels, now),
    excerpt: row.excerpt,
    body: (Array.isArray(row.body) ? row.body : []) as unknown as PostDetail["body"],
    seo: (row.seo as PostSeo | null) ?? null,
    version: row.updatedAt.toISOString(),
    createdAt: row.createdAt,
    wasPublished,
  };
}

/** An author may change a post only while it is theirs and a draft. */
function assertMayChangePost(row: PostRowModel, me: CmsMe) {
  if (me.role === "VIEWER") throw new CmsRefused("Your role cannot do that.");
  if (me.role === "AUTHOR" && (row.authorId !== me.id || row.status !== "DRAFT")) throw new CmsRefused("Authors can change only their own draft posts.");
}

/** The first free address from `base`: itself, else "-2", "-3"… — never one the blog's routes need (category, tag, page). */
async function freePostSlug(base: string, exceptId?: string): Promise<string> {
  const stem = (base || "post").slice(0, 110);
  for (let n = 1; n <= 50; n++) {
    const slug = n === 1 ? stem : `${stem}-${n}`;
    if (isReservedPostSlug(slug)) continue;
    const taken = await controlDb().sitePost.findUnique({ where: { slug }, select: { id: true } });
    if (!taken || taken.id === exceptId) return slug;
  }
  throw new CmsRefused("Choose another address for this post.");
}

const RESERVED_SLUG_MESSAGE = "The blog uses that address for its own pages (category, tag and page). Choose another.";

export async function createPost(input: { title: string; slug?: string }, me: CmsMe): Promise<PostDetail> {
  const title = cleanLine(input?.title, 200);
  if (!title) throw new CmsRefused("Give the post a title.", { issues: [{ path: "title", message: "Fill this in." }] });
  const wanted = input?.slug ? String(input.slug).trim().toLowerCase() : slugify(title);
  if (input?.slug && (!POST_SLUG.test(wanted) || wanted.length > 120)) throw new CmsRefused("Use lower-case words and hyphens for the address.", { issues: [{ path: "slug", message: "Not a valid address." }] });
  if (input?.slug && isReservedPostSlug(wanted)) throw new CmsRefused(RESERVED_SLUG_MESSAGE, { issues: [{ path: "slug", message: "Reserved." }] });
  const slug = await freePostSlug(wanted);
  const by = actorRef(actorOf(me));
  const row = await controlDb().sitePost.create({ data: { slug, title, body: json([]), authorId: me.id, updatedBy: by }, select: { id: true } });
  await cmsAudit(actorOf(me), "post.create", "post", row.id, { slug, title });
  return getPost(row.id);
}

/** `tags`: what the editor sent (a slug or a name each), cleaned — resolved to records by src/lib/cms/taxonomy.ts. `categories`: ids, or null to leave them. */
type CheckedPost = { title: string; slug: string; excerpt: string | null; coverMediaId: string | null; tags: string[]; categories: string[] | null; body: PostDetail["body"]; seo: PostSeo | null; media: string[] };

function checkPostInput(input: Partial<PostInput> | null | undefined, mode: ValidationMode): CheckedPost {
  const issues: CmsIssue[] = [];
  const title = cleanLine(input?.title, 400);
  if (!title) issues.push({ path: "title", message: "Give the post a title." });
  else if (title.length > 200) issues.push({ path: "title", message: "Keep the title to 200 characters." });
  const slug = String(input?.slug ?? "").trim().toLowerCase();
  if (!POST_SLUG.test(slug) || slug.length > 120) issues.push({ path: "slug", message: "Use lower-case words and hyphens." });
  else if (isReservedPostSlug(slug)) issues.push({ path: "slug", message: RESERVED_SLUG_MESSAGE });
  const excerpt = input?.excerpt ? String(input.excerpt).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim() : "";
  if (excerpt.length > 500) issues.push({ path: "excerpt", message: "Keep the excerpt to 500 characters." });
  const cover = input?.coverMediaId ? String(input.coverMediaId) : null;
  if (cover && !MEDIA_ID.test(cover)) issues.push({ path: "coverMediaId", message: "Choose a cover from the media library." });
  const tags: string[] = [];
  if (input?.tags !== undefined && input?.tags !== null && !Array.isArray(input.tags)) issues.push({ path: "tags", message: "Tags are a list." });
  const rawTags: unknown[] = Array.isArray(input?.tags) ? (input?.tags as unknown[]) : [];
  for (const [i, raw] of rawTags.entries()) {
    const tag = cleanLine(raw, 200);
    if (!tag) continue;
    if (tag.length > 60) issues.push({ path: `tags[${i}]`, message: "Keep a tag to 40 characters." });
    else if (!tags.some((t) => t.toLowerCase() === tag.toLowerCase())) tags.push(tag);
  }
  if (tags.length > MAX_POST_TAGS) issues.push({ path: "tags", message: `At most ${MAX_POST_TAGS} tags.` });
  let categories: string[] | null = null;
  if (input?.categories !== undefined && input?.categories !== null) {
    if (!Array.isArray(input.categories)) issues.push({ path: "categories", message: "Categories are a list." });
    else {
      categories = [...new Set(input.categories.map((c) => String(c ?? "").trim().slice(0, 40)).filter(Boolean))];
      if (categories.length > MAX_POST_CATEGORIES) issues.push({ path: "categories", message: `At most ${MAX_POST_CATEGORIES} categories.` });
    }
  }
  const body = checkPostBody(input?.body, mode, POST_BLOCK_TYPES);
  if (!body.ok) issues.push(...body.issues);
  if (mode === "publish" && body.ok && body.value.length === 0) issues.push({ path: "body", message: "Write something first." });
  const seo = checkPostSeo(input?.seo);
  if (!seo.ok) issues.push(...seo.issues);
  if (issues.length) throw new CmsRefused(mode === "publish" ? "Some fields need attention before this can be published." : "Some fields need attention.", { issues });
  return {
    title,
    slug,
    excerpt: excerpt || null,
    coverMediaId: cover,
    tags,
    categories,
    body: body.ok ? body.value : [],
    seo: seo.ok ? seo.value : null,
    media: [...new Set([...(body.ok ? body.media : []), ...(seo.ok ? seo.media : []), ...(cover ? [cover] : [])])],
  };
}

async function assertPostMedia(post: CheckedPost, publish: boolean) {
  const extra: CmsIssue[] = [];
  if (post.coverMediaId) {
    if ((await missingMediaIds([post.coverMediaId])).length) extra.push({ path: "coverMediaId", message: "This image is no longer in the media library." });
    else if (publish && (await mediaWithoutAlt([post.coverMediaId])).length) extra.push({ path: "coverMediaId", message: "The cover has no alt text yet — add it in the media library." });
  }
  const others = post.media.filter((id) => id !== post.coverMediaId);
  await assertMedia({ body: post.body, seo: post.seo }, others, publish, extra);
}

/**
 * Saves a post. A post has one body: saving one that is live changes the site at once, so it is
 * checked as fully as publishing is. Authors change only their own drafts.
 *
 * Its tags and categories are records (src/lib/cms/taxonomy.ts), written with it in one
 * transaction; a tag it names that does not exist yet is added. A live post's new address leaves a
 * 301 from the old one, made automatically (`redirect` in the answer).
 */
export async function savePost(id: string, input: { post: PostInput; version: string; force?: boolean }, me: CmsMe, now = new Date()): Promise<PostSaved> {
  const row = await postOrRefuse(id);
  if (row.archivedAt) throw new CmsRefused("This post is archived. Restore it before changing it.");
  assertMayChangePost(row, me);
  const live = row.status !== "DRAFT";
  const post = checkPostInput(input?.post, live ? "publish" : "draft");
  if (post.slug !== row.slug && (await controlDb().sitePost.findUnique({ where: { slug: post.slug }, select: { id: true } }))) {
    throw new CmsRefused("Another post has that address.", { issues: [{ path: "slug", message: "Taken." }] });
  }
  const terms = await planPostTerms({ tags: post.tags, categories: post.categories }, me);
  await assertPostMedia(post, live);
  const expected = versionDate(input?.version);
  if (!input?.force && !expected) throw conflictOf("post", row.updatedAt, (await refLabels([row.updatedBy])).get(row.updatedBy) ?? row.updatedBy);
  const by = actorRef(actorOf(me));
  const newTags = await controlDb().$transaction(async (tx) => {
    const written = await tx.sitePost.updateMany({
      where: { id: row.id, ...(input?.force ? {} : { updatedAt: expected! }) },
      data: {
        title: post.title,
        slug: post.slug,
        excerpt: post.excerpt,
        coverMediaId: post.coverMediaId,
        body: json(post.body),
        seo: post.seo ? json(post.seo) : Prisma.DbNull,
        updatedBy: by,
      },
    });
    if (written.count === 0) return null;
    return writePostTerms(tx, row.id, terms, by);
  });
  const after = await controlDb().sitePost.findUniqueOrThrow({ where: { id: row.id } });
  if (!newTags) throw conflictOf("post", after.updatedAt, (await refLabels([after.updatedBy])).get(after.updatedBy) ?? after.updatedBy);
  const redirect = post.slug !== row.slug && postLive(row, now) ? await autoRedirect(`/blog/${row.slug}`, `/blog/${post.slug}`, actorOf(me)) : null;
  if (live) invalidateSiteContent();
  await auditNewTags(newTags, me, row.id);
  await auditSave(me, "post.save", "post", row.id, { slug: post.slug, blocks: post.body.length, live, ...(post.slug !== row.slug ? { from: row.slug } : {}), ...(redirect ? { redirectId: redirect.id } : {}) });
  // A live post's save changes the site at once: its score follows. A draft's waits for the dashboard.
  if (live) await refreshSeoScores({ type: "POST", key: row.id });
  return { ...postSaved(after, now), redirect };
}

function postSaved(row: PostRowModel, now = new Date()): PostSaved {
  return { id: row.id, slug: row.slug, version: row.updatedAt.toISOString(), status: row.status, live: postLive(row, now), publishAt: row.publishAt, updatedAt: row.updatedAt };
}

/** "yyyy-mm-ddThh:mm" (India time, from a datetime-local input) or a full ISO time with its offset. */
function parseWhen(raw: unknown): Date | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return parseIstDateTime(value);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? null : at;
  }
  return null;
}

/**
 * Publishes a post now, or schedules it: a `publishAt` more than a minute ahead makes it SCHEDULED —
 * the site shows it from then on, with no job to run. A time in the past back-dates it.
 */
export async function publishPost(id: string, input: { publishAt?: string | null; version?: string; force?: boolean }, me: CmsMe, now = new Date()): Promise<PostSaved> {
  const row = await postOrRefuse(id);
  if (row.archivedAt) throw new CmsRefused("This post is archived. Restore it before publishing it.");
  // Its tags and categories are records already: only the post's own fields are checked here.
  const post = checkPostInput(
    { title: row.title, slug: row.slug, excerpt: row.excerpt, coverMediaId: row.coverMediaId, tags: [], body: row.body as unknown as PostInput["body"], seo: row.seo as PostSeo | null },
    "publish",
  );
  await assertPostMedia(post, true);
  const requested = input?.publishAt ? parseWhen(input.publishAt) : null;
  if (input?.publishAt && !requested) throw new CmsRefused("Choose a valid date and time.", { issues: [{ path: "publishAt", message: "Not a date and time." }] });
  const scheduled = !!requested && requested.getTime() > now.getTime() + 60_000;
  const publishAt = requested ?? now;
  const expected = versionDate(input?.version);
  const written = await controlDb().sitePost.updateMany({
    where: { id: row.id, archivedAt: null, ...(expected && !input?.force ? { updatedAt: expected } : {}) },
    data: {
      status: scheduled ? "SCHEDULED" : "PUBLISHED",
      publishAt,
      publishedAt: scheduled ? null : now,
      body: json(post.body),
      updatedBy: actorRef(actorOf(me)),
    },
  });
  const after = await controlDb().sitePost.findUniqueOrThrow({ where: { id: row.id } });
  if (written.count === 0) throw conflictOf("post", after.updatedAt, (await refLabels([after.updatedBy])).get(after.updatedBy) ?? after.updatedBy);
  // A redirect from this address would hide the post, now or when its time comes (a deleted post's, say, with the same slug).
  await releasePath(`/blog/${row.slug}`, actorOf(me));
  invalidateSiteContent();
  await cmsAudit(actorOf(me), scheduled ? "post.schedule" : "post.publish", "post", row.id, { slug: row.slug, title: row.title, publishAt: publishAt.toISOString() });
  await refreshSeoScores({ type: "POST", key: row.id });
  return postSaved(after, now);
}

export async function unpublishPost(id: string, me: CmsMe): Promise<PostSaved> {
  const row = await postOrRefuse(id);
  if (row.status === "DRAFT") throw new CmsRefused("This post isn't published.");
  const after = await controlDb().sitePost.update({ where: { id: row.id }, data: { status: "DRAFT", publishAt: null, publishedAt: null, updatedBy: actorRef(actorOf(me)) } });
  invalidateSiteContent();
  await cmsAudit(actorOf(me), "post.unpublish", "post", row.id, { slug: row.slug, title: row.title });
  await refreshSeoScores({ type: "POST", key: row.id });
  return postSaved(after);
}

/** Takes a post off the site and out of the list. Authors: their own drafts only. */
export async function archivePost(id: string, me: CmsMe): Promise<void> {
  const row = await postOrRefuse(id);
  if (me.role === "AUTHOR" || me.role === "VIEWER") assertMayChangePost(row, me);
  if (row.archivedAt) return;
  await controlDb().sitePost.update({ where: { id: row.id }, data: { archivedAt: new Date(), status: "DRAFT", publishAt: null, publishedAt: null, updatedBy: actorRef(actorOf(me)) } });
  if (row.status !== "DRAFT") invalidateSiteContent();
  await cmsAudit(actorOf(me), "post.archive", "post", row.id, { slug: row.slug, title: row.title });
}

export async function unarchivePost(id: string, me: CmsMe): Promise<void> {
  const row = await postOrRefuse(id);
  if (me.role === "AUTHOR" && row.authorId !== me.id) throw new CmsRefused("Authors can change only their own draft posts.");
  if (!row.archivedAt) return;
  await controlDb().sitePost.update({ where: { id: row.id }, data: { archivedAt: null, updatedBy: actorRef(actorOf(me)) } });
  await cmsAudit(actorOf(me), "post.unarchive", "post", row.id, { slug: row.slug });
}

/**
 * Deletes an archived post for good. Authors: their own only.
 *
 * `redirectTo`: send the post's old address (/blog/<slug>) on with a 301 — a path on the site or,
 * for an admin, an https:// address; "" means /blog. Left out or null: no redirect. Only editors and
 * admins may ask for one; it is checked before anything is deleted, and made (or an existing one from
 * that address changed) once the post is gone.
 */
export async function deletePost(id: string, me: CmsMe, options: { redirectTo?: string | null } = {}): Promise<{ redirect: RedirectRow | null }> {
  const row = await postOrRefuse(id);
  if (me.role === "AUTHOR" && row.authorId !== me.id) throw new CmsRefused("Authors can delete only their own posts.");
  if (!row.archivedAt) throw new CmsRefused("Archive the post first — it comes off the site, and can still be brought back until it is deleted.");
  const wantsRedirect = options?.redirectTo !== undefined && options?.redirectTo !== null;
  const redirectInput = wantsRedirect ? { from: `/blog/${row.slug}`, to: String(options.redirectTo).trim() || "/blog", note: `The post “${row.title.slice(0, 200)}” was deleted.` } : null;
  if (redirectInput) {
    if (me.role !== "ADMIN" && me.role !== "EDITOR") throw new CmsRefused("Only editors and admins can add a redirect.");
    const existing = await controlDb().siteRedirect.findUnique({ where: { fromPath: redirectInput.from }, select: { id: true } });
    const check = await checkRedirect({ ...redirectInput, enabled: true }, me, existing?.id ?? null);
    if (!check.ok) throw new CmsRefused(check.issues.length === 1 ? check.issues[0].message : "The redirect needs attention.", { issues: check.issues.map((i) => ({ ...i, path: `redirect.${i.path}` })) });
  }
  await controlDb().sitePost.delete({ where: { id: row.id } });
  await cmsAudit(actorOf(me), "post.delete", "post", row.id, { slug: row.slug, title: row.title });
  if (!redirectInput) return { redirect: null };
  try {
    return { redirect: await saveRedirectFrom(redirectInput, me) };
  } catch (err) {
    if (err instanceof CmsRefused) throw new CmsRefused(`The post is deleted, but its redirect wasn't saved: ${err.message}`, { issues: err.issues });
    throw err;
  }
}

export async function postPreviewLink(id: string, me: CmsMe): Promise<{ url: string; expiresAt: Date }> {
  const row = await postOrRefuse(id);
  const token = mintPreviewToken("post", row.id, row.updatedAt);
  await cmsAudit(actorOf(me), "preview.link", "post", row.id, { slug: row.slug });
  return { url: previewUrl(token), expiresAt: new Date(Date.now() + PREVIEW_TTL_MS) };
}

// ─── Site settings and navigation ────────────────────────────────────────────────────────────────

const SETTINGS_KEY = "site";
const SETTINGS_FIELDS = Object.keys(DEFAULT_SITE_SETTINGS) as (keyof SiteSettings)[];

export async function getSettingsForEdit(): Promise<SettingsDetail> {
  const row = await controlDb().siteSettings.findUnique({ where: { key: SETTINGS_KEY } });
  const draft = mergeSiteSettings(row?.draft);
  const published = row?.published ? mergeSiteSettings(row.published) : null;
  const labels = row ? await refLabels([row.updatedBy]) : new Map<string, string>();
  return {
    draft,
    published,
    saved: !!row,
    changed: stableJson(draft) !== stableJson(published ?? DEFAULT_SITE_SETTINGS),
    version: row ? row.updatedAt.toISOString() : "",
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row ? (labels.get(row.updatedBy) ?? row.updatedBy) : null,
    publishedAt: row?.publishedAt ?? null,
  };
}

/** A partial change laid over the current draft: only the site's own fields, the rest ignored. */
async function mergedSettings(partial: unknown): Promise<SiteSettings> {
  const row = await controlDb().siteSettings.findUnique({ where: { key: SETTINGS_KEY }, select: { draft: true } });
  const base = mergeSiteSettings(row?.draft);
  if (typeof partial !== "object" || partial === null) return base;
  const picked = Object.fromEntries(SETTINGS_FIELDS.filter((k) => k in partial).map((k) => [k, (partial as Record<string, unknown>)[k]]));
  return { ...base, ...picked } as SiteSettings;
}

function checkedSettings(settings: unknown, mode: ValidationMode) {
  const checked = checkSiteSettings(settings, mode);
  if (!checked.ok) throw new CmsRefused(mode === "publish" ? "Some settings need attention before they can be published." : "Some settings need attention.", { issues: checked.issues });
  return checked;
}

async function writeSettings(data: { draft: SiteSettings; published?: SiteSettings }, version: unknown, force: boolean, me: CmsMe): Promise<void> {
  const by = actorRef(actorOf(me));
  const now = new Date();
  const fields = { draft: json(data.draft), ...(data.published ? { published: json(data.published), publishedAt: now } : {}), updatedBy: by };
  const row = await controlDb().siteSettings.findUnique({ where: { key: SETTINGS_KEY }, select: { updatedAt: true, updatedBy: true } });
  const conflict = async () => {
    const r = await controlDb().siteSettings.findUniqueOrThrow({ where: { key: SETTINGS_KEY }, select: { updatedAt: true, updatedBy: true } });
    return conflictOf("settings", r.updatedAt, (await refLabels([r.updatedBy])).get(r.updatedBy) ?? r.updatedBy);
  };
  if (!row) {
    try {
      await controlDb().siteSettings.create({ data: { key: SETTINGS_KEY, ...fields } });
      return;
    } catch (err) {
      if (await controlDb().siteSettings.findUnique({ where: { key: SETTINGS_KEY }, select: { key: true } })) throw await conflict();
      throw err;
    }
  }
  const expected = versionDate(version);
  if (!force && !expected) throw await conflict();
  const written = await controlDb().siteSettings.updateMany({ where: { key: SETTINGS_KEY, ...(force ? {} : { updatedAt: expected! }) }, data: fields });
  if (written.count === 0) throw await conflict();
}

/** Saves the settings' draft: `settings` holds only the fields being changed (identity, navigation…). */
export async function saveSettingsDraft(input: { settings: Partial<SiteSettings>; version: string; force?: boolean }, me: CmsMe): Promise<SettingsDetail> {
  const merged = await mergedSettings(input?.settings);
  const checked = checkedSettings(merged, "draft");
  await assertMedia(checked.value, checked.media, false);
  await writeSettings({ draft: checked.value }, input?.version, !!input?.force, me);
  await auditSave(me, "settings.save", "settings", SETTINGS_KEY, { fields: Object.keys(input?.settings ?? {}).filter((k) => (SETTINGS_FIELDS as string[]).includes(k)) });
  return getSettingsForEdit();
}

/** Publishes the settings' draft (with `settings` laid over it first, when given). */
export async function publishSettings(input: { settings?: Partial<SiteSettings>; version?: string; force?: boolean }, me: CmsMe): Promise<SettingsDetail> {
  const merged = await mergedSettings(input?.settings);
  const checked = checkedSettings(merged, "publish");
  await assertMedia(checked.value, checked.media, true);
  const checkVersion = input?.settings !== undefined || !!input?.version;
  await writeSettings({ draft: checked.value, published: checked.value }, input?.version, !!input?.force || !checkVersion, me);
  invalidateSiteContent();
  await cmsAudit(actorOf(me), "settings.publish", "settings", SETTINGS_KEY, {});
  return getSettingsForEdit();
}

// ─── Dashboard ───────────────────────────────────────────────────────────────────────────────────

export async function cmsDashboard(me: CmsMe, now = new Date()): Promise<CmsDashboard> {
  const control = controlDb();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
  const [pages, changed, postsLive, postsScheduled, postsDrafts, leadsNew, leadsWeek, mediaTotal, mediaNoAlt, myPages, myPosts, recent, settings] = await Promise.all([
    control.sitePage.findMany({ where: { archivedAt: null }, select: { slug: true, status: true } }),
    control.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM site_pages WHERE status = 'PUBLISHED' AND "archivedAt" IS NULL AND draft IS DISTINCT FROM published`,
    control.sitePost.count({ where: { status: { in: ["PUBLISHED", "SCHEDULED"] }, archivedAt: null, publishAt: { lte: now } } }),
    control.sitePost.count({ where: { status: "SCHEDULED", archivedAt: null, publishAt: { gt: now } } }),
    control.sitePost.count({ where: { status: "DRAFT", archivedAt: null } }),
    control.siteLead.count({ where: { status: "NEW" } }),
    control.siteLead.count({ where: { status: "NEW", createdAt: { gte: weekAgo } } }),
    control.siteMedia.count(),
    control.siteMedia.count({ where: { alt: "" } }),
    control.sitePage.findMany({ where: { updatedBy: `cms:${me.id}`, archivedAt: null }, orderBy: { updatedAt: "desc" }, take: 8, select: { id: true, title: true, status: true, updatedAt: true, draft: true, published: true } }),
    control.sitePost.findMany({ where: { authorId: me.id, status: "DRAFT", archivedAt: null }, orderBy: { updatedAt: "desc" }, take: 8, select: { id: true, title: true, updatedAt: true } }),
    listCmsAudit({ page: 1 }),
    control.siteSettings.findUnique({ where: { key: SETTINGS_KEY }, select: { published: true } }),
  ]);
  const published = new Set(pages.filter((p) => p.status === "PUBLISHED").map((p) => p.slug));
  const myDrafts = [
    ...myPages
      .filter((p) => p.status === "DRAFT" || stableJson(p.draft) !== stableJson(p.published))
      .map((p) => ({ kind: "page" as const, id: p.id, title: p.title, href: `/pages/${p.id}`, updatedAt: p.updatedAt })),
    ...myPosts.map((p) => ({ kind: "post" as const, id: p.id, title: p.title, href: `/posts/${p.id}`, updatedAt: p.updatedAt })),
  ]
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, 8);
  const liveSettings = settings?.published ? mergeSiteSettings(settings.published) : DEFAULT_SITE_SETTINGS;
  return {
    pages: {
      published: published.size,
      drafts: pages.filter((p) => p.status === "DRAFT").length,
      changed: Number(changed[0]?.n ?? 0),
      builtinsDefault: BUILTIN_PAGE_SLUGS.filter((s) => !published.has(s)).length,
    },
    posts: { published: postsLive, scheduled: postsScheduled, drafts: postsDrafts },
    leads: { newTotal: leadsNew, newThisWeek: leadsWeek },
    media: { total: mediaTotal, needsAlt: mediaNoAlt },
    myDrafts,
    recent: recent.rows.slice(0, 10),
    setup: { taglinePlaceholder: liveSettings.tagline === DEFAULT_SITE_SETTINGS.tagline, homePublished: published.has("home"), settingsPublished: !!settings?.published },
  };
}

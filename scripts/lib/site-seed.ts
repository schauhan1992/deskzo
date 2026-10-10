import type { SitePost } from "@deskzo/control-client";
import type { NavItem, SiteSettings } from "../../src/components/site/blocks/types";
import { DEFAULT_SITE_SETTINGS } from "../../src/components/site/defaults";
import { refLabels } from "../../src/lib/cms/audit";
import { createPage, createPost, getSettingsForEdit, publishPage, publishPost, publishSettings, savePageDraft, savePost, saveSettingsDraft } from "../../src/lib/cms/content";
import { listScores, recalculateBatch, scoreDetail } from "../../src/lib/cms/seo-scores";
import { createCategory, updateCategory } from "../../src/lib/cms/taxonomy";
import { CmsRefused, POST_BLOCK_TYPES, type CmsIssue, type CmsMe, type PageDocument, type PostInput, type SeoScoreRow, type TermSeo } from "../../src/lib/cms/types";
import { checkPageDocument, checkPostBody, checkPostSeo, checkSiteSettings, pageSlugProblem, stableJson } from "../../src/lib/cms/validate";
import { controlDb } from "../../src/lib/platform/control-db";
import { mergeSiteSettings } from "../../src/lib/platform/site-content";
import type { SeedCategory, SeedPage, SeedPost, SeedSection } from "../site-content/types";

/**
 * The website seed: publishes the site's pages, guides, navigation and footer through the CMS's own
 * functions (src/lib/cms/content.ts and taxonomy.ts) — so validation, versions, the activity log, the
 * content cache and the SEO scores all happen exactly as they would for a person.
 *
 *   · It acts as "script" (CmsMe.script): everything it writes has `updatedBy` "script". A post it
 *     makes is by the CMS's first admin (`author`), since a post needs a CMS account as its author.
 *   · Idempotent, and it never overwrites a person's work:
 *       – a page, post or category that isn't there is created (a page: created, its draft saved,
 *         then published; a post: created, saved, then published);
 *       – one there that the seed wrote last is updated — or left as it is when it already matches;
 *       – one a person has changed since (its `updatedBy` is theirs), archived, moved or deleted is
 *         left alone and reported;
 *       – the settings' navigation and footer are saved as a draft and then published only while the
 *         settings are the seed's own or still the defaults. Otherwise the proposed navigation is in
 *         the result, and the settings are untouched.
 *   · `dryRun` reads, checks every document with the CMS's validator and says what it would do; it
 *     writes nothing.
 *   · Afterwards every SEO score is recalculated (the store's batch, `all: true`) and the seeded
 *     entities' scores are returned with their top issues.
 */

/** What the seed's writes are recorded as (`updatedBy`, the activity log). */
export const SEED_ACTOR = "script";
const NOTE = "Published by the website seed (npm run site:seed-pages).";

export type SeedNav = { nav: NavItem[]; footer: SiteSettings["footer"] };
export type SeedOutcome = "created" | "updated" | "unchanged" | "skipped" | "failed";
export type SeedKind = "page" | "post" | "category" | "settings";
export type SeedResult = { kind: SeedKind; key: string; title: string; outcome: SeedOutcome; reason?: string; issues?: CmsIssue[] };
export type SeedScore = {
  kind: "page" | "post";
  key: string;
  path: string;
  title: string;
  keywords: string[];
  overall: number;
  seo: number;
  aeo: number;
  geo: number;
  label: string;
  issues: { status: string; label: string; message: string; lost: number }[];
};
export type SeedReport = {
  dryRun: boolean;
  author: { id: string; name: string; email: string } | null;
  results: SeedResult[];
  /** The navigation and footer the seed would publish — set when the settings were left alone (or in a dry run). */
  proposedNav: SeedNav | null;
  scores: SeedScore[];
};

export type SeedOptions = {
  sections: SeedSection[];
  /** The navigation and footer to publish; null leaves the settings alone. */
  nav: SeedNav | null;
  /**
   * Page addresses to publish even though a person moved or deleted them in the CMS — when somebody
   * asks for the seed's page back. A page a person edited or archived is still left alone.
   */
  restore?: readonly string[];
  dryRun?: boolean;
  /** Recalculate every SEO score afterwards and report the seeded entities' (default: when not a dry run). */
  scores?: boolean;
  log?: (line: string) => void;
};

const when = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");

/** Why a CMS refusal happened, in one line: its message and each issue's path. */
function refusalLine(err: unknown): { reason: string; issues?: CmsIssue[] } {
  if (err instanceof CmsRefused) return { reason: err.message, issues: err.issues };
  return { reason: err instanceof Error ? err.message : String(err) };
}

/** The CMS's first admin, the author of the seed's posts. */
async function firstAdmin() {
  return controlDb().cmsUser.findFirst({ where: { role: "ADMIN", active: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, name: true, email: true } });
}

/** A person changed this address in the CMS: moved the page or post away, or deleted it. */
async function movedOrDeleted(entity: "page" | "post", slug: string): Promise<string | null> {
  const moved = await controlDb().cmsAuditLog.findFirst({
    where: { entity, action: entity === "page" ? "page.slug" : "post.save", actorLabel: { not: SEED_ACTOR }, detail: { path: ["from"], equals: slug } },
    orderBy: { at: "desc" },
    select: { at: true, actorLabel: true, detail: true },
  });
  if (moved) return `moved to ${entity === "page" ? "/" : "/blog/"}${String((moved.detail as { to?: string; slug?: string } | null)?.[entity === "page" ? "to" : "slug"] ?? "another address")} by ${moved.actorLabel} on ${when(moved.at)}`;
  const deleted = await controlDb().cmsAuditLog.findFirst({
    where: { entity, action: `${entity}.delete`, actorLabel: { not: SEED_ACTOR }, detail: { path: ["slug"], equals: slug } },
    orderBy: { at: "desc" },
    select: { at: true, actorLabel: true },
  });
  return deleted ? `deleted by ${deleted.actorLabel} on ${when(deleted.at)}` : null;
}

async function personEdit(updatedBy: string, updatedAt: Date): Promise<string> {
  const label = (await refLabels([updatedBy])).get(updatedBy) ?? updatedBy;
  return `changed in the CMS by ${label} on ${when(updatedAt)}`;
}

// ─── Pages ───────────────────────────────────────────────────────────────────────────────────────

async function seedPage(page: SeedPage, me: CmsMe, dryRun: boolean, restore: ReadonlySet<string>): Promise<SeedResult> {
  const base = { kind: "page" as const, key: page.slug, title: page.document.title };
  const slugProblem = pageSlugProblem(page.slug);
  if (slugProblem) return { ...base, outcome: "failed", reason: slugProblem };
  const checked = checkPageDocument(page.document, "publish");
  if (!checked.ok) return { ...base, outcome: "failed", reason: "The CMS's validator refuses it.", issues: checked.issues };
  const doc: PageDocument = checked.value;
  const row = await controlDb().sitePage.findUnique({ where: { slug: page.slug } });
  if (!row) {
    const gone = await movedOrDeleted("page", page.slug);
    if (gone && !restore.has(page.slug)) return { ...base, outcome: "skipped", reason: gone };
    if (dryRun) return { ...base, outcome: "created", reason: gone ? `would bring back and publish (${gone})` : "would create and publish" };
    const made = await createPage({ slug: page.slug, title: doc.title }, me);
    const saved = await savePageDraft(made.id, { document: doc, version: made.version }, me);
    await publishPage(made.id, { version: saved.version, note: NOTE }, me);
    return { ...base, outcome: "created" };
  }
  if (row.archivedAt) return { ...base, outcome: "skipped", reason: `archived in the CMS on ${when(row.archivedAt)}` };
  if (row.updatedBy !== SEED_ACTOR) return { ...base, outcome: "skipped", reason: await personEdit(row.updatedBy, row.updatedAt) };
  const same = stableJson(doc);
  if (row.status === "PUBLISHED" && stableJson(row.draft) === same && stableJson(row.published) === same) return { ...base, outcome: "unchanged" };
  if (dryRun) return { ...base, outcome: "updated", reason: "would save and publish the new version" };
  const saved = await savePageDraft(row.id, { document: doc, version: row.updatedAt.toISOString() }, me);
  await publishPage(row.id, { version: saved.version, note: NOTE }, me);
  return { ...base, outcome: "updated" };
}

// ─── Categories ──────────────────────────────────────────────────────────────────────────────────

const termSeo = (seo: TermSeo | null | undefined) => stableJson(seo && Object.keys(seo).length ? seo : null);

async function seedCategory(category: SeedCategory, me: CmsMe, dryRun: boolean): Promise<{ result: SeedResult; id: string | null }> {
  const base = { kind: "category" as const, key: category.slug, title: category.name };
  const row = await controlDb().siteCategory.findUnique({ where: { slug: category.slug } });
  if (!row) {
    if (dryRun) return { result: { ...base, outcome: "created", reason: "would create" }, id: null };
    const made = await createCategory({ name: category.name, slug: category.slug, description: category.description ?? null, parentId: null, seo: category.seo ?? null }, me);
    return { result: { ...base, outcome: "created" }, id: made.id };
  }
  // A person's category is theirs: the posts still file under it, but its words are left alone.
  if (row.updatedBy !== SEED_ACTOR) return { result: { ...base, outcome: "skipped", reason: await personEdit(row.updatedBy, row.updatedAt) }, id: row.id };
  const same = row.name === category.name && (row.description ?? null) === (category.description ?? null) && termSeo(row.seo as TermSeo | null) === termSeo(category.seo);
  if (same) return { result: { ...base, outcome: "unchanged" }, id: row.id };
  if (dryRun) return { result: { ...base, outcome: "updated", reason: "would update" }, id: row.id };
  await updateCategory(row.id, { name: category.name, description: category.description ?? null, seo: category.seo ?? null }, me);
  return { result: { ...base, outcome: "updated" }, id: row.id };
}

// ─── Posts ───────────────────────────────────────────────────────────────────────────────────────

type PostRow = SitePost & { categories: { categoryId: string; position: number }[]; tagLinks: { tag: { slug: string; name: string } }[] };

function postMatches(row: PostRow, input: PostInput): boolean {
  const live = row.status !== "DRAFT" && !row.archivedAt && !!row.publishAt && row.publishAt <= new Date();
  const categories = [...row.categories].sort((a, b) => a.position - b.position).map((c) => c.categoryId);
  const tags = row.tagLinks.map((l) => l.tag.slug).sort();
  const wantedTags = input.tags.map((t) => t.toLowerCase()).sort();
  return (
    live &&
    row.title === input.title &&
    (row.excerpt ?? null) === input.excerpt &&
    row.coverMediaId === input.coverMediaId &&
    stableJson(row.body) === stableJson(input.body) &&
    stableJson(row.seo ?? null) === stableJson(input.seo) &&
    stableJson(categories) === stableJson(input.categories ?? []) &&
    stableJson(tags) === stableJson(wantedTags)
  );
}

async function seedPost(post: SeedPost, categoryIds: Map<string, string | null>, me: CmsMe | null, dryRun: boolean): Promise<SeedResult> {
  const base = { kind: "post" as const, key: post.slug, title: post.title };
  const body = checkPostBody(post.body, "publish", POST_BLOCK_TYPES);
  const seo = checkPostSeo(post.seo);
  if (!body.ok || !seo.ok) return { ...base, outcome: "failed", reason: "The CMS's validator refuses it.", issues: [...(body.ok ? [] : body.issues), ...(seo.ok ? [] : seo.issues)] };
  const unknown = post.categories.filter((slug) => !categoryIds.has(slug));
  if (unknown.length) return { ...base, outcome: "failed", reason: `No category ${unknown.join(", ")}: add it to the section's categories.` };
  const row = (await controlDb().sitePost.findUnique({
    where: { slug: post.slug },
    include: { categories: { select: { categoryId: true, position: true } }, tagLinks: { select: { tag: { select: { slug: true, name: true } } } } },
  })) as PostRow | null;
  const ids = post.categories.map((slug) => categoryIds.get(slug) ?? `new:${slug}`);
  const input: PostInput = { title: post.title, slug: post.slug, excerpt: post.excerpt || null, coverMediaId: null, tags: post.tags ?? [], categories: ids, body: body.value, seo: seo.value };
  if (!row) {
    const gone = await movedOrDeleted("post", post.slug);
    if (gone) return { ...base, outcome: "skipped", reason: gone };
    if (!me) return { ...base, outcome: "failed", reason: "There is no active CMS admin to be its author. Add one: npm run cms:user -- create --email … --name … --role ADMIN" };
    if (dryRun) return { ...base, outcome: "created", reason: "would create and publish" };
    const made = await createPost({ title: post.title, slug: post.slug }, me);
    if (made.slug !== post.slug) throw new Error(`The post was made at /blog/${made.slug}, not /blog/${post.slug}.`);
    const saved = await savePost(made.id, { post: input, version: made.version }, me);
    await publishPost(made.id, { version: saved.version }, me);
    return { ...base, outcome: "created" };
  }
  if (row.archivedAt) return { ...base, outcome: "skipped", reason: `archived in the CMS on ${when(row.archivedAt)}` };
  if (row.updatedBy !== SEED_ACTOR) return { ...base, outcome: "skipped", reason: await personEdit(row.updatedBy, row.updatedAt) };
  if (postMatches(row, input)) return { ...base, outcome: "unchanged" };
  if (!me) return { ...base, outcome: "failed", reason: "There is no active CMS admin to act as." };
  if (dryRun) return { ...base, outcome: "updated", reason: "would save and publish the new version" };
  const saved = await savePost(row.id, { post: input, version: row.updatedAt.toISOString() }, me);
  if (!saved.live) await publishPost(row.id, { version: saved.version }, me);
  return { ...base, outcome: "updated" };
}

// ─── Settings ────────────────────────────────────────────────────────────────────────────────────

async function seedSettings(nav: SeedNav, me: CmsMe, dryRun: boolean): Promise<SeedResult> {
  const base = { kind: "settings" as const, key: "nav", title: "Navigation and footer" };
  const row = await controlDb().siteSettings.findUnique({ where: { key: "site" } });
  const defaults = stableJson(DEFAULT_SITE_SETTINGS);
  const stillDefault = !row || (stableJson(mergeSiteSettings(row.draft)) === defaults && (!row.published || stableJson(mergeSiteSettings(row.published)) === defaults));
  if (row && !stillDefault && row.updatedBy !== SEED_ACTOR) return { ...base, outcome: "skipped", reason: `${await personEdit(row.updatedBy, row.updatedAt)} — the proposed navigation is in the report` };
  const detail = await getSettingsForEdit();
  const checked = checkSiteSettings({ ...detail.draft, nav: nav.nav, footer: nav.footer }, "publish");
  if (!checked.ok) return { ...base, outcome: "failed", reason: "The CMS's validator refuses it.", issues: checked.issues };
  const wanted = { nav: checked.value.nav, footer: checked.value.footer };
  const matches = (s: SiteSettings | null) => !!s && stableJson({ nav: s.nav, footer: s.footer }) === stableJson(wanted);
  if (matches(detail.published) && matches(detail.draft)) return { ...base, outcome: "unchanged" };
  if (dryRun) return { ...base, outcome: row ? "updated" : "created", reason: "would save the draft and publish it" };
  const saved = await saveSettingsDraft({ settings: wanted, version: detail.version }, me);
  await publishSettings({ version: saved.version }, me);
  return { ...base, outcome: row ? "updated" : "created" };
}

// ─── Scores ──────────────────────────────────────────────────────────────────────────────────────

async function recalculateAll(log: (line: string) => void): Promise<void> {
  let cursor: string | null = null;
  let processed = 0;
  let failed = 0;
  for (let round = 0; round < 1000; round++) {
    const batch = await recalculateBatch({ cursor, all: true, size: 50 });
    processed += batch.processed;
    failed += batch.failed;
    cursor = batch.cursor;
    if (batch.done) break;
  }
  log(`SEO scores recalculated: ${processed}${failed ? `, ${failed} failed` : ""}.`);
}

async function scoresFor(sections: SeedSection[]): Promise<SeedScore[]> {
  const rows: SeoScoreRow[] = [];
  for (let page = 1; page <= 100; page++) {
    const list = await listScores({ page, pageSize: 100, sort: "lowest" });
    rows.push(...list.rows);
    if (page * list.pageSize >= list.total) break;
  }
  const pageSlugs = new Set(sections.flatMap((s) => s.pages ?? []).map((p) => p.slug));
  const postSlugs = new Set(sections.flatMap((s) => s.posts ?? []).map((p) => `/blog/${p.slug}`));
  const mine = rows.filter((r) => (r.type === "PAGE" && pageSlugs.has(r.key)) || (r.type === "POST" && postSlugs.has(r.path)));
  const out: SeedScore[] = [];
  for (const r of mine) {
    const detail = await scoreDetail(r.type, r.key, { store: false });
    const checks = [...detail.score.seo.checks, ...detail.score.aeo.checks, ...detail.score.geo.checks].filter((c) => c.status === "FAIL" || c.status === "WARNING");
    const issues = checks
      .map((c) => ({ status: c.status, label: `${c.category.toUpperCase()} · ${c.label}`, message: c.message, lost: c.pointsAvailable - c.pointsEarned }))
      .sort((a, b) => b.lost - a.lost);
    out.push({
      kind: r.type === "PAGE" ? "page" : "post",
      key: r.type === "PAGE" ? r.key : r.path.replace(/^\/blog\//, ""),
      path: r.path,
      title: r.title,
      keywords: r.keywords,
      overall: r.overall,
      seo: r.seo,
      aeo: r.aeo,
      geo: r.geo,
      label: r.label,
      issues,
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// ─── The run ─────────────────────────────────────────────────────────────────────────────────────

export async function runSiteSeed(options: SeedOptions): Promise<SeedReport> {
  const log = options.log ?? (() => {});
  const dryRun = !!options.dryRun;
  const restore = new Set((options.restore ?? []).map((s) => s.replace(/^\/+|\/+$/g, "")));
  const admin = await firstAdmin();
  /** The seed acts as a script; its posts are by the first admin. With no admin it still publishes pages as "script". */
  const me: CmsMe = admin ? { id: admin.id, email: admin.email, name: admin.name, role: "ADMIN", script: true } : { id: SEED_ACTOR, email: "", name: "Script", role: "ADMIN", script: true };
  const author = admin ? me : null;
  const results: SeedResult[] = [];
  const record = (r: SeedResult) => {
    results.push(r);
    log(`${r.outcome.padEnd(9)} ${r.kind.padEnd(8)} ${r.kind === "post" ? `/blog/${r.key}` : r.kind === "page" ? `/${r.key}` : r.key}${r.reason ? ` — ${r.reason}` : ""}`);
    for (const i of r.issues ?? []) log(`            ${i.path}: ${i.message}`);
  };
  const guarded = async (base: Omit<SeedResult, "outcome">, work: () => Promise<SeedResult>) => {
    try {
      record(await work());
    } catch (err) {
      record({ ...base, outcome: "failed", ...refusalLine(err) });
    }
  };

  // Every address once: two sections claiming one page is a mistake in the data, not a race.
  const seen = new Map<string, string>();
  for (const section of options.sections) {
    for (const key of [...(section.pages ?? []).map((p) => `page:${p.slug}`), ...(section.posts ?? []).map((p) => `post:${p.slug}`)]) {
      if (seen.has(key)) throw new Error(`${key} is in both ${seen.get(key)} and ${section.name}.`);
      seen.set(key, section.name);
    }
  }

  for (const section of options.sections) {
    log(`\n${section.name}`);
    for (const page of section.pages ?? []) await guarded({ kind: "page", key: page.slug, title: page.document.title }, () => seedPage(page, me, dryRun, restore));
  }

  const categoryIds = new Map<string, string | null>();
  for (const c of await controlDb().siteCategory.findMany({ select: { id: true, slug: true } })) categoryIds.set(c.slug, c.id);
  for (const section of options.sections) {
    if (!section.categories?.length && !section.posts?.length) continue;
    log(`\n${section.name}: posts`);
    for (const category of section.categories ?? []) {
      try {
        const { result, id } = await seedCategory(category, me, dryRun);
        record(result);
        categoryIds.set(category.slug, id);
      } catch (err) {
        record({ kind: "category", key: category.slug, title: category.name, outcome: "failed", ...refusalLine(err) });
      }
    }
    for (const post of section.posts ?? []) await guarded({ kind: "post", key: post.slug, title: post.title }, () => seedPost(post, categoryIds, author, dryRun));
  }

  let proposedNav: SeedNav | null = null;
  if (options.nav) {
    log("\nNavigation and footer");
    const nav = options.nav;
    let result: SeedResult;
    try {
      result = await seedSettings(nav, me, dryRun);
    } catch (err) {
      result = { kind: "settings", key: "nav", title: "Navigation and footer", outcome: "failed", ...refusalLine(err) };
    }
    record(result);
    if (dryRun || result.outcome === "skipped" || result.outcome === "failed") proposedNav = nav;
  }

  let scores: SeedScore[] = [];
  if (options.scores ?? !dryRun) {
    log("");
    await recalculateAll(log);
    scores = await scoresFor(options.sections);
  }
  return { dryRun, author: admin, results, proposedNav, scores };
}

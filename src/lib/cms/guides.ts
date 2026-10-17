import type { HelpGuideProps } from "@/components/site/blocks/types";
import { refLabels } from "@/lib/cms/audit";
import { createPage, getPage, savePageDraft } from "@/lib/cms/content";
import { CmsRefused, GUIDE_PAGE_SEGMENT, type CmsMe, type PageDetail, type PageDocument, type PageStatus } from "@/lib/cms/types";
import { slugify, stableJson } from "@/lib/cms/validate";
import { GUIDE_SECTIONS, guideModuleOf } from "@/lib/help/guides";
import { MODULE_REGISTRY, getModuleDefinition, navGroupRank } from "@/lib/modules";
import { controlDb } from "@/lib/platform/control-db";
import { sitePath } from "@/lib/platform/site-content";

/**
 * The Help Center from the CMS's side (src/lib/help/guides.ts): which module has a guide page, in what
 * state — the review queue for the drafts the seed saved (scripts/help-guides-seed.ts) — and starting
 * a guide for a module that has none. A guide is an ordinary CMS page under help/, so editing,
 * previewing, publishing and its history are the Pages editor's.
 */

export type GuidePageRef = {
  id: string;
  slug: string;
  path: string;
  title: string;
  status: PageStatus;
  /** Published, with a draft that differs. */
  changed: boolean;
  updatedAt: Date;
  updatedBy: string;
};

export type GuideListRow = {
  module: string;
  label: string;
  navGroup: string;
  /** The module's guide: the published one when there is one, else the most recently changed draft. */
  page: GuidePageRef | null;
  /** Any other unarchived pages under help/ for the same module (a second draft, say). */
  others: GuidePageRef[];
};

/** Every module in the registry, in the menu's order, with its guide page (or none). */
export async function listGuidePages(): Promise<GuideListRow[]> {
  const rows = await controlDb().sitePage.findMany({
    where: { slug: { startsWith: `${GUIDE_PAGE_SEGMENT}/` }, archivedAt: null },
    orderBy: { updatedAt: "desc" },
    select: { id: true, slug: true, title: true, status: true, draft: true, published: true, updatedAt: true, updatedBy: true },
  });
  const labels = await refLabels(rows.map((r) => r.updatedBy));
  const byModule = new Map<string, GuidePageRef[]>();
  for (const r of rows) {
    const moduleKey = guideModuleOf((r.published as { blocks?: unknown } | null)?.blocks) ?? guideModuleOf((r.draft as { blocks?: unknown } | null)?.blocks);
    if (!moduleKey) continue;
    const ref: GuidePageRef = {
      id: r.id,
      slug: r.slug,
      path: sitePath(r.slug),
      title: r.title,
      status: r.status,
      changed: r.status === "PUBLISHED" && stableJson(r.draft) !== stableJson(r.published),
      updatedAt: r.updatedAt,
      updatedBy: labels.get(r.updatedBy) ?? r.updatedBy,
    };
    byModule.set(moduleKey, [...(byModule.get(moduleKey) ?? []), ref]);
  }
  return [...MODULE_REGISTRY]
    .sort((a, b) => navGroupRank(a.navGroup) - navGroupRank(b.navGroup))
    .map((m) => {
      const pages = byModule.get(m.key) ?? [];
      const page = pages.find((p) => p.status === "PUBLISHED") ?? pages[0] ?? null;
      return { module: m.key, label: m.label, navGroup: m.navGroup, page, others: pages.filter((p) => p !== page) };
    });
}

/** "Companies & Contacts" → "companies-and-contacts". */
export function guideSlugFor(label: string): string {
  return `${GUIDE_PAGE_SEGMENT}/${slugify(label.replace(/&/g, " and "), 60) || "guide"}`;
}

/** A new guide's outline, every section waiting for its words. */
function skeleton(moduleKey: string, label: string): PageDocument {
  const props: HelpGuideProps = {
    module: moduleKey,
    heading: label,
    summary: "",
    purpose: [{ type: "paragraph", text: "" }],
    access: [{ type: "paragraph", text: "" }],
    permissions: [],
    setup: [{ type: "paragraph", text: "" }],
    tasks: [{ title: "", body: [{ type: "list", ordered: true, items: [""] }] }],
    settings: [],
    faq: [{ question: "", answer: [{ type: "paragraph", text: "" }] }],
    related: [],
  };
  return { title: label, seo: { title: label, description: "" }, blocks: [{ id: "guide", type: "helpGuide", props }] };
}

/**
 * A draft guide for a module that has none: a page at help/<its name>, holding the outline. Refused
 * when the module already has a guide page (open that one instead).
 */
export async function startGuide(moduleKey: string, me: CmsMe): Promise<PageDetail> {
  const def = getModuleDefinition(String(moduleKey ?? "").slice(0, 60));
  if (!def) throw new CmsRefused("There's no such module.");
  const existing = (await listGuidePages()).find((r) => r.module === def.key)?.page;
  if (existing) throw new CmsRefused(`${def.label} already has a guide, at ${existing.path}. Open it from the list.`);
  const base = guideSlugFor(def.label);
  for (let n = 1; n <= 20; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    const taken = await controlDb().sitePage.findUnique({ where: { slug }, select: { id: true } });
    if (taken) continue;
    const made = await createPage({ slug, title: def.label }, me);
    await savePageDraft(made.id, { document: skeleton(def.key, def.label), version: made.version }, me);
    return getPage(made.id);
  }
  throw new CmsRefused("Every address for this guide is taken. Make the page from Pages instead.");
}

/** The outline's headings, for the list's explanation. */
export const GUIDE_OUTLINE = GUIDE_SECTIONS.map((s) => s.heading);

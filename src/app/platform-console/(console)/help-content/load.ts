import type { Prisma } from "@deskzo/control-client";
import type { HelpEditorChoices, HelpEditorItem, HelpListItem, HelpTab } from "@/components/console/help-content/shared";
import { parseEntitlements, type Entitlements } from "@/lib/entitlements";
import { controlDb } from "@/lib/platform/control-db";
import { PLATFORM_HELP_LIMITS, PLATFORM_LINK_DOMAIN, PLATFORM_LINK_HOSTS, publicationState, reachesWorkspace } from "@/lib/platform/help-content";

/**
 * The console's reads of Deskzo's help and What's new: one tab's list, one item, and the editor's
 * choices. Server only — the pages under this folder call it after their own staff gate.
 *
 * Reach is worked out the way a workspace decides for itself (`reachesWorkspace`), from the plans
 * already on each open workspace's row: one read of them per page, and each distinct choice of
 * modules and countries counted once.
 */

/** The most rows one tab lists; there are never this many, and the footer says so if there are. */
const LIST_MAX = 500;
/** Open workspaces counted for reach. */
const TENANTS_MAX = 20_000;

const LINK_SELECT = {
  id: true,
  kind: true,
  title: true,
  url: true,
  description: true,
  sortOrder: true,
  modules: true,
  countries: true,
  publishedAt: true,
  archivedAt: true,
  updatedById: true,
  updatedAt: true,
} as const satisfies Prisma.PlatformHelpLinkSelect;

const POST_SELECT = {
  id: true,
  title: true,
  body: true,
  linkUrl: true,
  pinned: true,
  modules: true,
  countries: true,
  publishedAt: true,
  archivedAt: true,
  updatedById: true,
  updatedAt: true,
} as const satisfies Prisma.PlatformUpdateSelect;

type LinkRecord = Prisma.PlatformHelpLinkGetPayload<{ select: typeof LINK_SELECT }>;
type PostRecord = Prisma.PlatformUpdateGetPayload<{ select: typeof POST_SELECT }>;

type OpenWorkspace = { country: string; entitlements: Entitlements };

async function openWorkspaces(): Promise<OpenWorkspace[]> {
  const rows = await controlDb().tenant.findMany({ where: { status: "ACTIVE" }, take: TENANTS_MAX, select: { country: true, entitlements: true } });
  return rows.map((t) => ({ country: t.country, entitlements: parseEntitlements(t.entitlements) }));
}

/** Each row's reach, counting each distinct choice of modules and countries once. */
function reachOf(rows: { modules: string[]; countries: string[] }[], tenants: OpenWorkspace[]): number[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const key = `${[...row.modules].sort().join(",")}|${[...row.countries].sort().join(",")}`;
    let n = seen.get(key);
    if (n === undefined) {
      n = tenants.filter((t) => reachesWorkspace(row, t)).length;
      seen.set(key, n);
    }
    return n;
  });
}

/** Staff names for "Updated by" — switched-off members included, since old items name them. */
async function staffNames(ids: string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter(Boolean))];
  if (wanted.length === 0) return new Map();
  const rows = await controlDb().platformUser.findMany({ where: { id: { in: wanted } }, select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r.name]));
}

function linkItem(r: LinkRecord, now: Date, names: Map<string, string>, reach: number | null): HelpListItem {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    url: r.url,
    text: r.description,
    pinned: false,
    modules: r.modules,
    countries: r.countries,
    publishedAt: r.publishedAt,
    state: publicationState(r, now),
    updatedAt: r.updatedAt,
    updatedByName: names.get(r.updatedById) ?? "A former staff member",
    reach,
  };
}

function postItem(r: PostRecord, now: Date, names: Map<string, string>, reach: number | null): HelpListItem {
  return {
    id: r.id,
    kind: "POST",
    title: r.title,
    url: r.linkUrl,
    text: r.body,
    pinned: r.pinned,
    modules: r.modules,
    countries: r.countries,
    publishedAt: r.publishedAt,
    state: publicationState(r, now),
    updatedAt: r.updatedAt,
    updatedByName: names.get(r.updatedById) ?? "A former staff member",
    reach,
  };
}

export type HelpContentList = {
  asOf: Date;
  /**
   * The tab's rows: articles and videos in the order workspaces show them (drafts in their places);
   * posts as drafts, then scheduled, then the live feed pinned first and newest next; archived ones newest first.
   */
  rows: HelpListItem[];
  /** Rows on each tab, archived ones apart. */
  counts: Record<HelpTab, number>;
  archivedCounts: Record<HelpTab, number>;
  /** More rows than the list holds. */
  capped: boolean;
};

/** One tab of the console's list — what is current, or (`archived`) what was filed away, newest first. */
export async function helpContentList(tab: HelpTab, archived: boolean, now = new Date()): Promise<HelpContentList> {
  const control = controlDb();
  const kind = tab === "articles" ? "ARTICLE" : "VIDEO";
  const where = { archivedAt: archived ? { not: null } : null };

  const [linkCounts, linkArchived, posts, postsArchived, links, updates] = await Promise.all([
    control.platformHelpLink.groupBy({ by: ["kind"], where: { archivedAt: null }, _count: { _all: true } }),
    control.platformHelpLink.groupBy({ by: ["kind"], where: { archivedAt: { not: null } }, _count: { _all: true } }),
    control.platformUpdate.count({ where: { archivedAt: null } }),
    control.platformUpdate.count({ where: { archivedAt: { not: null } } }),
    tab === "updates"
      ? Promise.resolve([] as LinkRecord[])
      : control.platformHelpLink.findMany({
          where: { ...where, kind },
          orderBy: archived ? [{ archivedAt: "desc" }, { id: "asc" }] : [{ sortOrder: "asc" }, { publishedAt: { sort: "asc", nulls: "last" } }, { id: "asc" }],
          take: LIST_MAX + 1,
          select: LINK_SELECT,
        }),
    tab !== "updates"
      ? Promise.resolve([] as PostRecord[])
      : control.platformUpdate.findMany({
          where,
          orderBy: archived ? [{ archivedAt: "desc" }, { id: "asc" }] : [{ publishedAt: { sort: "desc", nulls: "first" } }, { createdAt: "desc" }, { id: "asc" }],
          take: LIST_MAX + 1,
          select: POST_SELECT,
        }),
  ]);

  const countOf = (groups: { kind: string; _count: { _all: number } }[], k: string) => groups.find((g) => g.kind === k)?._count._all ?? 0;
  const counts = { articles: countOf(linkCounts, "ARTICLE"), videos: countOf(linkCounts, "VIDEO"), updates: posts };
  const archivedCounts = { articles: countOf(linkArchived, "ARTICLE"), videos: countOf(linkArchived, "VIDEO"), updates: postsArchived };

  const capped = links.length > LIST_MAX || updates.length > LIST_MAX;
  const linkRows = links.slice(0, LIST_MAX);
  // What is being worked on first — drafts, then what is scheduled — and then the live feed as a
  // workspace shows it, pinned first and then newest. The sort is stable, so each group keeps the
  // database's order.
  const rank = (r: PostRecord) => {
    const state = publicationState(r, now);
    return state === "draft" ? 0 : state === "scheduled" ? 1 : r.pinned ? 2 : 3;
  };
  const postRows = updates.slice(0, LIST_MAX).sort((a, b) => (archived ? 0 : rank(a) - rank(b)));

  const records: { modules: string[]; countries: string[]; updatedById: string }[] = tab === "updates" ? postRows : linkRows;
  const [tenants, names] = await Promise.all([archived ? Promise.resolve([]) : openWorkspaces(), staffNames(records.map((r) => r.updatedById))]);
  const reach = archived ? records.map(() => null) : reachOf(records, tenants);

  const rows = tab === "updates" ? postRows.map((r, i) => postItem(r, now, names, reach[i] ?? null)) : linkRows.map((r, i) => linkItem(r, now, names, reach[i] ?? null));
  return { asOf: now, rows, counts, archivedCounts, capped };
}

export type HelpItemDetail = { item: HelpListItem; editor: HelpEditorItem; createdByName: string; archivedAt: Date | null };

/** One item — an article, a video or a post, by id — with its reach now; null when there is no such id. */
export async function helpItemById(id: string, now = new Date()): Promise<HelpItemDetail | null> {
  const key = String(id ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) return null;
  const control = controlDb();
  const [link, post] = await Promise.all([
    control.platformHelpLink.findUnique({ where: { id: key }, select: { ...LINK_SELECT, createdById: true } }),
    control.platformUpdate.findUnique({ where: { id: key }, select: { ...POST_SELECT, createdById: true } }),
  ]);
  const record = link ?? post;
  if (!record) return null;

  const [tenants, names] = await Promise.all([record.archivedAt ? Promise.resolve([]) : openWorkspaces(), staffNames([record.updatedById, record.createdById])]);
  const reach = record.archivedAt ? null : (reachOf([record], tenants)[0] ?? 0);
  const item = link ? linkItem(link, now, names, reach) : postItem(post!, now, names, reach);
  const editor: HelpEditorItem = {
    id: item.id,
    kind: item.kind,
    title: item.title,
    url: link ? link.url : (post?.linkUrl ?? ""),
    description: link?.description ?? "",
    body: post?.body ?? "",
    pinned: post?.pinned ?? false,
    modules: [...item.modules],
    countries: [...item.countries],
    publishedAt: item.publishedAt,
    state: item.state,
  };
  return { item, editor, createdByName: names.get(record.createdById) ?? "A former staff member", archivedAt: record.archivedAt };
}

/** What the editor offers: the countries open workspaces are in, where a link may point, and the limits. */
export async function helpEditorChoices(): Promise<HelpEditorChoices> {
  const control = controlDb();
  const [countries, open] = await Promise.all([
    control.tenant.findMany({ where: { status: "ACTIVE" }, distinct: ["country"], orderBy: { country: "asc" }, select: { country: true } }),
    control.tenant.count({ where: { status: "ACTIVE" } }),
  ]);
  const { titleMin, titleMax, description, body, url, modules, countries: countryMax } = PLATFORM_HELP_LIMITS;
  return {
    countries: countries.map((c) => c.country).filter((c) => /^[A-Z]{2}$/.test(c)),
    linkHosts: [...PLATFORM_LINK_HOSTS],
    linkDomain: PLATFORM_LINK_DOMAIN,
    limits: { titleMin, titleMax, description, body, url, modules, countries: countryMax },
    openWorkspaces: open,
  };
}

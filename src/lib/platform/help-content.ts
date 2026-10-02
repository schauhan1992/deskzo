import type { PlatformHelpKind, Prisma } from "@deskzo/control-client";
import { redactSecrets } from "@/lib/console-shared/redact";
import { moduleEntitled } from "@/lib/entitlements";
import { checkLink, LINK_MAX, youtubeId, type CheckedLink } from "@/lib/help/links";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import type { Tenant } from "@/lib/tenancy/state";

/**
 * Help and What's new from Deskzo: the help articles, walkthrough videos and release notes Deskzo's
 * staff publish once, in the console, for every workspace they apply to. Kept in the control plane
 * (PlatformHelpLink, PlatformUpdate) and shown read-only — no workspace can publish, edit or hide them.
 * A workspace's own guides and company news are its own rows in its own database (src/actions/help.ts);
 * the two are shown apart, under their own headings, and never mixed.
 *
 * Two sides share this file:
 *
 *   · the rules both sides keep — when a row is live, which workspaces it reaches, and where a link
 *     from Deskzo may point — as pure functions, so the console's saves and the check suite use the
 *     very rules the workspace reads by;
 *   · the workspace's read, `deskzoContentFor`, which the rail, the What's new feed and the layout's
 *     unread badge reach on every page. Like `activeAnnouncementsFor` (src/lib/platform/announcements.ts)
 *     it must never throw and never slow a page: it reads one shared, minute-long copy of every live
 *     row, gives the control plane 1.5 s to answer, and shows nothing when it can't.
 *
 * The workspace side is why this file imports so little: console-guard.ts would bring the whole of
 * provisioning and billing into every workspace page, for a help panel. It is server-only, too
 * (check:tenancy keeps client components out of src/lib/platform).
 */

export const PLATFORM_HELP_KINDS = ["ARTICLE", "VIDEO"] as const satisfies readonly PlatformHelpKind[];
export type PlatformHelpKindKey = (typeof PLATFORM_HELP_KINDS)[number];

/** What the console holds a save to — the same limits as the CHECKs in the control migration. */
export const PLATFORM_HELP_LIMITS = {
  titleMin: 3,
  titleMax: 120,
  /** An article's or video's line under the title. */
  description: 300,
  /** A What's new post. */
  body: 4000,
  url: LINK_MAX,
  sortOrderMax: 9999,
  modules: 100,
  countries: 250,
} as const;

// ─── Where a link from Deskzo may point ───────────────────────────────────────────────────────────

/**
 * The sites a link from Deskzo may open, besides deskzo.com and its subdomains. A link Deskzo puts in
 * front of every customer is the best phishing tool there is, so the list is the few places our
 * videos and pages actually live — each site's bare and www. names, nothing more.
 */
export const PLATFORM_LINK_HOSTS = ["youtube.com", "www.youtube.com", "youtu.be", "vimeo.com", "www.vimeo.com", "loom.com", "www.loom.com"] as const;
/** Ours: the domain itself and every name under it. */
export const PLATFORM_LINK_DOMAIN = "deskzo.com";

const HOSTS_IN_WORDS = "YouTube, Vimeo, Loom or deskzo.com";

/**
 * Where a link in Deskzo's help or What's new may point: an `https:` address on an allowlisted host,
 * or a path inside the app ("/orders/new"). Everything `checkLink` (src/lib/help/links.ts) refuses is
 * refused here too, and more:
 *
 *   · no whitespace or control characters anywhere — a browser drops a tab or a newline from an
 *     address before reading it, so "/<tab>/evil.example" would open another site;
 *   · no backslash in a path — browsers read one as "/";
 *   · an address on a host other than PLATFORM_LINK_HOSTS, deskzo.com or a name under it, or with a
 *     port of its own;
 *   · anything longer than 2000 characters once written out, as the database's CHECK counts it.
 *
 * Pure. The console calls it on every save, and the workspace's read calls it again on every row, so
 * a row written past the console never reaches a page.
 */
export function checkPlatformLink(raw: unknown): CheckedLink {
  if (typeof raw !== "string") return { ok: false, error: "Add a link." };
  const checked = checkLink(raw);
  if (!checked.ok) return checked;
  if (/[\s\p{Cc}]/u.test(checked.url)) return { ok: false, error: "A link can't have spaces or line breaks in it." };
  if (checked.url.length > LINK_MAX) return { ok: false, error: "That link is too long." };
  if (!checked.external) {
    if (checked.url.includes("\\")) return { ok: false, error: "Use / between the parts of a path, not \\." };
    return checked;
  }
  let parsed: URL;
  try {
    parsed = new URL(checked.url);
  } catch {
    return { ok: false, error: "That isn't a link — start it with https:// or with / for a page in the app." };
  }
  if (parsed.port) return { ok: false, error: `Links from Deskzo go to ${HOSTS_IN_WORDS} on their usual address, without a port.` };
  const host = parsed.hostname;
  const allowed = (PLATFORM_LINK_HOSTS as readonly string[]).includes(host) || host === PLATFORM_LINK_DOMAIN || host.endsWith(`.${PLATFORM_LINK_DOMAIN}`);
  if (!allowed) return { ok: false, error: `Links from Deskzo go to ${HOSTS_IN_WORDS}, or to a page in the app.` };
  return checked;
}

// ─── When a row shows, and where ─────────────────────────────────────────────────────────────────

export type PublicationState = "draft" | "scheduled" | "live" | "archived";

/** When a row was published and archived — all the console's states are worked out from these two. */
export type Publication = { publishedAt: Date | null; archivedAt: Date | null };

/**
 * Archived whenever archivedAt is set; otherwise a draft until it has a publish time, scheduled while
 * that time is ahead, and live from then on. Pure.
 */
export function publicationState(row: Publication, now: Date): PublicationState {
  if (row.archivedAt) return "archived";
  const at = row.publishedAt instanceof Date ? row.publishedAt.getTime() : NaN;
  if (Number.isNaN(at)) return "draft";
  return at > now.getTime() ? "scheduled" : "live";
}

/** Live: published, at or before `now`, and not archived — the only rows a workspace is ever shown. */
export function isLive(row: Publication, now: Date): boolean {
  return publicationState(row, now) === "live";
}

/** Whom a row is for. Empty lists (or none at all) mean everybody. */
export type Targeting = { modules?: string[] | null; countries?: string[] | null };

/**
 * Whether a row reaches this workspace. Countries, when named, must include its country. Modules,
 * when named, need at least one its plan includes — `moduleEntitled`, read from the entitlements
 * already on the registry's tenant, so no query: a core module reaches everybody, a key the registry
 * doesn't know reaches nobody. Pure.
 */
export function reachesWorkspace(row: Targeting, tenant: Pick<Tenant, "country" | "entitlements">): boolean {
  const modules = Array.isArray(row.modules) ? row.modules : [];
  const countries = Array.isArray(row.countries) ? row.countries : [];
  const country = typeof tenant?.country === "string" ? tenant.country.toUpperCase() : "";
  if (countries.length > 0 && !countries.includes(country)) return false;
  if (modules.length === 0) return true;
  if (!tenant?.entitlements) return false;
  return modules.some((key) => typeof key === "string" && moduleEntitled(tenant.entitlements, country, key));
}

// ─── What the control plane holds, and what a workspace is given ─────────────────────────────────

export type PlatformHelpLinkRow = Publication & {
  id: string;
  kind: PlatformHelpKindKey;
  title: string;
  url: string;
  description: string | null;
  sortOrder: number;
  modules: string[];
  countries: string[];
};

export type PlatformUpdateRow = Publication & {
  id: string;
  title: string;
  body: string;
  linkUrl: string | null;
  pinned: boolean;
  modules: string[];
  countries: string[];
};

/** Every live row on the platform, the same for every workspace — each read filters its own. */
export type PlatformHelpRows = { links: PlatformHelpLinkRow[]; updates: PlatformUpdateRow[] };

/** An article or video as a workspace shows it — the same shape as a company's own (HelpLinkView). */
export type DeskzoHelpLink = {
  id: string;
  kind: PlatformHelpKindKey;
  title: string;
  url: string;
  description: string | null;
  /** False for a path inside the app. */
  external: boolean;
  /** For a thumbnail beside a YouTube video; the video itself always opens on YouTube. */
  youtubeId: string | null;
};

/** A What's new post from Deskzo, as a workspace shows it: nothing about whom else it reaches. */
export type DeskzoUpdate = {
  id: string;
  title: string;
  body: string;
  /** Null when there is none, or when it fails the link rule. */
  linkUrl: string | null;
  external: boolean;
  pinned: boolean;
  publishedAt: Date;
};

/**
 * What this workspace is shown from Deskzo. `ok` is false when the control plane could not be read
 * just now: the lists are then empty because of that, not because Deskzo has nothing — and nothing
 * may be marked read on the strength of them.
 */
export type DeskzoContent = { ok: boolean; links: DeskzoHelpLink[]; updates: DeskzoUpdate[] };

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
} as const satisfies Prisma.PlatformHelpLinkSelect;

const UPDATE_SELECT = {
  id: true,
  title: true,
  body: true,
  linkUrl: true,
  pinned: true,
  modules: true,
  countries: true,
  publishedAt: true,
  archivedAt: true,
} as const satisfies Prisma.PlatformUpdateSelect;

const time = (d: Date | null) => (d instanceof Date ? d.getTime() : 0);

function visibleLinks(rows: unknown, tenant: Pick<Tenant, "country" | "entitlements">, now: Date): DeskzoHelpLink[] {
  const live = (Array.isArray(rows) ? (rows as PlatformHelpLinkRow[]) : []).filter(
    (row) =>
      !!row &&
      (PLATFORM_HELP_KINDS as readonly string[]).includes(row.kind) &&
      typeof row.title === "string" &&
      isLive(row, now) &&
      reachesWorkspace(row, tenant),
  );
  // In the order the console arranged them; ties in the order they were published, as a company's own are.
  live.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || time(a.publishedAt) - time(b.publishedAt) || a.id.localeCompare(b.id));
  const out: DeskzoHelpLink[] = [];
  for (const row of live) {
    const link = checkPlatformLink(row.url);
    if (!link.ok) continue;
    out.push({
      id: row.id,
      kind: row.kind,
      title: row.title,
      url: link.url,
      description: typeof row.description === "string" && row.description.trim() ? row.description : null,
      external: link.external,
      youtubeId: row.kind === "VIDEO" && link.external ? youtubeId(link.url) : null,
    });
  }
  return out;
}

function visibleUpdates(rows: unknown, tenant: Pick<Tenant, "country" | "entitlements">, now: Date): DeskzoUpdate[] {
  const live = (Array.isArray(rows) ? (rows as PlatformUpdateRow[]) : []).filter(
    (row) => !!row && typeof row.title === "string" && typeof row.body === "string" && isLive(row, now) && reachesWorkspace(row, tenant),
  );
  // Pinned first, then newest — as a company's own news is ordered.
  live.sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true) || time(b.publishedAt) - time(a.publishedAt) || a.id.localeCompare(b.id));
  return live.map((row) => {
    const link = row.linkUrl ? checkPlatformLink(row.linkUrl) : null;
    return {
      id: row.id,
      title: row.title,
      body: row.body,
      linkUrl: link?.ok ? link.url : null,
      external: link?.ok ? link.external : false,
      pinned: row.pinned === true,
      // Live, so it has one.
      publishedAt: row.publishedAt as Date,
    };
  });
}

/**
 * Where a person's "seen up to" line for Deskzo's What's new (User.deskzoUpdatesSeenAt) moves when
 * they open it: to the newest post they were shown, or nowhere — null — when the read failed, showed
 * nothing, or showed nothing newer than the line already is.
 *
 * Never to "now": a post published a moment after the minute-long copy was read would be marked read
 * without ever having been shown. Pure.
 */
export function deskzoSeenThrough(content: Pick<DeskzoContent, "ok" | "updates">, current: Date | null): Date | null {
  if (!content?.ok || !Array.isArray(content.updates)) return null;
  let newest = 0;
  for (const u of content.updates) {
    const at = u?.publishedAt instanceof Date ? u.publishedAt.getTime() : NaN;
    if (at > newest) newest = at;
  }
  if (newest <= 0) return null;
  if (current instanceof Date && current.getTime() >= newest) return null;
  return new Date(newest);
}

// ─── The workspace's read ────────────────────────────────────────────────────────────────────────

const CACHE_MS = 60_000;
const LOAD_TIMEOUT_MS = 1_500;
/** Rows published within this are cached too, so one scheduled during the cached minute shows on time. */
const LOOKAHEAD_MS = 3_600_000;
/** The bound on the shared copy — far more than a help panel or a feed shows. */
const LINKS_MAX = 300;
const UPDATES_MAX = 100;

type Loaded = { at: number; ok: boolean; rows: PlatformHelpRows };

/**
 * Every live row on the platform (the same for every workspace — each read filters its own), or none
 * for a minute after the control plane failed to answer. This process's copy only: a save in the
 * console clears it here, and every other process follows within the minute.
 */
let cache: Loaded | null = null;
/** Bumped by every save in the console: a read that began before one answers with what it read, and does not keep it. */
let generation = 0;
/** The read in progress, so the pages of a cold minute — the rail, the feed, the badge — share one query. */
let inflight: { generation: number; promise: Promise<Loaded> } | null = null;

async function loadLive(now: Date): Promise<PlatformHelpRows> {
  const until = new Date(now.getTime() + LOOKAHEAD_MS);
  const control = controlDb();
  const [links, updates] = await Promise.all([
    control.platformHelpLink.findMany({
      where: { archivedAt: null, publishedAt: { lte: until } },
      orderBy: [{ sortOrder: "asc" }, { publishedAt: "asc" }, { id: "asc" }],
      take: LINKS_MAX,
      select: LINK_SELECT,
    }),
    // Pinned first, so a long-pinned post is never pushed out of the bounded copy by newer ones.
    control.platformUpdate.findMany({
      where: { archivedAt: null, publishedAt: { lte: until } },
      orderBy: [{ pinned: "desc" }, { publishedAt: "desc" }, { id: "asc" }],
      take: UPDATES_MAX,
      select: UPDATE_SELECT,
    }),
  ]);
  return { links, updates };
}

/** `load()` given 1.5 s; null — logged — when it fails or doesn't answer in time. Never throws. */
async function within(load: () => Promise<PlatformHelpRows>): Promise<PlatformHelpRows | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const rows = await Promise.race([
      // A loader that throws before returning a promise is caught here too.
      new Promise<PlatformHelpRows>((resolve) => resolve(load())),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${LOAD_TIMEOUT_MS} ms`)), LOAD_TIMEOUT_MS);
      }),
    ]);
    return {
      links: Array.isArray(rows?.links) ? rows.links : [],
      updates: Array.isArray(rows?.updates) ? rows.updates : [],
    };
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim().slice(0, 300);
    console.warn(`[help-content] could not read Deskzo's help and What's new, so none is shown for now: ${redactSecrets(message)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function liveRows(now: Date): Promise<Loaded> {
  const at = now.getTime();
  if (cache && at >= cache.at && at - cache.at < CACHE_MS) return cache;
  if (inflight && inflight.generation === generation) return inflight.promise;
  const started = generation;
  // A failure is remembered as "nothing" for the same minute, so a control plane that is down is
  // asked once a minute — not on every page of every workspace.
  const promise = within(() => loadLive(now)).then((rows): Loaded => {
    const loaded = { at, ok: rows !== null, rows: rows ?? { links: [], updates: [] } };
    if (started === generation) cache = loaded;
    return loaded;
  });
  inflight = { generation: started, promise };
  try {
    return await promise;
  } finally {
    if (inflight?.promise === promise) inflight = null;
  }
}

/**
 * Deskzo's live articles, videos and What's new posts for this workspace — articles and videos in the
 * console's order, posts pinned first and then newest. Never throws, and never waits more than 1.5 s:
 * a workspace from the environment and an installation without a control plane are shown nothing
 * (with `ok`, since nothing failed); a control plane that is down or slow is nothing with `ok: false`.
 *
 * Callers pick what they need: `links` by kind for the rail's panels, `updates` for What's new and its
 * unread count, and `deskzoSeenThrough` to mark them read.
 *
 * `load` replaces the query, for the check suite's proof of the failing path. What it returns is never
 * cached: the shared copy only ever holds what the control plane said.
 */
export async function deskzoContentFor(
  tenant: Pick<Tenant, "country" | "entitlements" | "source">,
  now: Date = new Date(),
  load?: () => Promise<PlatformHelpRows>,
): Promise<DeskzoContent> {
  try {
    if (!tenant || tenant.source !== "control" || !controlConfigured()) return { ok: true, links: [], updates: [] };
    let ok: boolean;
    let rows: PlatformHelpRows;
    if (load) {
      const got = await within(load);
      ok = got !== null;
      rows = got ?? { links: [], updates: [] };
    } else {
      ({ ok, rows } = await liveRows(now));
    }
    return { ok, links: visibleLinks(rows.links, tenant, now), updates: visibleUpdates(rows.updates, tenant, now) };
  } catch (err) {
    console.warn(`[help-content] skipped: ${redactSecrets(err instanceof Error ? err.message : String(err))}`);
    return { ok: false, links: [], updates: [] };
  }
}

/** Forget this process's copy — after every change in the console, so its own pages show it at once. */
export function forgetHelpContent(): void {
  generation += 1;
  cache = null;
}

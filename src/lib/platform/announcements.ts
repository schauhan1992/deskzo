import type { AnnouncementAudience, AnnouncementTone, Prisma } from "@deskzo/control-client";
import type { AnnouncementTab } from "@/lib/console-shared/params";
import { redactSecrets } from "@/lib/console-shared/redact";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { LIVE_STATUSES } from "@/lib/platform/entitlements";
import { ConsoleRefused } from "@/lib/platform/refused";
import type { Tenant } from "@/lib/tenancy/state";

/**
 * Platform announcements: a banner the console puts across the top of workspaces' pages — to all of
 * them, or to chosen workspaces, countries or plans — for a window of time.
 *
 * Two sides share this file:
 *
 *   · the console's: the list, one announcement, the editor's choices, the reach preview and the
 *     validation every save goes through (src/actions/platform/console-announcements.ts);
 *   · the workspace's: `activeAnnouncementsFor`, which the dashboard layout calls on every page. It
 *     must never throw and never slow a page, so it reads one shared, minute-long cache of every live
 *     announcement, gives the control plane 1.5 s to answer, and shows nothing when it can't.
 *
 * The workspace side is why this file imports so little: console-guard.ts would bring the whole of
 * provisioning and billing into every workspace page, for a banner.
 *
 * What a banner says is plain text, always: no HTML, no markdown, no links (see
 * src/components/platform/announcement-banner.tsx). A console account that could put a link in front
 * of every customer would be the best phishing tool there is.
 */

export type AnnouncementToneKey = "INFO" | "WARNING" | "CRITICAL";
export type AnnouncementAudienceKey = "ALL" | "TENANTS" | "COUNTRIES" | "PLANS";

export const ANNOUNCEMENT_TONES = ["INFO", "WARNING", "CRITICAL"] as const satisfies readonly AnnouncementTone[];
export const ANNOUNCEMENT_AUDIENCES = ["ALL", "TENANTS", "COUNTRIES", "PLANS"] as const satisfies readonly AnnouncementAudience[];

export type AnnouncementRow = {
  id: string;
  title: string;
  body: string;
  tone: AnnouncementToneKey;
  audience: AnnouncementAudienceKey;
  /** Tenant ids, country codes or plan keys, by audience; empty for ALL. */
  targets: string[];
  startsAt: Date;
  endsAt: Date | null;
  dismissible: boolean;
};

export type AnnouncementListRow = AnnouncementRow & {
  createdBy: string;
  createdByName: string;
  updatedBy: string | null;
  archivedAt: Date | null;
  state: "live" | "scheduled" | "ended" | "archived";
  /** Open workspaces it reaches now. */
  reach: number;
};

/** The editor's choices. */
export type AnnouncementTargets = { tenants: { id: string; slug: string; name: string }[]; plans: { key: string; name: string }[]; countries: string[] };

/** What a workspace page is given: nothing about who else sees it. */
export type AnnouncementView = { id: string; title: string; body: string; tone: AnnouncementToneKey; dismissible: boolean };

const TITLE_MIN = 3;
const TITLE_MAX = 120;
const BODY_MAX = 1000;
const TARGETS_MAX = 200;
/** A window longer than this is refused, so a forgotten banner can't linger for good. */
const WINDOW_MAX_MS = 90 * 86_400_000;
/** A start further ahead than this is a typo for a year. */
const START_AHEAD_MAX_MS = 365 * 86_400_000;
const TENANT_LIST_MAX = 2000;
const SAMPLE_SIZE = 10;
/** Ids are cuids (a workspace from the environment has its slug); plan keys as src/lib/platform/plans.ts writes them. */
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const COUNTRY_PATTERN = /^[A-Z]{2}$/;
const PLAN_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

const ROW_SELECT = {
  id: true,
  title: true,
  body: true,
  tone: true,
  audience: true,
  targets: true,
  startsAt: true,
  endsAt: true,
  dismissible: true,
} as const satisfies Prisma.PlatformAnnouncementSelect;

const LIST_SELECT = { ...ROW_SELECT, createdBy: true, updatedBy: true, archivedAt: true } as const satisfies Prisma.PlatformAnnouncementSelect;

type ListRecord = Prisma.PlatformAnnouncementGetPayload<{ select: typeof LIST_SELECT }>;

// ─── Console side ────────────────────────────────────────────────────────────────────────────────

function stateOf(row: { startsAt: Date; endsAt: Date | null; archivedAt: Date | null }, now: Date): AnnouncementListRow["state"] {
  if (row.archivedAt) return "archived";
  if (row.endsAt && row.endsAt.getTime() <= now.getTime()) return "ended";
  if (row.startsAt.getTime() > now.getTime()) return "scheduled";
  return "live";
}

/** Each tab's count, from the database rather than the capped list, so a tab never undercounts. */
function tabWhere(tab: AnnouncementTab, now: Date): Prisma.PlatformAnnouncementWhereInput {
  switch (tab) {
    case "live":
      return { archivedAt: null, startsAt: { lte: now }, OR: [{ endsAt: null }, { endsAt: { gt: now } }] };
    case "scheduled":
      return { archivedAt: null, startsAt: { gt: now } };
    case "ended":
      return { archivedAt: null, endsAt: { lte: now } };
    case "archived":
      return { archivedAt: { not: null } };
  }
}

/** Open workspaces an audience reaches — the same rules the reach preview and the list use. */
function reachWhere(audience: AnnouncementAudienceKey, targets: string[]): Prisma.TenantWhereInput | null {
  switch (audience) {
    case "ALL":
      return { status: "ACTIVE" };
    case "TENANTS":
      return targets.length ? { id: { in: targets }, status: "ACTIVE" } : null;
    case "COUNTRIES":
      return targets.length ? { country: { in: targets }, status: "ACTIVE" } : null;
    case "PLANS":
      return targets.length
        ? { status: "ACTIVE", subscriptions: { some: { status: { in: [...LIVE_STATUSES] }, items: { some: { plan: { key: { in: targets } } } } } } }
        : null;
  }
}

/**
 * Every row's reach in a handful of queries rather than one per row: one count for ALL, one grouping
 * by country, one lookup of the named workspaces, and a count per distinct set of plans (a workspace
 * on two of a row's plans is one workspace, so plan counts don't add).
 */
async function reachOfRows(rows: { audience: AnnouncementAudienceKey; targets: string[] }[]): Promise<number[]> {
  if (rows.length === 0) return [];
  const control = controlDb();
  const union = (audience: AnnouncementAudienceKey) => [...new Set(rows.filter((r) => r.audience === audience).flatMap((r) => r.targets))];
  const countries = union("COUNTRIES");
  const tenantIds = union("TENANTS");
  const planKey = (targets: string[]) => [...new Set(targets)].sort().join("\n");
  const planSets = [...new Set(rows.filter((r) => r.audience === "PLANS" && r.targets.length > 0).map((r) => planKey(r.targets)))];

  const [all, byCountry, openIds, planCounts] = await Promise.all([
    rows.some((r) => r.audience === "ALL") ? control.tenant.count({ where: { status: "ACTIVE" } }) : Promise.resolve(0),
    countries.length
      ? control.tenant.groupBy({ by: ["country"], where: { status: "ACTIVE", country: { in: countries } }, _count: { _all: true } })
      : Promise.resolve([]),
    tenantIds.length ? control.tenant.findMany({ where: { id: { in: tenantIds }, status: "ACTIVE" }, select: { id: true } }) : Promise.resolve([]),
    Promise.all(planSets.map((key) => control.tenant.count({ where: reachWhere("PLANS", key.split("\n")) ?? { id: { in: [] } } }))),
  ]);

  const perCountry = new Map(byCountry.map((g) => [g.country, g._count._all]));
  const open = new Set(openIds.map((t) => t.id));
  const perPlans = new Map(planSets.map((key, i) => [key, planCounts[i] ?? 0]));
  return rows.map((r) => {
    switch (r.audience) {
      case "ALL":
        return all;
      case "COUNTRIES":
        // A workspace has one country, so these do add up.
        return [...new Set(r.targets)].reduce((sum, c) => sum + (perCountry.get(c) ?? 0), 0);
      case "TENANTS":
        return [...new Set(r.targets)].filter((id) => open.has(id)).length;
      case "PLANS":
        return r.targets.length ? (perPlans.get(planKey(r.targets)) ?? 0) : 0;
    }
  });
}

/** Staff names for "Created by" — switched-off members included, since old announcements name them. */
async function staffNames(ids: string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter(Boolean))];
  if (wanted.length === 0) return new Map();
  const rows = await controlDb().platformUser.findMany({ where: { id: { in: wanted } }, select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function toListRows(records: ListRecord[], now: Date): Promise<AnnouncementListRow[]> {
  const [reach, names] = await Promise.all([reachOfRows(records), staffNames(records.map((r) => r.createdBy))]);
  return records.map((r, i) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    tone: r.tone,
    audience: r.audience,
    targets: r.targets,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    dismissible: r.tone !== "CRITICAL" && r.dismissible,
    createdBy: r.createdBy,
    createdByName: names.get(r.createdBy) ?? "A former staff member",
    updatedBy: r.updatedBy,
    archivedAt: r.archivedAt,
    state: stateOf(r, now),
    reach: reach[i] ?? 0,
  }));
}

/** The console's list: the newest 100, archived last, with each tab's count. */
export async function announcementsList(now = new Date()): Promise<{ asOf: Date; rows: AnnouncementListRow[]; counts: Record<AnnouncementTab, number> }> {
  const table = controlDb().platformAnnouncement;
  const [records, live, scheduled, ended, archived] = await Promise.all([
    table.findMany({ orderBy: [{ archivedAt: { sort: "asc", nulls: "first" } }, { startsAt: "desc" }], take: 100, select: LIST_SELECT }),
    table.count({ where: tabWhere("live", now) }),
    table.count({ where: tabWhere("scheduled", now) }),
    table.count({ where: tabWhere("ended", now) }),
    table.count({ where: tabWhere("archived", now) }),
  ]);
  return { asOf: now, rows: await toListRows(records, now), counts: { live, scheduled, ended, archived } };
}

/** One announcement, for the editor and the read-only view; null when there is no such id. */
export async function announcementById(id: string, now = new Date()): Promise<AnnouncementListRow | null> {
  const key = String(id ?? "").trim();
  if (!ID_PATTERN.test(key)) return null;
  const record = await controlDb().platformAnnouncement.findUnique({ where: { id: key }, select: LIST_SELECT });
  if (!record) return null;
  const [row] = await toListRows([record], now);
  return row ?? null;
}

/** What the editor offers: open workspaces (the first 2000 by name), every plan, and the countries open workspaces are in. */
export async function announcementTargets(): Promise<AnnouncementTargets> {
  const control = controlDb();
  const [tenants, plans, countries] = await Promise.all([
    control.tenant.findMany({ where: { status: "ACTIVE" }, orderBy: [{ name: "asc" }, { slug: "asc" }], take: TENANT_LIST_MAX, select: { id: true, slug: true, name: true } }),
    // Retired plans too: the workspaces already on them are still there to be told something.
    control.plan.findMany({ orderBy: [{ active: "desc" }, { sortOrder: "asc" }, { name: "asc" }], select: { key: true, name: true } }),
    control.tenant.findMany({ where: { status: "ACTIVE" }, distinct: ["country"], orderBy: { country: "asc" }, select: { country: true } }),
  ]);
  return { tenants, plans, countries: countries.map((c) => c.country) };
}

/** One target as stored, or null when it can't be one for this audience. */
function normalTarget(audience: AnnouncementAudienceKey, value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  switch (audience) {
    case "TENANTS":
      return ID_PATTERN.test(v) ? v : null;
    case "COUNTRIES":
      return COUNTRY_PATTERN.test(v.toUpperCase()) ? v.toUpperCase() : null;
    case "PLANS":
      return PLAN_KEY_PATTERN.test(v.toLowerCase()) ? v.toLowerCase() : null;
    case "ALL":
      return null;
  }
}

/**
 * How many open workspaces an audience reaches now, and up to ten of their addresses — the editor's
 * live preview. Lenient where the save is strict: a target that can't be one is left out, not refused.
 */
export async function announcementReach(audience: AnnouncementAudienceKey, targets: string[]): Promise<{ count: number; sample: string[] }> {
  const list = Array.isArray(targets) ? targets.slice(0, TARGETS_MAX * 5) : [];
  const normal = [...new Set(list.map((t) => normalTarget(audience, t)).filter((t): t is string => t !== null))].slice(0, TARGETS_MAX);
  const where = reachWhere(audience, normal);
  if (!where) return { count: 0, sample: [] };
  const control = controlDb();
  const [count, sample] = await Promise.all([
    control.tenant.count({ where }),
    control.tenant.findMany({ where, orderBy: { slug: "asc" }, take: SAMPLE_SIZE, select: { slug: true } }),
  ]);
  return { count, sample: sample.map((t) => t.slug) };
}

// ─── Validation ──────────────────────────────────────────────────────────────────────────────────

function refuse(message: string): never {
  throw new ConsoleRefused(message);
}

/** A character nobody means to put in a banner: control characters but the newline, and the bidi overrides that make text read backwards. */
function unwanted(code: number): boolean {
  return (code < 32 && code !== 10) || code === 127 || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

/** Text from the editor: line endings made "\n", tabs made spaces, unwanted characters dropped, trimmed. Never cut — too long is refused. */
function plainText(input: unknown, what: string): string {
  if (input === null || input === undefined) return "";
  if (typeof input !== "string" && typeof input !== "number") refuse(`The ${what} must be text.`);
  const raw = String(input);
  // Bounded before any work: a megabyte of title is not a title.
  if (raw.length > 20_000) refuse(`The ${what} is far too long.`);
  let out = "";
  for (const ch of raw.replace(/\r\n?/g, "\n").replace(/\t/g, " ")) if (!unwanted(ch.codePointAt(0) ?? 0)) out += ch;
  return out.trim();
}

/** Characters as the database's CHECK counts them — code points, so an emoji is one. */
const charCount = (s: string) => [...s].length;

function pick<K extends string>(value: unknown, allowed: readonly K[]): K | null {
  const v = typeof value === "string" ? value.trim().toUpperCase() : "";
  return (allowed as readonly string[]).includes(v) ? (v as K) : null;
}

/**
 * A Date, or an ISO time with its zone; undefined when blank. A `datetime-local` value names no zone: the
 * action reads it on the console's clock first (src/actions/platform/console-announcements.ts).
 */
function dateOf(value: unknown, what: "start" | "end"): Date | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) refuse(`Enter the ${what} as a date and time.`);
    return value;
  }
  if (typeof value !== "string") refuse(`Enter the ${what} as a date and time.`);
  const v = value.trim();
  if (!v) return undefined;
  // An instant with its zone written on it — what a script or the check suite passes.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(v)) {
    const at = new Date(v);
    if (!Number.isNaN(at.getTime())) return at;
  }
  return refuse(`Enter the ${what} as a date and time.`);
}

const TARGET_WORDS: Record<Exclude<AnnouncementAudienceKey, "ALL">, { one: string; many: string; bad: string }> = {
  TENANTS: { one: "workspace", many: "workspaces", bad: "One of the chosen workspaces isn't a workspace id." },
  COUNTRIES: { one: "country", many: "countries", bad: "Countries are two-letter codes, like IN or US." },
  PLANS: { one: "plan", many: "plans", bad: "One of the chosen plans isn't a plan key." },
};

function targetList(audience: Exclude<AnnouncementAudienceKey, "ALL">, input: unknown): string[] {
  const words = TARGET_WORDS[audience];
  if (input !== undefined && input !== null && !Array.isArray(input)) refuse(`Choose at least one ${words.one}.`);
  const list = (input ?? []) as unknown[];
  if (list.length > TARGETS_MAX * 5) refuse(`Choose at most ${TARGETS_MAX} ${words.many}.`);
  const out = new Set<string>();
  for (const value of list) {
    const target = normalTarget(audience, value);
    if (target === null) refuse(words.bad);
    out.add(target);
  }
  if (out.size === 0) refuse(`Choose at least one ${words.one}.`);
  if (out.size > TARGETS_MAX) refuse(`Choose at most ${TARGETS_MAX} ${words.many}${audience === "TENANTS" ? " — use countries or plans for more" : ""}.`);
  return [...out];
}

/**
 * An announcement as it will be saved, or a ConsoleRefused saying what to fix. Pure — whether the
 * chosen workspaces and plans exist is `checkAnnouncementTargets`, which asks the database.
 *
 *   · title 3–120 characters, one line; body 1–1000, line breaks kept; control characters dropped;
 *   · tone and audience from their lists; targets 1–200 for a chosen audience, none for ALL;
 *   · starts now unless given; ends after it starts, within 90 days of the start, and not already
 *     past; CRITICAL must end, and is never dismissible.
 *
 * Dates may be Dates, or ISO times with a zone — never a bare wall-clock time, whose zone only the
 * caller knows.
 */
export function validateAnnouncement(input: unknown, now: Date): Omit<AnnouncementRow, "id"> {
  if (!input || typeof input !== "object") refuse("Nothing to save.");
  const x = input as Record<string, unknown>;

  const title = plainText(x.title, "title").replace(/\s+/g, " ");
  if (charCount(title) < TITLE_MIN) refuse(`Give it a title of at least ${TITLE_MIN} characters.`);
  if (charCount(title) > TITLE_MAX) refuse(`Keep the title to ${TITLE_MAX} characters.`);

  // Line breaks are the only formatting a banner has; a run of blank lines is not formatting.
  const body = plainText(x.body, "message")
    .replace(/[ ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  if (charCount(body) < 1) refuse("Write what the announcement says.");
  if (charCount(body) > BODY_MAX) refuse("Keep the message to 1,000 characters.");

  const tone = pick(x.tone, ANNOUNCEMENT_TONES);
  if (!tone) refuse("Choose a tone: info, warning or critical.");
  const audience = pick(x.audience, ANNOUNCEMENT_AUDIENCES);
  if (!audience) refuse("Choose who it is for.");
  const targets = audience === "ALL" ? [] : targetList(audience, x.targets);

  const startsAt = dateOf(x.startsAt, "start") ?? now;
  const endsAt = dateOf(x.endsAt, "end") ?? null;
  if (startsAt.getTime() - now.getTime() > START_AHEAD_MAX_MS) refuse("The start is more than a year away — check the date.");
  if (tone === "CRITICAL" && !endsAt) refuse("A critical announcement can't be dismissed, so it needs an end time.");
  if (endsAt) {
    if (endsAt.getTime() <= startsAt.getTime()) refuse("The end must be after the start.");
    if (endsAt.getTime() - startsAt.getTime() > WINDOW_MAX_MS) refuse("An announcement can run for at most 90 days — choose an earlier end.");
    if (endsAt.getTime() <= now.getTime()) refuse("The end time has already passed — choose a later one.");
  }

  // Missing means the default (dismissible); only CRITICAL is never.
  const dismissible = tone !== "CRITICAL" && x.dismissible !== false && x.dismissible !== "false";
  return { title, body, tone, audience, targets, startsAt, endsAt, dismissible };
}

/** Refuses chosen workspaces or plans that don't exist. Countries need no lookup — the code is the whole of them. */
export async function checkAnnouncementTargets(audience: AnnouncementAudienceKey, targets: string[]): Promise<void> {
  if (targets.length === 0) return;
  const control = controlDb();
  if (audience === "TENANTS") {
    const found = new Set((await control.tenant.findMany({ where: { id: { in: targets } }, select: { id: true } })).map((t) => t.id));
    const missing = targets.filter((id) => !found.has(id)).length;
    if (missing) refuse(missing === 1 ? "One of the chosen workspaces no longer exists — take it off the list." : `${missing} of the chosen workspaces no longer exist — take them off the list.`);
  }
  if (audience === "PLANS") {
    const found = new Set((await control.plan.findMany({ where: { key: { in: targets } }, select: { key: true } })).map((p) => p.key));
    const missing = targets.filter((key) => !found.has(key));
    if (missing.length) refuse(`No plan has the key ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ` and ${missing.length - 3} more` : ""}.`);
  }
}

// ─── Workspace side ──────────────────────────────────────────────────────────────────────────────

const CACHE_MS = 60_000;
const LOAD_TIMEOUT_MS = 1_500;
/** Rows starting within this are cached too, so one that starts during the cached minute shows on time. */
const LOOKAHEAD_MS = 3_600_000;
const TONE_RANK: Record<AnnouncementToneKey, number> = { CRITICAL: 0, WARNING: 1, INFO: 2 };

/**
 * Every live announcement on the platform (the same for every workspace — each call filters its own),
 * or [] for a minute after the control plane failed to answer. This process's copy only: a save in the
 * console clears it here, and every other process follows within the minute.
 */
let cache: { at: number; rows: AnnouncementRow[] } | null = null;

async function loadLive(now: Date): Promise<AnnouncementRow[]> {
  const rows = await controlDb().platformAnnouncement.findMany({
    where: { archivedAt: null, startsAt: { lte: new Date(now.getTime() + LOOKAHEAD_MS) }, OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
    orderBy: { startsAt: "desc" },
    take: 20,
    select: ROW_SELECT,
  });
  return rows;
}

/** `load()` given 1.5 s; null — logged — when it fails or doesn't answer in time. */
async function within(load: () => Promise<AnnouncementRow[]>): Promise<AnnouncementRow[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const rows = await Promise.race([
      // A loader that throws before returning a promise is caught here too.
      new Promise<AnnouncementRow[]>((resolve) => resolve(load())),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${LOAD_TIMEOUT_MS} ms`)), LOAD_TIMEOUT_MS);
      }),
    ]);
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim().slice(0, 300);
    console.warn(`[announcements] could not read the platform's announcements, so none are shown for now: ${redactSecrets(message)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function liveRows(now: Date): Promise<AnnouncementRow[]> {
  const at = now.getTime();
  if (cache && at >= cache.at && at - cache.at < CACHE_MS) return cache.rows;
  // A failure is remembered as "nothing" for the same minute, so a control plane that is down is
  // asked once a minute — not on every page of every workspace.
  const rows = (await within(() => loadLive(now))) ?? [];
  cache = { at, rows };
  return rows;
}

function reaches(row: AnnouncementRow, tenant: Pick<Tenant, "id" | "country" | "entitlements">): boolean {
  const targets = Array.isArray(row.targets) ? row.targets : [];
  switch (row.audience) {
    case "ALL":
      return true;
    case "TENANTS":
      return targets.includes(tenant.id);
    case "COUNTRIES":
      return typeof tenant.country === "string" && targets.includes(tenant.country.toUpperCase());
    case "PLANS": {
      // The plans its entitlements were worked out from — already on the registry's tenant, so no query.
      const plans: unknown = tenant.entitlements?.plans;
      return Array.isArray(plans) && plans.some((p) => typeof p === "string" && targets.includes(p));
    }
    default:
      return false;
  }
}

function showing(row: AnnouncementRow, now: Date): boolean {
  const start = row.startsAt instanceof Date ? row.startsAt.getTime() : NaN;
  const end = row.endsAt instanceof Date ? row.endsAt.getTime() : null;
  return start <= now.getTime() && (end === null || end > now.getTime());
}

/**
 * The announcements this workspace shows now, most serious first. Never throws, and never waits more
 * than 1.5 s: a workspace from the environment, an installation without a control plane, a control
 * plane that is down or slow — each is simply no announcements.
 *
 * `load` replaces the query, for the check suite's proof of the failing path. What it returns is never
 * cached: the shared cache only ever holds what the control plane said.
 */
export async function activeAnnouncementsFor(
  tenant: Pick<Tenant, "id" | "country" | "entitlements" | "source">,
  now: Date = new Date(),
  load?: () => Promise<AnnouncementRow[]>,
): Promise<AnnouncementView[]> {
  try {
    if (!tenant || tenant.source !== "control" || !controlConfigured()) return [];
    const rows = load ? ((await within(load)) ?? []) : await liveRows(now);
    return rows
      .filter((row) => row && (ANNOUNCEMENT_TONES as readonly string[]).includes(row.tone) && showing(row, now) && reaches(row, tenant))
      .sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone] || b.startsAt.getTime() - a.startsAt.getTime())
      .map((row) => ({ id: row.id, title: row.title, body: row.body, tone: row.tone, dismissible: row.tone !== "CRITICAL" && row.dismissible === true }));
  } catch (err) {
    console.warn(`[announcements] skipped: ${redactSecrets(err instanceof Error ? err.message : String(err))}`);
    return [];
  }
}

/** Forget this process's copy — after every change in the console, so its own pages show it at once. */
export function forgetAnnouncements(): void {
  cache = null;
}

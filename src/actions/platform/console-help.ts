"use server";

import type { StaffRole } from "@deskzo/control-client";
import type { ConsoleResult } from "@/actions/platform/console";
import { parseEntitlements } from "@/lib/entitlements";
import { COUNTRIES } from "@/lib/geo/countries";
import { parseIstDateTime } from "@/lib/india-time";
import { getModuleDefinition } from "@/lib/modules";
import { MANAGERS, consoleAudit, consoleRefusal, idList, revalidateConsole } from "@/lib/platform/console-guard";
import { controlDb } from "@/lib/platform/control-db";
import {
  PLATFORM_HELP_KINDS,
  PLATFORM_HELP_LIMITS,
  checkPlatformLink,
  forgetHelpContent,
  publicationState,
  reachesWorkspace,
  type PlatformHelpKindKey,
  type PublicationState,
} from "@/lib/platform/help-content";
import { ConsoleRefused } from "@/lib/platform/refused";
import { StaffRefused, requireStaff, type Staff } from "@/lib/platform/staff-session";
import { BASE_MODULES } from "@/lib/products";

/**
 * Help and What's new from Deskzo, in the console (src/lib/platform/help-content.ts): the help
 * articles, walkthrough videos and release notes every workspace they are for shows read-only, beside
 * — never mixed with — its own guides and company news.
 *
 * Owners and admins write them. Making one live (or keeping it live) for every workspace at once —
 * no modules and no countries chosen — is the owner's, or an admin's who types "publish" as well,
 * as an announcement to every workspace asks for. A draft reaches nobody, so saving one asks
 * nothing more.
 *
 * Every change clears this process's cached copy; other servers pick it up within a minute. The
 * audit entry names the item — its id and title — never its body or its link.
 */

async function asStaff<T>(roles: readonly StaffRole[], work: (staff: Staff) => Promise<T>): Promise<ConsoleResult<T>> {
  let staff: Staff;
  try {
    staff = await requireStaff(roles);
  } catch (err) {
    if (err instanceof StaffRefused) return { ok: false, error: err.message };
    throw err;
  }
  try {
    return { ok: true, data: await work(staff) };
  } catch (err) {
    const refusal = consoleRefusal(err);
    if (refusal !== null) return { ok: false, error: refusal };
    throw err;
  }
}

function refuse(message: string): never {
  throw new ConsoleRefused(message);
}

/** Which table an item is in: an article or video (PlatformHelpLink), or a What's new post (PlatformUpdate). */
type Item = "link" | "post";

const GONE = "That item no longer exists.";
const CHANGED = "It changed meanwhile — reload and try again.";
/** A publish time further ahead than this is a typo for a year. */
const AHEAD_MAX_MS = 365 * 86_400_000;
/** How many articles (or videos) one reorder may hold. */
const ORDER_MAX = 500;
/** The workspaces the reach preview names. */
const SAMPLE_SIZE = 10;
/** Open workspaces counted for reach — far more than there are; past it the count says "at least". */
const REACH_TENANTS_MAX = 20_000;

/** How each kind is named, in its audit action ("help.video.publish") and in a refusal. */
const WORD: Record<PlatformHelpKindKey | "POST", string> = { ARTICLE: "article", VIDEO: "video", POST: "post" };

/** An item id from the browser, or a refusal. */
function itemId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) refuse(GONE);
  return id;
}

function itemOf(value: unknown): Item {
  if (value === "link" || value === "post") return value;
  return refuse("Choose an article, a video or a What's new post.");
}

function kindOf(value: unknown): PlatformHelpKindKey {
  const v = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!(PLATFORM_HELP_KINDS as readonly string[]).includes(v)) refuse("Choose an article or a video.");
  return v as PlatformHelpKindKey;
}

// ─── Text ────────────────────────────────────────────────────────────────────────────────────────

/** A character nobody means to publish: control characters but the newline, and the bidi overrides that make text read backwards. */
function unwanted(code: number): boolean {
  return (code < 32 && code !== 10) || code === 127 || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

/** Text from the editor: line endings made "\n", tabs made spaces, unwanted characters dropped, trimmed. Never cut — too long is refused. */
function plainText(input: unknown, what: string): string {
  if (input === null || input === undefined) return "";
  if (typeof input !== "string" && typeof input !== "number") refuse(`The ${what} must be text.`);
  const raw = String(input);
  // Bounded before any work: a megabyte of title is not a title.
  if (raw.length > 40_000) refuse(`The ${what} is far too long.`);
  let out = "";
  for (const ch of raw.replace(/\r\n?/g, "\n").replace(/\t/g, " ")) if (!unwanted(ch.codePointAt(0) ?? 0)) out += ch;
  return out.trim();
}

/** Characters as the database's CHECK counts them — code points, so an emoji is one. */
const charCount = (s: string) => [...s].length;

function titleOf(input: unknown): string {
  const title = plainText(input, "title").replace(/\s+/g, " ");
  if (charCount(title) < PLATFORM_HELP_LIMITS.titleMin) refuse(`Give it a title of at least ${PLATFORM_HELP_LIMITS.titleMin} characters.`);
  if (charCount(title) > PLATFORM_HELP_LIMITS.titleMax) refuse(`Keep the title to ${PLATFORM_HELP_LIMITS.titleMax} characters.`);
  return title;
}

/** An article's or video's line under the title: one line, or none. */
function descriptionOf(input: unknown): string | null {
  const text = plainText(input, "description").replace(/\s+/g, " ");
  if (!text) return null;
  if (charCount(text) > PLATFORM_HELP_LIMITS.description) refuse(`Keep the description to ${PLATFORM_HELP_LIMITS.description} characters.`);
  return text;
}

/** A What's new post: line breaks are its only formatting, and a run of blank lines is not formatting. */
function bodyOf(input: unknown): string {
  const body = plainText(input, "post")
    .replace(/[ ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  if (charCount(body) < 1) refuse("Write what the post says.");
  if (charCount(body) > PLATFORM_HELP_LIMITS.body) refuse(`Keep the post to ${PLATFORM_HELP_LIMITS.body.toLocaleString("en-IN")} characters.`);
  return body;
}

/** A link held to the platform's rule (an allowlisted host, or a path in the app), written out as it is stored. */
function linkOf(input: unknown): string {
  const checked = checkPlatformLink(typeof input === "string" ? input : "");
  if (!checked.ok) refuse(checked.error);
  return checked.url;
}

// ─── Who it is for ───────────────────────────────────────────────────────────────────────────────

/**
 * Module keys from the registry (src/lib/modules.ts), each once, in a stable order. A module every
 * workspace has is refused — a core one, one in every plan, or one every product's plan comes with
 * (`BASE_MODULES`: Workspace's saved lists are one, and Deskzo One has them all): a row reaches a
 * workspace when its plan has any one of the chosen modules, so one such key would quietly make the
 * rest reach everybody — without the owner, or "publish" typed, that every workspace asks for.
 */
function modulesOf(input: unknown): string[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) refuse("Choose modules from the list.");
  if (input.length > PLATFORM_HELP_LIMITS.modules * 5) refuse(`Choose at most ${PLATFORM_HELP_LIMITS.modules} modules.`);
  const out = new Set<string>();
  for (const value of input) {
    const key = typeof value === "string" ? value.trim() : "";
    const def = /^[a-z][a-z0-9_]{0,39}$/.test(key) ? getModuleDefinition(key) : undefined;
    if (!def) refuse("One of the chosen modules isn't a module — choose from the list.");
    if (def.core || def.inEveryPlan || BASE_MODULES.includes(def.key)) {
      refuse(`${def.label} is in every workspace, so it narrows nothing — take it off, or choose no modules to reach every workspace.`);
    }
    out.add(def.key);
  }
  if (out.size > PLATFORM_HELP_LIMITS.modules) refuse(`Choose at most ${PLATFORM_HELP_LIMITS.modules} modules.`);
  return [...out].sort();
}

/** The ISO 3166-1 alpha-2 codes there are — the list a workspace's own country is chosen from. */
const COUNTRY_CODES: ReadonlySet<string> = new Set(COUNTRIES.map((c) => c.code));

/**
 * ISO 3166-1 alpha-2 codes, upper-cased, each once. A code that is no country's is refused, not kept:
 * "UK" (the United Kingdom is GB) would otherwise save and reach nobody, without a word.
 */
function countriesOf(input: unknown): string[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) refuse("Countries are two-letter codes, like IN or US.");
  if (input.length > PLATFORM_HELP_LIMITS.countries * 5) refuse(`Choose at most ${PLATFORM_HELP_LIMITS.countries} countries.`);
  const out = new Set<string>();
  for (const value of input) {
    const code = typeof value === "string" ? value.trim().toUpperCase() : "";
    if (!/^[A-Z]{2}$/.test(code)) refuse("Countries are two-letter codes, like IN or US.");
    if (!COUNTRY_CODES.has(code)) refuse(`${code} isn't a country's code — use its ISO code, like IN, US or GB.`);
    out.add(code);
  }
  if (out.size > PLATFORM_HELP_LIMITS.countries) refuse(`Choose at most ${PLATFORM_HELP_LIMITS.countries} countries.`);
  return [...out].sort();
}

/** No module and no country chosen: every workspace. */
const everywhere = (row: { modules: string[]; countries: string[] }) => row.modules.length === 0 && row.countries.length === 0;

// ─── When it shows ───────────────────────────────────────────────────────────────────────────────

/** A Date, an India wall-clock "yyyy-mm-ddThh:mm" (a `datetime-local` value) or an ISO time with its zone; null when blank. */
function instantOf(value: unknown): Date | null {
  if (value === undefined || value === null || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? refuse("Enter when it goes live as a date and time.") : value;
  if (typeof value !== "string") refuse("Enter when it goes live as a date and time.");
  const v = value.trim();
  if (!v) return null;
  const local = v.length <= 32 ? parseIstDateTime(v) : null;
  if (local) return local;
  // An instant with its zone written on it — what a script or the check suite passes.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(v)) {
    const at = new Date(v);
    if (!Number.isNaN(at.getTime())) return at;
  }
  return refuse("Enter when it goes live as a date and time.");
}

/** A time to go live: ahead of now, and within the year. */
function futureOf(value: unknown, now: Date): Date {
  const at = instantOf(value);
  if (!at) refuse("Enter when it goes live.");
  if (at.getTime() <= now.getTime()) refuse("That time has already passed — publish it now, or choose a later time.");
  if (at.getTime() - now.getTime() > AHEAD_MAX_MS) refuse("That is more than a year away — check the date.");
  return at;
}

/**
 * The publish time a save leaves: `keep` (the default for an edit) what it has; `draft` none; `now`
 * this moment — or, for one already live, the moment it went live, so republishing a typo fix doesn't
 * make it new again; `at` a time ahead, which schedules it.
 */
function publishedAtOf(mode: unknown, at: unknown, existing: { publishedAt: Date | null } | null, now: Date): Date | null {
  const m = mode === undefined || mode === null || mode === "" ? (existing ? "keep" : "draft") : mode;
  switch (m) {
    case "keep":
      return existing ? existing.publishedAt : null;
    case "draft":
      return null;
    case "now":
      return existing?.publishedAt && existing.publishedAt.getTime() <= now.getTime() ? existing.publishedAt : now;
    case "at":
      return futureOf(at, now);
    default:
      return refuse("Choose whether to keep it as a draft, publish it now or schedule it.");
  }
}

/**
 * Showing it — live, or scheduled to be — in every workspace at once is the owner's, or needs
 * "publish" typed. The caller has worked out where it will show and from when.
 */
function checkReach(staff: Staff, row: { modules: string[]; countries: string[]; publishedAt: Date | null }, confirm: unknown): void {
  if (row.publishedAt === null || !everywhere(row)) return;
  if (staff.role === "OWNER") return;
  if (String(confirm ?? "").trim() !== "publish") refuse("It shows in every workspace — type publish to confirm, or choose modules or countries.");
}

function after(): void {
  forgetHelpContent();
  revalidateConsole();
}

const iso = (at: Date | null) => (at ? at.toISOString() : null);

// ─── Articles and videos ─────────────────────────────────────────────────────────────────────────

/**
 * Creates an article or a video, or saves changes to one (`id`). `publish`: "draft" (a new one's
 * default), "keep" (an edit's), "now" or "at" with `publishAt` (India time). A new one goes to the
 * end of its kind's list. An archived one can't be edited — restore it first. The kind of an
 * existing one stays what it is.
 */
export async function consoleSaveHelpLink(input: {
  id?: string;
  kind?: string;
  title: string;
  url: string;
  description?: string | null;
  modules?: string[];
  countries?: string[];
  publish?: string;
  publishAt?: string;
  confirm?: string;
}): Promise<ConsoleResult<{ id: string; state: PublicationState }>> {
  return asStaff(MANAGERS, async (staff) => {
    const raw: Record<string, unknown> = input && typeof input === "object" ? input : {};
    const control = controlDb();
    const now = new Date();

    const id = raw.id === undefined || raw.id === null || raw.id === "" ? null : itemId(raw.id);
    const existing = id
      ? await control.platformHelpLink.findUnique({ where: { id }, select: { id: true, kind: true, publishedAt: true, archivedAt: true } })
      : null;
    if (id && !existing) refuse(GONE);
    if (existing?.archivedAt) refuse("An archived item can't be edited — restore it first.");
    const kind = existing ? existing.kind : kindOf(raw.kind);
    if (existing && raw.kind !== undefined && raw.kind !== null && raw.kind !== "" && kindOf(raw.kind) !== existing.kind) {
      refuse(`It is ${existing.kind === "VIDEO" ? "a video" : "an article"} — archive it and add the ${existing.kind === "VIDEO" ? "article" : "video"} instead.`);
    }

    const row = {
      title: titleOf(raw.title),
      url: linkOf(raw.url),
      description: descriptionOf(raw.description),
      modules: modulesOf(raw.modules),
      countries: countriesOf(raw.countries),
      publishedAt: publishedAtOf(raw.publish, raw.publishAt, existing, now),
    };
    checkReach(staff, row, raw.confirm);

    let savedId: string;
    if (existing) {
      // Published, unpublished or archived since it was read: refused rather than undone.
      const done = await control.platformHelpLink.updateMany({
        where: { id: existing.id, archivedAt: null, publishedAt: existing.publishedAt },
        data: { ...row, updatedById: staff.id },
      });
      if (done.count === 0) refuse(CHANGED);
      savedId = existing.id;
    } else {
      const last = await control.platformHelpLink.aggregate({ where: { kind, archivedAt: null }, _max: { sortOrder: true } });
      const sortOrder = Math.min(PLATFORM_HELP_LIMITS.sortOrderMax, (last._max.sortOrder ?? -1) + 1);
      savedId = (await control.platformHelpLink.create({ data: { ...row, kind, sortOrder, createdById: staff.id, updatedById: staff.id }, select: { id: true } })).id;
    }

    const state = publicationState({ publishedAt: row.publishedAt, archivedAt: null }, now);
    await consoleAudit(staff, `help.${WORD[kind]}.${existing ? "update" : "create"}`, {
      id: savedId,
      title: row.title,
      state,
      modules: row.modules.length,
      countries: row.countries.length,
      publishedAt: iso(row.publishedAt),
    });
    after();
    return { id: savedId, state };
  });
}

/**
 * Puts the articles (or videos) in a new order: `ids` is every one of that kind that isn't archived,
 * drafts included, in the order wanted. A list that no longer matches — one added or archived
 * meanwhile — is refused rather than half applied.
 */
export async function consoleReorderHelpLinks(kind: string, ids: string[]): Promise<ConsoleResult<null>> {
  return asStaff(MANAGERS, async (staff) => {
    const k = kindOf(kind);
    const list = idList(ids, ORDER_MAX);
    if (list === null) refuse(`Order at most ${ORDER_MAX} at a time.`);
    const control = controlDb();
    const changed = await control.$transaction(async (tx) => {
      const rows = await tx.platformHelpLink.findMany({ where: { kind: k, archivedAt: null }, select: { id: true, sortOrder: true } });
      const current = new Map(rows.map((r) => [r.id, r.sortOrder]));
      if (rows.length > ORDER_MAX) refuse(`Order at most ${ORDER_MAX} at a time.`);
      if (list.length !== rows.length || list.some((id) => !current.has(id))) refuse("The list changed meanwhile — reload and try again.");
      let moved = 0;
      for (const [i, id] of list.entries()) {
        if (current.get(id) === i) continue;
        const done = await tx.platformHelpLink.updateMany({ where: { id, kind: k, archivedAt: null }, data: { sortOrder: i } });
        if (done.count === 0) refuse("The list changed meanwhile — reload and try again.");
        moved += 1;
      }
      return moved;
    });
    if (changed === 0) return null;

    await consoleAudit(staff, `help.${WORD[k]}.reorder`, { count: list.length, moved: changed });
    after();
    return null;
  });
}

// ─── What's new ──────────────────────────────────────────────────────────────────────────────────

/**
 * Creates a What's new post, or saves changes to one (`id`) — `publish` as for an article. A pinned
 * post shows above the rest while it is live. An archived one can't be edited — restore it first.
 */
export async function consoleSaveHelpPost(input: {
  id?: string;
  title: string;
  body: string;
  linkUrl?: string | null;
  pinned?: boolean;
  modules?: string[];
  countries?: string[];
  publish?: string;
  publishAt?: string;
  confirm?: string;
}): Promise<ConsoleResult<{ id: string; state: PublicationState }>> {
  return asStaff(MANAGERS, async (staff) => {
    const raw: Record<string, unknown> = input && typeof input === "object" ? input : {};
    const control = controlDb();
    const now = new Date();

    const id = raw.id === undefined || raw.id === null || raw.id === "" ? null : itemId(raw.id);
    const existing = id ? await control.platformUpdate.findUnique({ where: { id }, select: { id: true, publishedAt: true, archivedAt: true } }) : null;
    if (id && !existing) refuse(GONE);
    if (existing?.archivedAt) refuse("An archived item can't be edited — restore it first.");

    const link = typeof raw.linkUrl === "string" ? raw.linkUrl.trim() : "";
    const row = {
      title: titleOf(raw.title),
      body: bodyOf(raw.body),
      linkUrl: link ? linkOf(link) : null,
      pinned: raw.pinned === true,
      modules: modulesOf(raw.modules),
      countries: countriesOf(raw.countries),
      publishedAt: publishedAtOf(raw.publish, raw.publishAt, existing, now),
    };
    checkReach(staff, row, raw.confirm);

    let savedId: string;
    if (existing) {
      const done = await control.platformUpdate.updateMany({
        where: { id: existing.id, archivedAt: null, publishedAt: existing.publishedAt },
        data: { ...row, updatedById: staff.id },
      });
      if (done.count === 0) refuse(CHANGED);
      savedId = existing.id;
    } else {
      savedId = (await control.platformUpdate.create({ data: { ...row, createdById: staff.id, updatedById: staff.id }, select: { id: true } })).id;
    }

    const state = publicationState({ publishedAt: row.publishedAt, archivedAt: null }, now);
    await consoleAudit(staff, `help.post.${existing ? "update" : "create"}`, {
      id: savedId,
      title: row.title,
      state,
      pinned: row.pinned,
      modules: row.modules.length,
      countries: row.countries.length,
      publishedAt: iso(row.publishedAt),
    });
    after();
    return { id: savedId, state };
  });
}

// ─── Publishing, taking down, archiving ──────────────────────────────────────────────────────────

type Stored = { id: string; title: string; word: PlatformHelpKindKey | "POST"; modules: string[]; countries: string[]; publishedAt: Date | null; archivedAt: Date | null };

const STORED_SELECT = { id: true, title: true, modules: true, countries: true, publishedAt: true, archivedAt: true } as const;

async function storedItem(item: Item, id: unknown): Promise<Stored> {
  const control = controlDb();
  const key = itemId(id);
  if (item === "link") {
    const row = await control.platformHelpLink.findUnique({ where: { id: key }, select: { ...STORED_SELECT, kind: true } });
    if (!row) refuse(GONE);
    return { ...row, word: row.kind };
  }
  const row = await control.platformUpdate.findUnique({ where: { id: key }, select: STORED_SELECT });
  if (!row) refuse(GONE);
  return { ...row, word: "POST" };
}

/**
 * Sets the publication fields of one item, provided they are still what was read — a change made
 * meanwhile is refused, not overwritten.
 */
async function writePublication(item: Item, row: Stored, staff: Staff, data: { publishedAt?: Date | null; archivedAt?: Date | null; sortOrder?: number }): Promise<void> {
  const control = controlDb();
  const where = { id: row.id, publishedAt: row.publishedAt, archivedAt: row.archivedAt };
  const done =
    item === "link"
      ? await control.platformHelpLink.updateMany({ where, data: { ...data, updatedById: staff.id } })
      : await control.platformUpdate.updateMany({ where, data: { publishedAt: data.publishedAt, archivedAt: data.archivedAt, updatedById: staff.id } });
  if (done.count === 0) refuse(CHANGED);
}

/**
 * Makes a draft or a scheduled item live now — or, with `at` (India time), schedules it. Showing it
 * in every workspace needs the owner, or "publish" typed (`confirm`).
 */
export async function consolePublishHelpItem(item: "link" | "post", id: string, input?: { at?: string; confirm?: string }): Promise<ConsoleResult<{ state: PublicationState }>> {
  return asStaff(MANAGERS, async (staff) => {
    const which = itemOf(item);
    const row = await storedItem(which, id);
    const now = new Date();
    const state = publicationState(row, now);
    if (state === "archived") refuse("It is archived — restore it first.");
    const options: Record<string, unknown> = input && typeof input === "object" ? input : {};
    const at = instantOf(options.at) ? futureOf(options.at, now) : null;
    if (state === "live") refuse(at ? "It is already live — take it down first to schedule it." : "It is already live.");

    const publishedAt = at ?? now;
    checkReach(staff, { modules: row.modules, countries: row.countries, publishedAt }, options.confirm);
    await writePublication(which, row, staff, { publishedAt });

    const next = at ? "scheduled" : "live";
    await consoleAudit(staff, `help.${WORD[row.word]}.${at ? "schedule" : "publish"}`, { id: row.id, title: row.title, publishedAt: publishedAt.toISOString() });
    after();
    return { state: next };
  });
}

/** Takes a live or scheduled item down: it goes back to the drafts, and stops showing. */
export async function consoleUnpublishHelpItem(item: "link" | "post", id: string): Promise<ConsoleResult<null>> {
  return asStaff(MANAGERS, async (staff) => {
    const which = itemOf(item);
    const row = await storedItem(which, id);
    const state = publicationState(row, new Date());
    if (state === "archived") refuse("It is archived, so it isn't showing anywhere.");
    if (state === "draft") refuse(`It is a draft — the ${WORD[row.word]} isn't showing anywhere.`);

    await writePublication(which, row, staff, { publishedAt: null });
    await consoleAudit(staff, `help.${WORD[row.word]}.unpublish`, { id: row.id, title: row.title, was: state });
    after();
    return null;
  });
}

/** Files it away: it stops showing (if it still was) and moves to Archived, where it can't be edited. */
export async function consoleArchiveHelpItem(item: "link" | "post", id: string): Promise<ConsoleResult<null>> {
  return asStaff(MANAGERS, async (staff) => {
    const which = itemOf(item);
    const row = await storedItem(which, id);
    const state = publicationState(row, new Date());
    if (state === "archived") refuse("It is already archived.");

    await writePublication(which, row, staff, { archivedAt: new Date() });
    await consoleAudit(staff, `help.${WORD[row.word]}.archive`, { id: row.id, title: row.title, was: state });
    after();
    return null;
  });
}

/** Brings an archived item back as a draft — an article or video at the end of its list. Nothing shows until it is published again. */
export async function consoleRestoreHelpItem(item: "link" | "post", id: string): Promise<ConsoleResult<null>> {
  return asStaff(MANAGERS, async (staff) => {
    const which = itemOf(item);
    const row = await storedItem(which, id);
    if (!row.archivedAt) refuse("It isn't archived.");

    let sortOrder: number | undefined;
    if (which === "link" && row.word !== "POST") {
      const last = await controlDb().platformHelpLink.aggregate({ where: { kind: row.word, archivedAt: null }, _max: { sortOrder: true } });
      sortOrder = Math.min(PLATFORM_HELP_LIMITS.sortOrderMax, (last._max.sortOrder ?? -1) + 1);
    }
    await writePublication(which, row, staff, { archivedAt: null, publishedAt: null, ...(sortOrder === undefined ? {} : { sortOrder }) });
    await consoleAudit(staff, `help.${WORD[row.word]}.restore`, { id: row.id, title: row.title });
    after();
    return null;
  });
}

// ─── The editor's preview ────────────────────────────────────────────────────────────────────────

/**
 * How many open workspaces a choice of modules and countries reaches now, of how many, and up to ten
 * of their addresses — worked out by the very rule a workspace reads by (`reachesWorkspace`), from the
 * plans already on each workspace's row. Lenient where the save is strict: a key that can't be one is
 * left out, not refused. A read — not audited.
 */
export async function consoleHelpReach(modules: string[], countries: string[]): Promise<ConsoleResult<{ count: number; total: number; sample: string[]; capped: boolean }>> {
  return asStaff(MANAGERS, async () => {
    const pick = (input: unknown, ok: (v: string) => boolean, max: number) =>
      [...new Set((Array.isArray(input) ? input.slice(0, max * 5) : []).filter((v): v is string => typeof v === "string").map((v) => v.trim()))].filter(ok).slice(0, max);
    const targeting = {
      modules: pick(modules, (k) => /^[a-z][a-z0-9_]{0,39}$/.test(k), PLATFORM_HELP_LIMITS.modules),
      countries: pick(countries, (c) => /^[A-Za-z]{2}$/.test(c), PLATFORM_HELP_LIMITS.countries).map((c) => c.toUpperCase()),
    };
    const tenants = await controlDb().tenant.findMany({
      where: { status: "ACTIVE" },
      orderBy: { slug: "asc" },
      take: REACH_TENANTS_MAX,
      select: { slug: true, country: true, entitlements: true },
    });
    const reached = tenants.filter((t) => reachesWorkspace(targeting, { country: t.country, entitlements: parseEntitlements(t.entitlements) }));
    return { count: reached.length, total: tenants.length, sample: reached.slice(0, SAMPLE_SIZE).map((t) => t.slug), capped: tenants.length >= REACH_TENANTS_MAX };
  });
}

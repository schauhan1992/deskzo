import Papa from "papaparse";
import type { SiteRedirect } from "@deskzo/control-client";
import { actorRef, cmsAudit, refLabels, type CmsActor } from "@/lib/cms/audit";
import {
  chainProblems,
  checkRedirectShape,
  findRule,
  followChain,
  indexRules,
  normalisePath,
  reservedSource,
  targetFor,
  type RedirectShape,
  type RuleIndex,
  type RuleLike,
} from "@/lib/cms/redirect-rules";
import {
  CMS_PUBLISHERS,
  CmsRefused,
  MAX_REDIRECTS,
  REDIRECT_IMPORT_MAX_ROWS,
  type AutoRedirect,
  type CmsIssue,
  type CmsMe,
  type Paged,
  type RedirectChain,
  type RedirectCheck,
  type RedirectFilters,
  type RedirectImportResult,
  type RedirectImportRow,
  type RedirectInput,
  type RedirectRow,
  type RedirectStatus,
} from "@/lib/cms/types";
import { csvFilename } from "@/lib/console-shared/format";
import { consoleClock } from "@/lib/platform/console-clock";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { PLATFORM_DOMAIN } from "@/lib/tenancy/host";

export { normalisePath, redirectablePath, reservedSource } from "@/lib/cms/redirect-rules";

/**
 * The CMS's redirect manager (spec §1.5–§1.10): redirects from old addresses on the public site to
 * new ones, kept in the control plane (site_redirects) and applied by the proxy on the public site's
 * own hosts only (src/proxy.ts).
 *
 *   · Editors and admins manage them; only an admin may send visitors to another site (a redirect
 *     from our address to an outside one is a phishing risk). Every change is in the CMS's activity
 *     log: redirect.create / update / delete / import.
 *   · On save: the source is keyed and allowed (./redirect-rules.ts), no second redirect from the
 *     same address, at most 5,000 in all, no loop at any depth up to 10, and no chain of more than
 *     three in a row. Chains of two or three are allowed and flagged in the list.
 *   · `autoRedirect` is the 301 a slug change leaves behind (a published post or page, a category or
 *     tag with posts on the site): it updates a redirect from the old address rather than adding a
 *     second, and never fails the change that asked for it.
 *   · The proxy's lookup (`matchRedirect`) reads a map of the enabled redirects kept in this process:
 *     reloaded every 60 seconds and, in the process that saved, at once. It never throws and never
 *     waits long — a slow or failed database means no redirect, not a broken page. Hits are counted
 *     in memory and written once a minute per redirect (`recordHit`).
 */

const actorOf = (me: CmsMe): CmsActor => ({ kind: "cms", id: me.id, name: me.name, email: me.email });
const EXTERNAL_ADMIN_ONLY = "Only an admin can send visitors to another site: a redirect from our address to an outside one is a phishing risk.";
const LIST_PAGE_SIZE = 50;
const CSV_FIELDS = ["from", "to", "status", "match", "note"];
const CSV_MAX_CHARS = 1_000_000;

function assertPublisher(me: CmsMe): void {
  if (!CMS_PUBLISHERS.includes(me.role)) throw new CmsRefused("Your role cannot do that.");
}

/** The public site's own hosts: an https:// target on one of them is stored as a path. */
function ownHosts(): string[] {
  const names = [PLATFORM_DOMAIN, `www.${PLATFORM_DOMAIN}`];
  const port = process.env.PLATFORM_PORT?.trim();
  return port ? [...names, ...names.map((n) => `${n}:${port}`)] : names;
}

const isExternal = (toUrl: string) => !toUrl.startsWith("/");
const ruleOf = (r: Pick<SiteRedirect, "id" | "fromPath" | "toUrl" | "match">): RuleLike => ({ id: r.id, fromPath: r.fromPath, toUrl: r.toUrl, match: r.match });

function refusal(issues: CmsIssue[]): CmsRefused {
  return new CmsRefused(issues.length === 1 ? issues[0].message : "Some fields need attention.", { issues });
}

// ─── Reading ─────────────────────────────────────────────────────────────────────────────────────

/** Where a visitor ends up from each enabled redirect, for those that pass through two or more. */
function chainsOf(rows: SiteRedirect[]): Map<string, RedirectChain> {
  const enabled = rows.filter((r) => r.enabled).map(ruleOf);
  const index = indexRules(enabled);
  const chains = new Map<string, RedirectChain>();
  for (const rule of enabled) {
    const walk = followChain(index, rule);
    if (walk.hops >= 2 || walk.loop) chains.set(rule.id, { hops: walk.hops, final: walk.final, loop: walk.loop, through: walk.through });
  }
  return chains;
}

function rowOf(r: SiteRedirect, labels: Map<string, string>, chains: Map<string, RedirectChain>): RedirectRow {
  return {
    id: r.id,
    fromPath: r.fromPath,
    toUrl: r.toUrl,
    status: r.status as RedirectStatus,
    match: r.match,
    enabled: r.enabled,
    automatic: r.automatic,
    note: r.note,
    hits: r.hits,
    lastHitAt: r.lastHitAt,
    external: isExternal(r.toUrl),
    chain: chains.get(r.id) ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    updatedBy: labels.get(r.updatedBy) ?? r.updatedBy,
  };
}

async function allRedirects(): Promise<SiteRedirect[]> {
  return controlDb().siteRedirect.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
}

async function redirectOrRefuse(id: string): Promise<SiteRedirect> {
  const row = /^[a-z0-9]{20,40}$/.test(String(id ?? "")) ? await controlDb().siteRedirect.findUnique({ where: { id } }) : null;
  if (!row) throw new CmsRefused("That redirect no longer exists.");
  return row;
}

/**
 * The redirect list: filtered, sorted ("recent": last changed first — the default; "from": by
 * address; "hits": most used first), 50 a page, each with its chain when it has one. `used` of
 * `max`: how many redirects there are of the 5,000 allowed.
 */
export async function listRedirects(filters: RedirectFilters = {}): Promise<Paged<RedirectRow> & { used: number; max: number }> {
  const page = Math.max(1, Math.floor(Number(filters.page) || 1));
  const all = await allRedirects();
  const chains = chainsOf(all);
  const q = typeof filters.q === "string" ? filters.q.trim().toLowerCase().slice(0, 200) : "";
  const matching = all.filter(
    (r) =>
      (!q || r.fromPath.includes(q) || r.toUrl.toLowerCase().includes(q) || (r.note ?? "").toLowerCase().includes(q)) &&
      (filters.match === undefined || r.match === filters.match) &&
      (filters.enabled === undefined || r.enabled === filters.enabled) &&
      (filters.automatic === undefined || r.automatic === filters.automatic) &&
      (filters.external === undefined || isExternal(r.toUrl) === filters.external) &&
      (filters.chained === undefined || chains.has(r.id) === filters.chained),
  );
  const sort = filters.sort === "from" || filters.sort === "hits" ? filters.sort : "recent";
  matching.sort((a, b) =>
    sort === "from"
      ? a.fromPath.localeCompare(b.fromPath)
      : sort === "hits"
        ? b.hits - a.hits || a.fromPath.localeCompare(b.fromPath)
        : b.updatedAt.getTime() - a.updatedAt.getTime() || a.fromPath.localeCompare(b.fromPath),
  );
  const slice = matching.slice((page - 1) * LIST_PAGE_SIZE, page * LIST_PAGE_SIZE);
  const labels = await refLabels(slice.map((r) => r.updatedBy));
  return { rows: slice.map((r) => rowOf(r, labels, chains)), total: matching.length, page, pageSize: LIST_PAGE_SIZE, used: all.length, max: MAX_REDIRECTS };
}

export async function getRedirect(id: string): Promise<RedirectRow> {
  const row = await redirectOrRefuse(id);
  const enabled = await controlDb().siteRedirect.findMany({ where: { enabled: true }, select: { id: true, fromPath: true, toUrl: true, match: true } });
  const chains = chainsOf(row.enabled ? enabled.map((r) => ({ ...row, ...r, enabled: true })) : []);
  const labels = await refLabels([row.updatedBy]);
  return rowOf(row, labels, chains);
}

// ─── Checking ────────────────────────────────────────────────────────────────────────────────────

type Evaluated = RedirectCheck & { shape: RedirectShape | null };

/**
 * A redirect as it would be saved: its shape, then what needs the database — another redirect from
 * the same address, the 5,000 limit (for a new one), another site's address (admins only, unless
 * `allowExternal`), and loops and long chains (when `structural`: its source, target, match or
 * enabled state change).
 */
async function evaluate(input: RedirectInput, me: CmsMe, current: SiteRedirect | null, opts: { allowExternal?: boolean; structural?: boolean } = {}): Promise<Evaluated> {
  const checked = checkRedirectShape(input ?? {}, { ownHosts: ownHosts() });
  const issues = [...checked.issues];
  const shape = checked.ok ? checked.value : null;
  if (checked.value.external && me.role !== "ADMIN" && !opts.allowExternal) issues.push({ path: "to", message: EXTERNAL_ADMIN_ONLY });
  let existingId: string | null = null;
  if (checked.value.fromPath) {
    const other = await controlDb().siteRedirect.findUnique({ where: { fromPath: checked.value.fromPath }, select: { id: true } });
    if (other && other.id !== current?.id) {
      existingId = other.id;
      issues.push({ path: "from", message: "There is already a redirect from that address. Change that one instead." });
    }
  }
  if (!current && (await controlDb().siteRedirect.count()) >= MAX_REDIRECTS) {
    issues.push({ path: "", message: `There are ${MAX_REDIRECTS.toLocaleString("en-IN")} redirects already, the most there can be. Delete some you no longer need first.` });
  }
  let chain: RedirectChain | null = null;
  if (shape && shape.enabled && issues.length === 0) {
    const id = current?.id ?? "new";
    const enabled = await controlDb().siteRedirect.findMany({ where: { enabled: true }, select: { id: true, fromPath: true, toUrl: true, match: true } });
    const self: RuleLike = { id, fromPath: shape.fromPath, toUrl: shape.toUrl, match: shape.match };
    const rules = [...enabled.filter((r) => r.id !== id).map(ruleOf), self];
    if (opts.structural !== false) {
      const problem = chainProblems(rules, new Set([id])).get(id);
      if (problem) issues.push({ path: "to", message: problem });
    }
    const walk = followChain(indexRules(rules), self);
    if (walk.hops >= 2 || walk.loop) chain = { hops: walk.hops, final: walk.final, loop: walk.loop, through: walk.through };
  }
  return {
    ok: issues.length === 0,
    issues,
    normalised: shape ? { fromPath: shape.fromPath, toUrl: shape.toUrl, match: shape.match, status: shape.status, external: shape.external } : null,
    existingId,
    chain,
    shape,
  };
}

/**
 * The redirect dialog's live checks: the redirect as it would be saved and everything wrong with it,
 * nothing written. `exceptId`: the redirect being edited.
 */
export async function checkRedirect(input: RedirectInput, me: CmsMe, exceptId?: string | null): Promise<RedirectCheck> {
  assertPublisher(me);
  const current = exceptId ? await redirectOrRefuse(exceptId) : null;
  const result = await evaluate(input, me, current, { allowExternal: current ? externalAllowed(me, current, input) : false });
  return { ok: result.ok, issues: result.issues, normalised: result.normalised, existingId: result.existingId, chain: result.chain };
}

/** An editor may change a redirect to another site only by its note, or switch it off. */
function externalAllowed(me: CmsMe, current: SiteRedirect, merged: RedirectInput): boolean {
  if (me.role === "ADMIN") return true;
  if (!isExternal(current.toUrl)) return false;
  const shape = checkRedirectShape(merged, { ownHosts: ownHosts() }).value;
  const same = shape.fromPath === current.fromPath && shape.toUrl === current.toUrl && shape.match === current.match && shape.status === current.status;
  return same && !(merged.enabled !== false && !current.enabled);
}

// ─── Changing ────────────────────────────────────────────────────────────────────────────────────

export async function createRedirect(input: RedirectInput, me: CmsMe): Promise<RedirectRow> {
  assertPublisher(me);
  const check = await evaluate(input, me, null);
  if (!check.ok || !check.shape) throw refusal(check.issues);
  const s = check.shape;
  const row = await controlDb().siteRedirect.create({
    data: { fromPath: s.fromPath, toUrl: s.toUrl, status: s.status, match: s.match, enabled: s.enabled, note: s.note, updatedBy: actorRef(actorOf(me)) },
    select: { id: true },
  });
  invalidateRedirects();
  await cmsAudit(actorOf(me), "redirect.create", "redirect", row.id, { from: s.fromPath, to: s.toUrl, status: s.status, match: s.match, ...(s.enabled ? {} : { enabled: false }) });
  return getRedirect(row.id);
}

/** Changes a redirect: only the fields given; a new `from` without `match` takes its match from its "/*". */
export async function updateRedirect(id: string, input: Partial<RedirectInput>, me: CmsMe): Promise<RedirectRow> {
  assertPublisher(me);
  const current = await redirectOrRefuse(id);
  const merged: RedirectInput = {
    from: input?.from !== undefined ? String(input.from ?? "") : current.fromPath,
    to: input?.to !== undefined ? String(input.to ?? "") : current.toUrl,
    status: input?.status !== undefined ? input.status : current.status,
    match: input?.match !== undefined ? input.match : input?.from !== undefined ? undefined : current.match,
    note: input?.note !== undefined ? input.note : current.note,
    enabled: input?.enabled !== undefined ? input.enabled !== false : current.enabled,
  };
  const shapeNow = checkRedirectShape(merged, { ownHosts: ownHosts() }).value;
  const structural = shapeNow.fromPath !== current.fromPath || shapeNow.toUrl !== current.toUrl || shapeNow.match !== current.match || (merged.enabled !== false && !current.enabled);
  const check = await evaluate(merged, me, current, { allowExternal: externalAllowed(me, current, merged), structural });
  if (!check.ok || !check.shape) throw refusal(check.issues);
  const s = check.shape;
  const changed = [
    s.fromPath !== current.fromPath && "from",
    s.toUrl !== current.toUrl && "to",
    s.status !== current.status && "status",
    s.match !== current.match && "match",
    s.enabled !== current.enabled && "enabled",
    (s.note ?? null) !== (current.note ?? null) && "note",
  ].filter((f): f is string => !!f);
  if (!changed.length) return getRedirect(current.id);
  await controlDb().siteRedirect.update({
    where: { id: current.id },
    data: { fromPath: s.fromPath, toUrl: s.toUrl, status: s.status, match: s.match, enabled: s.enabled, note: s.note, updatedBy: actorRef(actorOf(me)) },
  });
  invalidateRedirects();
  await cmsAudit(actorOf(me), "redirect.update", "redirect", current.id, {
    from: s.fromPath,
    to: s.toUrl,
    changed,
    ...(s.fromPath !== current.fromPath ? { fromBefore: current.fromPath } : {}),
    ...(s.toUrl !== current.toUrl ? { toBefore: current.toUrl } : {}),
    ...(s.enabled !== current.enabled ? { enabled: s.enabled } : {}),
  });
  return getRedirect(current.id);
}

export async function deleteRedirect(id: string, me: CmsMe): Promise<void> {
  assertPublisher(me);
  const current = await redirectOrRefuse(id);
  await controlDb().siteRedirect.delete({ where: { id: current.id } });
  invalidateRedirects();
  await cmsAudit(actorOf(me), "redirect.delete", "redirect", current.id, { from: current.fromPath, to: current.toUrl, automatic: current.automatic });
}

/**
 * A redirect from `from` to `to`, made or — when one from that address exists — changed (enabled,
 * 301 unless given). For "delete this post, and send its visitors to …". Checked like any other.
 */
export async function saveRedirectFrom(input: RedirectInput, me: CmsMe): Promise<RedirectRow> {
  assertPublisher(me);
  const key = normalisePath(input?.from);
  const existing = key ? await controlDb().siteRedirect.findUnique({ where: { fromPath: key }, select: { id: true } }) : null;
  return existing ? updateRedirect(existing.id, { ...input, enabled: true }, me) : createRedirect(input, me);
}

// ─── Made by the CMS itself ──────────────────────────────────────────────────────────────────────

let lastFailureLog = 0;

function logFailure(what: string, err: unknown): void {
  const now = Date.now();
  if (now - lastFailureLog < 10 * 60_000) return;
  lastFailureLog = now;
  const code = (err as { code?: string } | null)?.code;
  console.warn(`[redirects] ${what}: ${code ?? (err instanceof Error ? err.name : "error")}`);
}

class LoopRefused extends Error {}

/**
 * The 301 an address change leaves behind: from `oldPath` to `newPath` (both site paths), marked as
 * made automatically. Never a second redirect from one address, and never a loop:
 *
 *   · a redirect from the new address is taken away (made automatically: deleted — one made by hand:
 *     switched off), since the new address has a page now — changing an address back re-uses the one
 *     that pointed the other way instead of adding another;
 *   · a redirect from the old address is updated to point at the new one;
 *   · redirects made automatically that pointed at the old address now point at the new one (no chain).
 *
 * Returns what was made or changed, or null when nothing was (the same address, a path that can't be
 * redirected, the 5,000 limit, a loop, or a database failure — which is logged, never thrown: the
 * change that asked for it has happened either way).
 */
export async function autoRedirect(oldPath: string, newPath: string, by: CmsActor): Promise<AutoRedirect | null> {
  try {
    if (!controlConfigured()) return null;
    const from = normalisePath(oldPath);
    const toKey = normalisePath(newPath);
    const to = toKey && newPath.startsWith("/") ? (newPath.split(/[?#]/)[0].replace(/\/+$/, "") || "/") : null;
    if (!from || !toKey || !to || from === toKey || from.includes("*") || reservedSource(from)) return null;
    const ref = actorRef(by);
    const note = "Created automatically when the address changed.";
    const done = await controlDb().$transaction(async (tx) => {
      const atNew = await tx.siteRedirect.findUnique({ where: { fromPath: toKey } });
      const atOld = await tx.siteRedirect.findUnique({ where: { fromPath: from } });
      const released: { id: string; deleted: boolean }[] = [];
      let saved: { id: string; created: boolean };
      if (atNew && atNew.automatic && !atOld) {
        await tx.siteRedirect.update({ where: { id: atNew.id }, data: { fromPath: from, toUrl: to, status: 301, match: "EXACT", enabled: true, updatedBy: ref } });
        saved = { id: atNew.id, created: false };
      } else {
        if (atNew) {
          if (atNew.automatic) await tx.siteRedirect.delete({ where: { id: atNew.id } });
          else if (atNew.enabled) await tx.siteRedirect.update({ where: { id: atNew.id }, data: { enabled: false, updatedBy: ref } });
          if (atNew.automatic || atNew.enabled) released.push({ id: atNew.id, deleted: atNew.automatic });
        }
        if (atOld) {
          await tx.siteRedirect.update({ where: { id: atOld.id }, data: { toUrl: to, status: 301, match: "EXACT", enabled: true, automatic: true, updatedBy: ref } });
          saved = { id: atOld.id, created: false };
        } else {
          if ((await tx.siteRedirect.count()) >= MAX_REDIRECTS) throw new LoopRefused("limit");
          const made = await tx.siteRedirect.create({ data: { fromPath: from, toUrl: to, status: 301, match: "EXACT", automatic: true, note, updatedBy: ref }, select: { id: true } });
          saved = { id: made.id, created: true };
        }
      }
      await tx.siteRedirect.updateMany({ where: { automatic: true, match: "EXACT", toUrl: from, id: { not: saved.id }, fromPath: { not: toKey } }, data: { toUrl: to, updatedBy: ref } });
      const enabled = await tx.siteRedirect.findMany({ where: { enabled: true }, select: { id: true, fromPath: true, toUrl: true, match: true } });
      const problem = chainProblems(enabled.map(ruleOf), new Set([saved.id]), Number.MAX_SAFE_INTEGER).get(saved.id);
      if (problem) throw new LoopRefused(problem);
      return { saved, released };
    });
    invalidateRedirects();
    for (const r of done.released) {
      await cmsAudit(by, r.deleted ? "redirect.delete" : "redirect.update", "redirect", r.id, { from: toKey, reason: "The address has a page again.", ...(r.deleted ? { automatic: true } : { enabled: false }) });
    }
    await cmsAudit(by, done.saved.created ? "redirect.create" : "redirect.update", "redirect", done.saved.id, { from, to, status: 301, automatic: true });
    return { id: done.saved.id, from, to, created: done.saved.created };
  } catch (err) {
    if (!(err instanceof LoopRefused)) logFailure("an automatic redirect was not made", err);
    return null;
  }
}

/**
 * A page or post has just gone live at `path`: an EXACT redirect from there would hide it, so it
 * stops — one made automatically is deleted, one made by hand switched off (both in the activity
 * log). Never throws.
 */
export async function releasePath(path: string, by: CmsActor): Promise<void> {
  try {
    if (!controlConfigured()) return;
    const key = normalisePath(path);
    if (!key) return;
    const row = await controlDb().siteRedirect.findUnique({ where: { fromPath: key } });
    if (!row || !row.enabled) return;
    if (row.automatic) await controlDb().siteRedirect.delete({ where: { id: row.id } });
    else await controlDb().siteRedirect.update({ where: { id: row.id }, data: { enabled: false, updatedBy: actorRef(by) } });
    invalidateRedirects();
    await cmsAudit(by, row.automatic ? "redirect.delete" : "redirect.update", "redirect", row.id, { from: row.fromPath, to: row.toUrl, reason: "The address has a page again.", ...(row.automatic ? { automatic: true } : { enabled: false }) });
  } catch (err) {
    logFailure("a redirect in front of a new page was not switched off", err);
  }
}

// ─── CSV ─────────────────────────────────────────────────────────────────────────────────────────

/** Every redirect as CSV — from, to, status, match, note — guarded against formulas, CRLF lines; the file dated on the console's clock. */
export async function exportRedirectsCsv(me: CmsMe, now = new Date()): Promise<{ filename: string; csv: string; rows: number }> {
  assertPublisher(me);
  const [rows, clock] = await Promise.all([controlDb().siteRedirect.findMany({ orderBy: { fromPath: "asc" } }), consoleClock()]);
  const data = rows.map((r) => [r.fromPath, r.toUrl, r.status, r.match.toLowerCase(), r.note ?? ""]);
  return { filename: csvFilename("redirects", now, clock), csv: Papa.unparse({ fields: CSV_FIELDS, data }, { escapeFormulae: true, newline: "\r\n" }), rows: rows.length };
}

type CsvRow = { line: number; from: string; to: string; status: string; match: string; note: string };

/** Undoes the export's formula guard: a leading ' before = + - @ tab or CR is not part of the value. */
const unguard = (value: unknown) => {
  const s = typeof value === "string" ? value : "";
  return /^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s;
};

function parseCsv(text: string): CsvRow[] {
  let clean = typeof text === "string" ? text : "";
  if (clean.charCodeAt(0) === 0xfeff) clean = clean.slice(1);
  if (!clean.trim()) throw new CmsRefused("The file is empty.");
  if (clean.length > CSV_MAX_CHARS) throw new CmsRefused(`That file is too big: at most ${REDIRECT_IMPORT_MAX_ROWS.toLocaleString("en-IN")} redirects in one file.`);
  const parsed = Papa.parse<Record<string, unknown>>(clean, { header: true, skipEmptyLines: "greedy", transformHeader: (h) => h.trim().toLowerCase() });
  const fields = parsed.meta.fields ?? [];
  if (!fields.includes("from") || !fields.includes("to")) throw new CmsRefused("The file needs a header row with “from” and “to” (and, if you like, “status”, “match” and “note”).");
  const broken = parsed.errors.find((e) => e.type === "Quotes" || e.type === "Delimiter");
  if (broken) throw new CmsRefused(`The file isn't valid CSV${typeof broken.row === "number" ? ` (row ${broken.row + 2})` : ""}.`);
  if (parsed.data.length > REDIRECT_IMPORT_MAX_ROWS) {
    throw new CmsRefused(`At most ${REDIRECT_IMPORT_MAX_ROWS.toLocaleString("en-IN")} redirects in one file; this one has ${parsed.data.length.toLocaleString("en-IN")}. Split it.`);
  }
  return parsed.data.map((r, i) => ({ line: i + 2, from: unguard(r.from).trim(), to: unguard(r.to).trim(), status: unguard(r.status).trim(), match: unguard(r.match).trim(), note: unguard(r.note) }));
}

type Planned = { row: RedirectImportRow; shape: RedirectShape; current: SiteRedirect | null; key: string };

/** What importing a file would do, row by row — nothing written. */
async function planImport(text: string, me: CmsMe): Promise<{ rows: RedirectImportRow[]; planned: Planned[] }> {
  assertPublisher(me);
  const raw = parseCsv(text);
  const existing = await allRedirects();
  const byFrom = new Map(existing.map((r) => [r.fromPath, r]));
  const seen = new Map<string, number>();
  let room = MAX_REDIRECTS - existing.length;
  const rows: RedirectImportRow[] = [];
  const planned: Planned[] = [];
  for (const r of raw) {
    const row: RedirectImportRow = { line: r.line, from: r.from, to: r.to, status: r.status && Number.isFinite(Number(r.status)) ? Number(r.status) : null, match: null, note: r.note.trim() || null, outcome: "refuse", reason: null, id: null };
    rows.push(row);
    const checked = checkRedirectShape({ from: r.from, to: r.to, status: r.status || undefined, match: r.match || undefined, note: r.note }, { ownHosts: ownHosts() });
    if (!checked.ok) {
      row.reason = checked.issues.map((i) => i.message).join(" ");
      continue;
    }
    const s = checked.value;
    Object.assign(row, { from: s.fromPath, to: s.toUrl, status: s.status, match: s.match, note: s.note });
    const first = seen.get(s.fromPath);
    if (first !== undefined) {
      row.reason = `The same address as row ${first}.`;
      continue;
    }
    seen.set(s.fromPath, row.line);
    const current = byFrom.get(s.fromPath) ?? null;
    row.id = current?.id ?? null;
    if (current && current.toUrl === s.toUrl && current.status === s.status && current.match === s.match && (current.note ?? null) === s.note) {
      row.outcome = "unchanged";
      continue;
    }
    if (s.external && me.role !== "ADMIN") {
      row.reason = EXTERNAL_ADMIN_ONLY;
      continue;
    }
    if (!current) {
      if (room <= 0) {
        row.reason = `The ${MAX_REDIRECTS.toLocaleString("en-IN")}-redirect limit is reached.`;
        continue;
      }
      room -= 1;
    }
    row.outcome = current ? "update" : "create";
    planned.push({ row, shape: s, current, key: current?.id ?? `new:${row.line}` });
  }
  // Loops and long chains, over the redirects the site would then have: refuse those taking part, and look again.
  for (let pass = 0; pass < 50; pass++) {
    const active = planned.filter((p) => p.row.outcome !== "refuse");
    const byKey = new Map(active.map((p) => [p.key, p]));
    const rules: RuleLike[] = [
      ...existing.filter((r) => r.enabled && !byKey.has(r.id)).map(ruleOf),
      ...active.filter((p) => !p.current || p.current.enabled).map((p) => ({ id: p.key, fromPath: p.shape.fromPath, toUrl: p.shape.toUrl, match: p.shape.match })),
    ];
    const problems = chainProblems(rules, new Set(byKey.keys()));
    if (!problems.size) break;
    for (const [key, message] of problems) {
      const p = byKey.get(key)!;
      p.row.outcome = "refuse";
      p.row.reason = message;
    }
  }
  return { rows, planned: planned.filter((p) => p.row.outcome !== "refuse") };
}

const countsOf = (rows: RedirectImportRow[]) => ({
  create: rows.filter((r) => r.outcome === "create").length,
  update: rows.filter((r) => r.outcome === "update").length,
  unchanged: rows.filter((r) => r.outcome === "unchanged").length,
  refuse: rows.filter((r) => r.outcome === "refuse").length,
});

/** An import's preview: each row as it would be created, updated, left unchanged or refused (and why). Nothing written. */
export async function previewRedirectImport(text: string, me: CmsMe): Promise<RedirectImportResult> {
  const { rows } = await planImport(text, me);
  return { rows, counts: countsOf(rows), applied: false };
}

/**
 * Imports a file (columns from, to, status, match, note; at most 1,000 rows): what the preview would
 * create or update is written, in one transaction; refused rows are skipped. A new redirect is
 * enabled; an updated one keeps its enabled state and whether it was made automatically.
 */
export async function importRedirects(text: string, me: CmsMe): Promise<RedirectImportResult> {
  const { rows, planned } = await planImport(text, me);
  const ref = actorRef(actorOf(me));
  if (planned.length) {
    await controlDb().$transaction(
      async (tx) => {
        for (const p of planned) {
          const data = { toUrl: p.shape.toUrl, status: p.shape.status, match: p.shape.match, note: p.shape.note, updatedBy: ref };
          if (p.current) await tx.siteRedirect.update({ where: { id: p.current.id }, data, select: { id: true } });
          else p.row.id = (await tx.siteRedirect.create({ data: { ...data, fromPath: p.shape.fromPath }, select: { id: true } })).id;
        }
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    invalidateRedirects();
  }
  const counts = countsOf(rows);
  await cmsAudit(actorOf(me), "redirect.import", "redirect", null, { rows: rows.length, created: counts.create, updated: counts.update, unchanged: counts.unchanged, refused: counts.refuse });
  return { rows, counts, applied: true };
}

// ─── The proxy's lookup ──────────────────────────────────────────────────────────────────────────

/** How long the map is used before it is read again. */
export const REDIRECT_MAP_TTL_MS = 60_000;
/** How long a request may wait for the map when this process has none (its first request, or after a save). */
export const REDIRECT_LOOKUP_WAIT_MS = 250;
/** After a failed read, how long before the database is asked again. */
const RETRY_AFTER_FAILURE_MS = 10_000;
/** A read still running after this is given up on, so one hung connection can't stop redirects for good. */
const LOAD_GIVE_UP_MS = 30_000;
export const REDIRECT_HIT_FLUSH_MS = 60_000;

type LookupRule = RuleLike & { status: RedirectStatus };
type LoadedMap = { generation: number; at: number; index: RuleIndex<LookupRule> };
type Loading = { generation: number; since: number; promise: Promise<RuleIndex<LookupRule> | null> };

/** This process's map of enabled redirects (the proxy's copy), a read in progress, and the last failure. */
let loadedMap: LoadedMap | null = null;
let loadingMap: Loading | null = null;
let lastLoadFailure = 0;
/** Set only by check scripts: where the map comes from instead of the database. */
let testLoader: (() => Promise<LookupRule[]>) | null = null;

/**
 * Saves bump a counter kept on `globalThis`: the proxy is bundled apart from the CMS's actions, so a
 * module-level flag set by a save would never reach the proxy's copy of this module. The counter is
 * the one thing both share; the proxy's map notices it on its next lookup and is read again.
 */
const GENERATION = Symbol.for("deskzo.site-redirects.generation");
const generationNow = () => (globalThis as Record<symbol, number | undefined>)[GENERATION] ?? 0;

/** Every process-local copy of the map is out of date: read it again on the next lookup. Called by every save. */
export function invalidateRedirects(): void {
  (globalThis as Record<symbol, number | undefined>)[GENERATION] = generationNow() + 1;
}

/** For check scripts: the redirects the lookup sees, instead of the database's (null: the database again). */
export function setTestRedirectLoader(loader: (() => Promise<{ id: string; fromPath: string; toUrl: string; match: "EXACT" | "PREFIX"; status: number }[]>) | null): void {
  testLoader = loader ? async () => (await loader()).map((r) => ({ ...r, status: r.status as RedirectStatus })) : null;
  loadedMap = null;
  loadingMap = null;
  lastLoadFailure = 0;
  invalidateRedirects();
}

async function readMap(): Promise<LookupRule[]> {
  if (testLoader) return testLoader();
  const rows = await controlDb().siteRedirect.findMany({
    where: { enabled: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: MAX_REDIRECTS,
    select: { id: true, fromPath: true, toUrl: true, match: true, status: true },
  });
  return rows.map((r) => ({ ...r, status: r.status as RedirectStatus }));
}

function startLoad(generation: number, now: number): Loading {
  if (loadingMap && loadingMap.generation === generation && now - loadingMap.since < LOAD_GIVE_UP_MS) return loadingMap;
  const entry: Loading = {
    generation,
    since: now,
    promise: readMap()
      .then((rules) => {
        const index = indexRules(rules);
        if (!loadedMap || loadedMap.generation <= generation) loadedMap = { generation, at: Date.now(), index };
        lastLoadFailure = 0;
        return index;
      })
      .catch((err: unknown) => {
        lastLoadFailure = Date.now();
        logFailure("the redirect map could not be read, so none apply for now", err);
        return null;
      })
      .finally(() => {
        if (loadingMap === entry) loadingMap = null;
      }),
  };
  loadingMap = entry;
  return entry;
}

function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), Math.max(0, ms));
    (timer as { unref?: () => void }).unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/** The current map: at once when this process has one (read again in the background after 60 s), else a short wait for it. */
async function currentIndex(waitMs: number): Promise<RuleIndex<LookupRule> | null> {
  const now = Date.now();
  const generation = generationNow();
  if (loadedMap && loadedMap.generation === generation) {
    if (now - loadedMap.at >= REDIRECT_MAP_TTL_MS && now - lastLoadFailure >= RETRY_AFTER_FAILURE_MS) void startLoad(generation, now).promise;
    return loadedMap.index;
  }
  if (now - lastLoadFailure < RETRY_AFTER_FAILURE_MS) return null;
  const loading = startLoad(generation, now);
  const waited = now - loading.since;
  if (waited >= waitMs) return null;
  return within(loading.promise, waitMs - waited);
}

/** What the proxy answers for a path: the redirect's id (for its hit count), where to, and with which status. */
export type RedirectHit = { id: string; target: string; status: RedirectStatus; external: boolean };

/**
 * The redirect for a request's path on the public site, or null. EXACT first, then the PREFIX with
 * the longest base (its target's "/*" takes the rest of the path, as requested). The site's own
 * routes, its machinery and static files are never looked up. Never throws; waits at most `waitMs`
 * (250 ms) and only when this process has no current map — a failure or a timeout is no redirect.
 * The proxy calls it on the public site's hosts only.
 */
export async function matchRedirect(pathname: string, options: { waitMs?: number } = {}): Promise<RedirectHit | null> {
  try {
    if (!controlConfigured() && !testLoader) return null;
    const key = normalisePath(pathname);
    if (!key || reservedSource(key)) return null;
    const index = await currentIndex(options.waitMs ?? REDIRECT_LOOKUP_WAIT_MS);
    if (!index) return null;
    const rule = findRule(index, key);
    if (!rule) return null;
    const target = targetFor(rule, pathname);
    return { id: rule.id, target, status: rule.status, external: !target.startsWith("/") };
  } catch (err) {
    logFailure("a redirect lookup failed", err);
    return null;
  }
}

/**
 * Which of these site paths an enabled redirect sends elsewhere, as the proxy would (a live page's
 * address an editor has redirected by hand, say) — the sitemap never lists one (spec §1.11). Read
 * from the database, not this process's map. Never throws: on a failure, none.
 */
export async function redirectedPaths(paths: readonly string[]): Promise<Set<string>> {
  try {
    if (!paths.length || (!controlConfigured() && !testLoader)) return new Set();
    const index = indexRules(await readMap());
    return new Set(
      paths.filter((p) => {
        const key = normalisePath(p);
        return !!key && !reservedSource(key) && findRule(index, key) !== null;
      }),
    );
  } catch (err) {
    logFailure("the sitemap could not leave out redirected addresses", err);
    return new Set();
  }
}

// ─── Hits ────────────────────────────────────────────────────────────────────────────────────────

/** Hits counted since the last write, by redirect: how many, and the latest. */
const pendingHits = new Map<string, { n: number; last: Date }>();
let hitFlushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Counts a hit — in memory, at once; written with the others once a minute, one write per redirect
 * (`flushRedirectHits`). Never throws and never waits: a request is never slowed or broken by it.
 */
export function recordHit(id: string, at: Date = new Date()): void {
  try {
    const entry = pendingHits.get(id);
    if (entry) {
      entry.n += 1;
      if (at > entry.last) entry.last = at;
    } else if (pendingHits.size < MAX_REDIRECTS) {
      pendingHits.set(id, { n: 1, last: at });
    }
    if (!hitFlushTimer) {
      hitFlushTimer = setTimeout(() => {
        hitFlushTimer = null;
        void flushRedirectHits();
      }, REDIRECT_HIT_FLUSH_MS);
      (hitFlushTimer as { unref?: () => void }).unref?.();
    }
  } catch {
    // Counting is never worth a failed request.
  }
}

/** How many redirects have hits waiting to be written (for check scripts). */
export function pendingRedirectHits(): number {
  return pendingHits.size;
}

/** Writes the hits counted so far — one UPDATE per redirect — and answers how many were written. Failures are logged and dropped. */
export async function flushRedirectHits(): Promise<number> {
  if (hitFlushTimer) {
    clearTimeout(hitFlushTimer);
    hitFlushTimer = null;
  }
  if (!pendingHits.size || !controlConfigured()) return 0;
  const batch = [...pendingHits];
  pendingHits.clear();
  let written = 0;
  for (const [id, { n, last }] of batch) {
    try {
      await controlDb().$executeRaw`UPDATE site_redirects SET hits = hits + ${n}, "lastHitAt" = GREATEST(COALESCE("lastHitAt", ${last}), ${last}) WHERE id = ${id}`;
      written += 1;
    } catch (err) {
      logFailure("redirect hits were not written", err);
    }
  }
  return written;
}

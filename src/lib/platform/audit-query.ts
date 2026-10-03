import Papa from "papaparse";
import type { Prisma } from "@deskzo/control-client";
import { csvFilename } from "@/lib/console-shared/format";
import { AUDIT_CATEGORIES, actorLabel, auditHref, auditLabel, auditSummary } from "@/lib/console-shared/labels";
import type { AuditFilters } from "@/lib/console-shared/params";
import { redactSecrets } from "@/lib/console-shared/redact";
import type { ActivityItem, CsvExport } from "@/lib/console-shared/types";
import { consoleClock } from "@/lib/platform/console-clock";
import { controlDb } from "@/lib/platform/control-db";
import { ConsoleRefused } from "@/lib/platform/refused";
import type { Clock } from "@/lib/time/zone";

/**
 * The audit explorer (/audit): the platform audit log filtered, newest first, a page at a time; the
 * facets its filters offer; and the CSV export.
 *
 *   · Paging is by keyset — `(at, id)` descending, a cursor naming the last row seen — so a page never
 *     repeats or skips a row while the log keeps growing above it, and a deep page costs what the
 *     first one does (the `[at]`, `[action, at]` and `[actor, at]` indexes serve it).
 *   · `who` and `q` find staff by name or email: the log keeps a staff member's id, so a search for
 *     "Priya" is turned into her id first. That is what "search by staff name finds nothing" was.
 *   · Dates are days on the console's clock (Settings › Time zone), half-open: `from` at its midnight,
 *     up to the midnight after `to`.
 *
 * Rows are shaped like `toActivityItems` (console-guard.ts) does, with the same label helpers — but
 * this file does not import console-guard.ts: staff.ts imports this one (My account's recent
 * activity), and console-guard.ts imports staff.ts for its refusal class, which it reads while it
 * loads. Whichever of the three loaded first would meet the other two half-built.
 */

/**
 * An audit entry as the console shows it. `detail` stays ActivityItem's redacted one-line summary
 * (the intersection keeps it `string | null`), so a row is also an ActivityItem for a feed; the
 * entry's full detail is `json`, pretty-printed and redacted, for the row's expanded view and
 * "Copy JSON" — null when the entry has none.
 */
export type AuditRowView = ActivityItem & { detail: unknown; tenantId: string | null; actorId: string; json: string | null };

export type AuditPage = {
  rows: AuditRowView[];
  /** The cursor for the next (older) page; null on the last page. */
  nextCursor: string | null;
  /**
   * The cursor for the previous (newer) page, whenever the filters carried a cursor: "" when that
   * page is the newest one — `withParams` drops an empty value, which is exactly the first page's
   * link. Null without a cursor: this is the first page and there is nothing newer to go to.
   */
  newerCursor: string | null;
  todayKey: string;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** The same cap as `EXPORT_CAPS.audit` in console-guard.ts (not imported: see the top of this file). */
const EXPORT_CAP = 10_000;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const ACTOR_KINDS: readonly string[] = ["STAFF", "SCRIPT", "SYSTEM"];
/** Staff ids a name search turns into, at most — a search that matches more is not a search. */
const MAX_MATCHED_STAFF = 500;

const NEWEST_FIRST: Prisma.PlatformAuditLogOrderByWithRelationInput[] = [{ at: "desc" }, { id: "desc" }];
const OLDEST_FIRST: Prisma.PlatformAuditLogOrderByWithRelationInput[] = [{ at: "asc" }, { id: "asc" }];

const ROW_SELECT = {
  id: true,
  at: true,
  actorKind: true,
  actor: true,
  action: true,
  tenantId: true,
  detail: true,
  tenant: { select: { slug: true } },
} as const satisfies Prisma.PlatformAuditLogSelect;
type AuditRecord = Prisma.PlatformAuditLogGetPayload<{ select: typeof ROW_SELECT }>;

/** A page of the log. `now` only names today, for the day headings. */
export async function auditQuery(f: AuditFilters, now = new Date()): Promise<AuditPage> {
  const limit = clampLimit(f.limit);
  const cursor = typeof f.cursor === "string" && ID.test(f.cursor) ? f.cursor : undefined;
  const clock = await consoleClock();
  const where = await auditWhere(f, clock);
  const control = controlDb();
  const [found, newer] = await Promise.all([
    control.platformAuditLog.findMany({ where, orderBy: NEWEST_FIRST, take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), select: ROW_SELECT }),
    // The newer page ends at this page's cursor row: walking up from it, the `limit`-th row is that
    // page's own cursor. Fewer than `limit` above it, and the newer page is the first.
    cursor ? control.platformAuditLog.findMany({ where, orderBy: OLDEST_FIRST, take: limit, cursor: { id: cursor }, skip: 1, select: { id: true } }) : null,
  ]);
  const page = found.slice(0, limit);
  const names = await staffNames(page);
  return {
    rows: page.map((row) => toRowView(row, names, clock)),
    nextCursor: found.length > limit ? page[page.length - 1].id : null,
    newerCursor: newer === null ? null : newer.length === limit ? newer[limit - 1].id : "",
    todayKey: clock.dateKey(now),
  };
}

/** What the filters offer: every action in the log with its count, and every staff member (switched-off ones too — old entries name them). */
export async function auditFacets(): Promise<{ actions: { action: string; n: number }[]; staff: { id: string; name: string; email: string }[] }> {
  const control = controlDb();
  const [groups, staff] = await Promise.all([
    control.platformAuditLog.groupBy({ by: ["action"], _count: { _all: true }, orderBy: { action: "asc" } }),
    control.platformUser.findMany({ orderBy: [{ name: "asc" }, { email: "asc" }], select: { id: true, name: true, email: true } }),
  ]);
  return { actions: groups.map((g) => ({ action: g.action, n: g._count._all })), staff };
}

/**
 * The filtered log as CSV, newest first — every matching row, not a page of them (the cursor and
 * the page size are ignored). More than 10,000 is refused rather than cut short: a partial audit
 * export reads as a complete one.
 */
export async function auditCsv(f: AuditFilters, now = new Date()): Promise<CsvExport> {
  const clock = await consoleClock();
  const where = await auditWhere(f, clock);
  const control = controlDb();
  const total = await control.platformAuditLog.count({ where });
  if (total > EXPORT_CAP) throw new ConsoleRefused("Narrow the range — at most 10,000 rows.");
  const rows = await control.platformAuditLog.findMany({ where, orderBy: NEWEST_FIRST, take: EXPORT_CAP, select: ROW_SELECT });
  const names = await staffNames(rows);
  const csv = Papa.unparse(
    {
      fields: [`When (${clock.zone})`, "Actor kind", "Who", "Action", "Workspace", "Detail"],
      data: rows.map((row) => [
        stamp(row.at, clock),
        row.actorKind,
        // The name for staff (the id when they are gone), the script's or job's own name otherwise.
        row.actorKind === "STAFF" ? (names.get(row.actor) ?? row.actor) : row.actor,
        row.action,
        row.tenant?.slug ?? "",
        row.detail === null || row.detail === undefined ? "" : (redactSecrets(JSON.stringify(row.detail)) ?? ""),
      ]),
    },
    { escapeFormulae: true },
  );
  return { filename: csvFilename("audit-log", now, clock), csv, rows: rows.length };
}

// ─── Filters ─────────────────────────────────────────────────────────────────────────────────────

async function auditWhere(f: AuditFilters, clock: Clock): Promise<Prisma.PlatformAuditLogWhereInput> {
  const and: Prisma.PlatformAuditLogWhereInput[] = [];
  const q = searchText(f.q);
  let who = searchText(f.who);
  // One search box may send its text as both: that is one search, not two that must both match.
  if (q && who && q.toLowerCase() === who.toLowerCase()) who = undefined;

  if (q) {
    const ids = await staffIdsMatching(q);
    const anyOf: Prisma.PlatformAuditLogWhereInput[] = [
      { action: { contains: q, mode: "insensitive" } },
      { actor: { contains: q, mode: "insensitive" } },
      { tenant: { slug: { contains: q, mode: "insensitive" } } },
    ];
    if (ids.length) anyOf.push({ actorKind: "STAFF", actor: { in: ids } });
    and.push({ OR: anyOf });
  }
  // No match is no rows (`in: []`), not every row.
  if (who) and.push({ actorKind: "STAFF", actor: { in: await staffIdsMatching(who) } });
  if (f.actorKind && ACTOR_KINDS.includes(f.actorKind)) and.push({ actorKind: f.actorKind });
  // Fails closed: a staff id that is not one matches nothing (My account's own activity must never widen to everybody's).
  if (f.staff !== undefined) and.push(typeof f.staff === "string" && ID.test(f.staff) ? { actorKind: "STAFF", actor: f.staff } : { id: { in: [] } });
  if (typeof f.action === "string" && f.action.trim()) and.push({ action: { startsWith: f.action.trim().slice(0, 64).toLowerCase() } });
  if (f.category) {
    const category = AUDIT_CATEGORIES.find((c) => c.key === f.category);
    // The same prefixes `categoryOf` reads, so the filter and the row's category always agree.
    if (category) and.push({ OR: category.prefixes.map((prefix) => ({ action: { startsWith: prefix } })) });
  }
  if (typeof f.tenant === "string" && f.tenant) and.push({ tenant: { slug: f.tenant.toLowerCase() } });
  const at = clock.dayRange(f.from, f.to);
  if (at) and.push({ at });
  return and.length ? { AND: and } : {};
}

function searchText(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().slice(0, 100).trim();
  return text || undefined;
}

function clampLimit(limit: unknown): number {
  const n = typeof limit === "number" ? limit : Number(limit);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_LIMIT) : DEFAULT_LIMIT;
}

/** Staff whose name or email contains the text, switched-off ones included. */
async function staffIdsMatching(text: string): Promise<string[]> {
  const rows = await controlDb().platformUser.findMany({
    where: { OR: [{ name: { contains: text, mode: "insensitive" } }, { email: { contains: text, mode: "insensitive" } }] },
    select: { id: true },
    take: MAX_MATCHED_STAFF,
  });
  return rows.map((r) => r.id);
}

// ─── Shaping ─────────────────────────────────────────────────────────────────────────────────────

/** The names of the staff members behind these rows. */
async function staffNames(rows: AuditRecord[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.filter((r) => r.actorKind === "STAFF").map((r) => r.actor))];
  const names = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 1000) {
    const users = await controlDb().platformUser.findMany({ where: { id: { in: ids.slice(i, i + 1000) } }, select: { id: true, name: true } });
    for (const u of users) names.set(u.id, u.name);
  }
  return names;
}

/** As `toActivityItems` shapes an entry, plus what the explorer shows besides. Dates in a summary are on `clock`. */
function toRowView(row: AuditRecord, names: ReadonlyMap<string, string>, clock: Clock): AuditRowView {
  const { title, tone, category } = auditLabel(row.action, row.detail);
  const slug = row.tenant?.slug ?? null;
  return {
    id: row.id,
    at: row.at,
    title,
    code: row.action,
    tone,
    category,
    detail: redactSecrets(auditSummary(row.action, row.detail, clock)),
    actor: actorLabel(row.actorKind, row.actor, names),
    actorKind: row.actorKind,
    workspace: slug ? { slug } : null,
    href: auditHref(row.action, row.detail, slug),
    tenantId: row.tenantId,
    actorId: row.actor,
    json: row.detail === null || row.detail === undefined ? null : redactSecrets(JSON.stringify(row.detail, null, 2)),
  };
}

/** "2026-09-27 18:30:05" on the console's clock — sorts as text in a spreadsheet. */
function stamp(at: Date, clock: Clock): string {
  const { hour, minute, second } = clock.parts(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${clock.dateKey(at)} ${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { sealingStream } from "@/lib/backup/at-rest";
import { inBatches } from "@/lib/batches";
import { db } from "@/lib/db";
import { accessLogDir } from "@/lib/logs/access-log";
import { KeptByStore, type OffsiteStore } from "@/lib/offsite/store";
import { controlDb } from "@/lib/platform/control-db";
import { forEachTenant } from "@/lib/platform/fanout";
import { getSetting, setSetting } from "@/lib/platform/settings";
import { activeTenants, tenantById } from "@/lib/tenancy/registry";
import type { Tenant } from "@/lib/tenancy/state";

/**
 * The log archive (owner, 24 Oct 2026): CERT-In's Directions of 28 April 2022 require a service
 * provider to keep the logs of its systems for 180 days, in India, and to hand them over when asked
 * after an incident. Kept here for a year unless changed (offsite.logKeepDays, 180 at least), sealed,
 * in the off-site store:
 *
 *   logs/<day>/access/<host>-<pid>.jsonl.gz   the web access log (src/lib/logs/access-log.ts)
 *   logs/<day>/workspaces/<id>.jsonl.gz       a workspace's security logs that day: its activity log,
 *                                             its sign-ins and its audit log
 *   logs/<day>/platform.jsonl.gz              the platform's own: the console's audit log and staff
 *                                             sign-ins, the CMS's and the partner portal's
 *
 * <day> is the UTC date. Every file is one JSON object a line, gzipped, then sealed like a backup
 * (src/lib/backup/at-rest.ts) — under "platform-logs" for the platform's files and under the
 * workspace's own key for a workspace's — so the store holds nothing readable. `npm run offsite --
 * fetch <key> <out>` opens one.
 *
 * ## Why a workspace's logs are copied at all
 *
 * A workspace's admin decides how long its activity log and sign-ins stay in the app (Settings ›
 * Security, 30 days at least). That is the workspace's own record. This archive is Deskzo's, kept
 * because the law asks Deskzo for it, out of the app and out of reach of anybody in the workspace —
 * including somebody covering their tracks by shortening the retention. The settings screen says so.
 * Audit entries are archived without the values a change carried (`changes` keeps only the fields'
 * names): who changed what, when, without a year's copy of the business data itself.
 *
 * ## Local copies
 *
 * Access log files stay on the server 14 days after they are archived. Without a store they are kept
 * as long as the archive would keep them, so the 180 days are met on the server's disk instead.
 */

export const LOG_SEAL = "platform-logs";
const KEEP_SENT_LOCALLY_DAYS = 14;
/** The first export of a workspace reaches back this far — CERT-In's 180 days. */
const BACKFILL_DAYS = 180;
/** Days of one workspace exported in one pass; a backfill finishes over a few nights. */
const DAYS_PER_PASS = 31;
/** A day's access log is archived once the day is this far behind, so the last lines are flushed. */
const SETTLE_MS = 10 * 60_000;
const PAGE = 5_000;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const dayKey = (at: Date) => at.toISOString().slice(0, 10);
export const addDays = (key: string, n: number) => dayKey(new Date(Date.parse(`${key}T00:00:00Z`) + n * 86_400_000));
const dayStart = (key: string) => new Date(`${key}T00:00:00Z`);

/** Lines into a gzipped, sealed file — written as they come, so a busy day never sits in memory. */
class SealedLines {
  private readonly gzip = createGzip({ level: 6 });
  private readonly done: Promise<void>;
  lines = 0;
  constructor(sealFor: string, readonly file: string) {
    this.done = pipeline(this.gzip, sealingStream(sealFor, "log"), createWriteStream(file));
    this.done.catch(() => {});
  }
  async write(record: Record<string, unknown>): Promise<void> {
    this.lines += 1;
    const line = `${JSON.stringify(record, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))}\n`;
    if (!this.gzip.write(line)) await once(this.gzip, "drain");
  }
  async close(): Promise<void> {
    this.gzip.end();
    await this.done;
  }
}

// ─── The access log ──────────────────────────────────────────────────────────────────────────────

/** Each finished day's access log files, sealed and sent. Marked `<file>.sent` once in the store. */
export async function archiveAccessLogs(store: OffsiteStore, now = new Date()): Promise<{ files: number; bytes: number }> {
  const root = accessLogDir();
  let files = 0;
  let bytes = 0;
  for (const day of (await readdir(root).catch(() => [] as string[])).filter((d) => DAY.test(d)).sort()) {
    if (dayStart(addDays(day, 1)).getTime() + SETTLE_MS > now.getTime()) continue;
    const dir = path.join(root, day);
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith(".jsonl") || names.includes(`${name}.sent`)) continue;
      const file = path.join(dir, name);
      const temp = `${file}.sealing`;
      try {
        await pipeline(createReadStream(file), createGzip({ level: 6 }), sealingStream(LOG_SEAL, "log"), createWriteStream(temp));
        await store.putFile(`logs/${day}/access/${name}.gz`, temp);
        bytes += (await stat(temp)).size;
      } finally {
        await rm(temp, { force: true }).catch(() => {});
      }
      await writeFile(`${file}.sent`, new Date().toISOString(), "utf8");
      files += 1;
    }
  }
  return { files, bytes };
}

/**
 * Access log days removed from the server: 14 days after every file of the day is archived, or — with
 * nothing to archive them to — once they are older than the archive would have kept them.
 */
export async function pruneLocalAccessLogs(keepUnsentDays: number, now = new Date()): Promise<number> {
  const root = accessLogDir();
  const today = dayKey(now);
  let removed = 0;
  for (const day of (await readdir(root).catch(() => [] as string[])).filter((d) => DAY.test(d))) {
    const names = await readdir(path.join(root, day)).catch(() => [] as string[]);
    const allSent = names.filter((n) => n.endsWith(".jsonl")).every((n) => names.includes(`${n}.sent`));
    if ((allSent && day < addDays(today, -KEEP_SENT_LOCALLY_DAYS)) || day < addDays(today, -keepUnsentDays)) {
      await rm(path.join(root, day), { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

// ─── A workspace's security logs ─────────────────────────────────────────────────────────────────

type Person = { email: string | null; name: string | null };

/** Every row a read returns, a page at a time by id — a busy day never sits in memory whole. */
async function eachPage<T extends { id: string }>(read: (after: string | undefined) => Promise<T[]>, write: (rows: T[]) => Promise<void>): Promise<void> {
  let after: string | undefined;
  for (;;) {
    const rows = await read(after);
    await write(rows);
    if (rows.length < PAGE) return;
    after = rows[rows.length - 1].id;
  }
}

async function people(ids: string[]): Promise<Map<string, Person>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const rows = await inBatches(unique, (batch) => db.user.findMany({ where: { id: { in: batch } }, select: { id: true, email: true, name: true } }));
  return new Map(rows.map((u) => [u.id, { email: u.email, name: u.name }]));
}

/** One workspace's activity log, sign-ins and audit log of one UTC day, into one sealed file. Run as the workspace. */
export async function exportWorkspaceDay(store: OffsiteStore, tenantId: string, day: string, workFile: string): Promise<{ rows: number; bytes: number }> {
  const range = { gte: dayStart(day), lt: dayStart(addDays(day, 1)) };
  const out = new SealedLines(tenantId, workFile);
  try {
    await eachPage(
      (after) => db.activityLog.findMany({ where: { createdAt: range, ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: "asc" }, take: PAGE }),
      async (rows) => {
        for (const r of rows) await out.write({ log: "activity", ...r });
      },
    );
    await eachPage(
      (after) =>
        db.signIn.findMany({
          where: { at: range, ...(after ? { id: { gt: after } } : {}) },
          orderBy: { id: "asc" },
          take: PAGE,
          // Not `sid`: it names a live session.
          select: { id: true, userId: true, provider: true, at: true, lastSeenAt: true, endedAt: true, endedById: true, ip: true, userAgent: true, deviceKind: true, city: true, region: true, country: true, countryCode: true, flags: true },
        }),
      async (rows) => {
        const who = await people(rows.map((r) => r.userId));
        for (const r of rows) await out.write({ log: "sign-in", ...r, userEmail: who.get(r.userId)?.email ?? null });
      },
    );
    await eachPage(
      (after) =>
        db.auditLog.findMany({
          where: { createdAt: range, ...(after ? { id: { gt: after } } : {}) },
          orderBy: { id: "asc" },
          take: PAGE,
          select: { id: true, userId: true, action: true, entityType: true, entityId: true, entityLabel: true, impersonatedByUserId: true, changes: true, createdAt: true },
        }),
      async (rows) => {
        const who = await people(rows.flatMap((r) => [r.userId, r.impersonatedByUserId ?? ""]));
        for (const { changes, ...r } of rows) {
          const fields = Array.isArray(changes) ? changes.map((c) => (c && typeof c === "object" && "field" in c ? String((c as { field: unknown }).field) : null)).filter(Boolean) : [];
          await out.write({ log: "audit", ...r, userEmail: who.get(r.userId)?.email ?? null, impersonatedByEmail: r.impersonatedByUserId ? (who.get(r.impersonatedByUserId)?.email ?? null) : null, changedFields: fields });
        }
      },
    );
    await out.close();
  } catch (err) {
    await out.close().catch(() => {});
    await rm(workFile, { force: true }).catch(() => {});
    throw err;
  }
  try {
    if (out.lines === 0) return { rows: 0, bytes: 0 };
    await store.putFile(`logs/${day}/workspaces/${tenantId}.jsonl.gz`, workFile);
    return { rows: out.lines, bytes: (await stat(workFile)).size };
  } finally {
    await rm(workFile, { force: true }).catch(() => {});
  }
}

/** The workspaces whose logs are archived: open ones, and held ones — people still sign in to pay. */
async function loggedTenants(): Promise<Tenant[]> {
  const active = await activeTenants();
  const held = await controlDb().tenant.findMany({ where: { status: "SUSPENDED" }, select: { id: true } });
  const more = (await Promise.all(held.map((t) => tenantById(t.id)))).filter((t): t is Tenant => !!t);
  return [...active, ...more];
}

/**
 * Every workspace's finished days since it was last archived, in order, up to a month a pass; its
 * first time back to 180 days ago. Each day is recorded as done the moment it is in the store.
 */
export async function exportWorkspaceLogs(store: OffsiteStore, workDir: string, now = new Date()): Promise<{ workspaces: number; days: number; rows: number; bytes: number; failed: { slug: string; error: string }[] }> {
  const yesterday = addDays(dayKey(now), -1);
  const control = controlDb();
  const totals = { workspaces: 0, days: 0, rows: 0, bytes: 0 };
  const outcomes = await forEachTenant(
    "offsite-logs",
    await loggedTenants(),
    async (tenant) => {
      const row = await control.offsiteWorkspace.findUnique({ where: { tenantId: tenant.id }, select: { logsThrough: true } });
      let day = row?.logsThrough ? addDays(row.logsThrough, 1) : addDays(yesterday, -(BACKFILL_DAYS - 1));
      let done = 0;
      while (day <= yesterday && done < DAYS_PER_PASS) {
        const { rows, bytes } = await exportWorkspaceDay(store, tenant.id, day, path.join(workDir, `${tenant.id}-${day}.sealing`));
        await control.offsiteWorkspace.upsert({ where: { tenantId: tenant.id }, create: { tenantId: tenant.id, logsThrough: day }, update: { logsThrough: day } });
        totals.days += 1;
        totals.rows += rows;
        totals.bytes += bytes;
        day = addDays(day, 1);
        done += 1;
      }
      if (done > 0) totals.workspaces += 1;
    },
    { concurrency: 2, timeoutMs: 60 * 60_000 },
  );
  const failed = outcomes.flatMap((o) => ("error" in o && o.error ? [{ slug: o.slug, error: o.error }] : []));
  return { ...totals, failed };
}

// ─── The platform's own ──────────────────────────────────────────────────────────────────────────

async function exportPlatformDay(store: OffsiteStore, day: string, workFile: string): Promise<{ rows: number; bytes: number }> {
  const control = controlDb();
  const at = { gte: dayStart(day), lt: dayStart(addDays(day, 1)) };
  const session = { userId: true, createdAt: true, lastSeenAt: true, expiresAt: true, mfaAt: true, revokedAt: true, ip: true, userAgent: true } as const;
  const out = new SealedLines(LOG_SEAL, workFile);
  try {
    // Small tables, a day at a time: read whole. Sessions without their ids, which are their tokens.
    for (const r of await control.platformAuditLog.findMany({ where: { at }, orderBy: { at: "asc" } })) await out.write({ log: "console-audit", ...r });
    for (const r of await control.platformSession.findMany({ where: { createdAt: at }, select: { ...session, user: { select: { email: true } } } })) await out.write({ log: "console-sign-in", ...r });
    for (const r of await control.cmsAuditLog.findMany({ where: { at }, orderBy: { at: "asc" } })) await out.write({ log: "cms-audit", ...r });
    for (const r of await control.cmsSession.findMany({ where: { createdAt: at }, select: session })) await out.write({ log: "cms-sign-in", ...r });
    for (const r of await control.partnerAuditLog.findMany({ where: { at }, orderBy: { at: "asc" } })) await out.write({ log: "partner-audit", ...r });
    for (const r of await control.partnerSession.findMany({ where: { createdAt: at }, select: session })) await out.write({ log: "partner-sign-in", ...r });
    await out.close();
  } catch (err) {
    await out.close().catch(() => {});
    await rm(workFile, { force: true }).catch(() => {});
    throw err;
  }
  try {
    if (out.lines === 0) return { rows: 0, bytes: 0 };
    await store.putFile(`logs/${day}/platform.jsonl.gz`, workFile);
    return { rows: out.lines, bytes: (await stat(workFile)).size };
  } finally {
    await rm(workFile, { force: true }).catch(() => {});
  }
}

export async function exportPlatformLogs(store: OffsiteStore, workDir: string, now = new Date()): Promise<{ days: number; rows: number; bytes: number }> {
  const yesterday = addDays(dayKey(now), -1);
  const through = await getSetting("offsite.logsThrough");
  let day = through && DAY.test(through) ? addDays(through, 1) : addDays(yesterday, -(BACKFILL_DAYS - 1));
  const totals = { days: 0, rows: 0, bytes: 0 };
  while (day <= yesterday && totals.days < DAYS_PER_PASS) {
    const { rows, bytes } = await exportPlatformDay(store, day, path.join(workDir, `platform-${day}.sealing`));
    await setSetting("offsite.logsThrough", day, "offsite");
    totals.days += 1;
    totals.rows += rows;
    totals.bytes += bytes;
    day = addDays(day, 1);
  }
  return totals;
}

// ─── Retention in the store ──────────────────────────────────────────────────────────────────────

/** Whole days removed from the archive once they are older than it keeps them. */
export async function pruneArchivedLogs(store: OffsiteStore, keepDays: number, now = new Date()): Promise<{ days: number; objects: number; kept: number }> {
  const cutoff = addDays(dayKey(now), -keepDays);
  const { prefixes } = await store.list("logs/", { delimiter: true });
  let days = 0;
  let objects = 0;
  let kept = 0;
  for (const folder of prefixes) {
    const day = folder.slice("logs/".length).replace(/\/$/, "");
    if (!DAY.test(day) || day >= cutoff) continue;
    let all = true;
    for (const o of (await store.list(folder)).objects) {
      try {
        await store.remove(o.key);
        objects += 1;
      } catch (err) {
        if (!(err instanceof KeptByStore)) throw err;
        kept += 1;
        all = false;
      }
    }
    if (all) days += 1;
  }
  return { days, objects, kept };
}

import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { backupBase } from "@/lib/backup/maintenance";
import { archiveAccessLogs, exportPlatformLogs, exportWorkspaceLogs, pruneArchivedLogs, pruneLocalAccessLogs } from "@/lib/logs/archive";
import { removeOrphanedWorkspaces, syncWorkspace, type WorkspaceSync } from "@/lib/offsite/backups";
import { currentStore, offsiteSetup } from "@/lib/offsite/config";
import { dumpControlPlane } from "@/lib/offsite/control";
import { drillCandidate, drillControlPlane, drillWorkspace, dropLeftoverScratch } from "@/lib/offsite/drill";
import { syncSupportFiles } from "@/lib/offsite/support";
import { consoleClock } from "@/lib/platform/console-clock";
import { controlDb } from "@/lib/platform/control-db";
import { withPlatformLease } from "@/lib/platform/fanout";
import { getSetting, setSetting } from "@/lib/platform/settings";
import { checkClock, lastClockCheck } from "@/lib/platform/time-sync";
import type { OffsiteRunKind } from "@deskzo/control-client";

/**
 * When the off-site work runs, and the record of each run (offsite_runs).
 *
 *   sync      every hour       workspaces' new backups and support files off-site; old ones pruned
 *                              there once a day per workspace; a closed workspace's removed
 *   control   every night      the control plane dumped and sealed (here even without a store)
 *   logs      every night      finished days of the access log and the security logs archived; old
 *                              days pruned, here and there
 *   drill     every week       the newest off-site backup of one workspace, and the control plane's
 *                              newest dump, restored into scratch databases and read back
 *   clock     every day        this server's clock against NPL's and NIC's (src/lib/platform/time-sync.ts)
 *
 * Run by the platform worker (scripts/platform-worker.ts) beside its other work, never in a web
 * request: a sync can take minutes and a drill longer. Each under a platform lease, so two workers
 * never run the same one. The console's "Run now" asks the worker (`offsite.requested`); `npm run
 * offsite` runs one by hand.
 *
 * Nights are the console's (Settings › Time zone): the control plane after 01:00, the drill between
 * 03:00 and 07:00 — after the workspaces' own backups at 02:00, in the hours nobody is working.
 */

export const CHORES = ["sync", "control", "logs", "drill", "clock"] as const;
export type Chore = (typeof CHORES)[number];

const HOUR = 3_600_000;
const LEASE_MS: Record<Chore, number> = { sync: 6 * HOUR, control: 2 * HOUR, logs: 6 * HOUR, drill: 8 * HOUR, clock: 10 * 60_000 };
/** Runs are kept this long. */
const KEEP_RUNS_DAYS = 180;

export type ChoreOutcome = { chore: Chore; ran: boolean; ok: boolean; summary: string; error: string | null };

type Work = { ok: boolean; summary: string; error?: string | null; objects?: number; bytes?: number; tenantId?: string | null };

/** A run recorded from start to end; `work` gets the run's id (a drill writes its scratch database there). */
async function recorded(kind: OffsiteRunKind, startedBy: string, work: (runId: string) => Promise<Work>, tenantId: string | null = null): Promise<Work> {
  const control = controlDb();
  const run = await control.offsiteRun.create({ data: { kind, startedBy, tenantId }, select: { id: true } });
  let result: Work;
  try {
    result = await work(run.id);
  } catch (err) {
    result = { ok: false, summary: "Stopped by an error.", error: err instanceof Error ? err.message : String(err) };
  }
  await control.offsiteRun.update({
    where: { id: run.id },
    data: {
      status: result.ok ? "SUCCEEDED" : "FAILED",
      finishedAt: new Date(),
      summary: result.summary.slice(0, 1000),
      error: result.error ? result.error.slice(0, 2000) : null,
      objects: result.objects ?? 0,
      bytes: BigInt(result.bytes ?? 0),
      ...(result.tenantId !== undefined ? { tenantId: result.tenantId } : {}),
    },
  });
  return result;
}

const mb = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`);
const NOT_SET_UP = "No off-site store is set up (console › Settings › Backups & logs).";

// ─── The chores ──────────────────────────────────────────────────────────────────────────────────

async function sync(startedBy: string): Promise<Work> {
  const found = await currentStore();
  if (!found) return { ok: false, summary: "Nothing copied.", error: NOT_SET_UP };
  const { store, setup } = found;
  return recorded("SYNC", startedBy, async () => {
    const control = controlDb();
    const tenants = await control.tenant.findMany({
      where: { status: { not: "PROVISIONING" }, NOT: { status: "DEPROVISIONED", keyBundleCipher: "" } },
      select: { id: true, slug: true, isDefault: true },
      orderBy: { createdAt: "asc" },
    });
    const results: WorkspaceSync[] = [];
    for (const tenant of tenants) results.push(await syncWorkspace(store, setup, tenant));

    const support = await syncSupportFiles(store);
    // Once a day, the backups of workspaces that are gone — the first pass after the console's midnight.
    const clock = await consoleClock();
    let orphans = { workspaces: 0, objects: 0 };
    if ((await getSetting("offsite.orphansSweptOn")) !== clock.today()) {
      orphans = await removeOrphanedWorkspaces(store, new Set(tenants.map((t) => t.id)));
      await setSetting("offsite.orphansSweptOn", clock.today(), "offsite");
    }

    const failed = results.filter((r) => r.error);
    const sent = results.reduce((n, r) => n + r.sent.backups, 0);
    const chunks = results.reduce((n, r) => n + r.sent.chunks, 0);
    const bytes = results.reduce((n, r) => n + r.sent.bytes, 0) + support.bytes;
    const pruned = results.reduce((n, r) => n + r.pruned.backups, 0);
    const kept = results.reduce((n, r) => n + r.pruned.kept, 0);
    const parts = [
      `${tenants.length} workspace${tenants.length === 1 ? "" : "s"}`,
      sent || chunks ? `${sent} backup${sent === 1 ? "" : "s"} sent (${chunks} pieces, ${mb(bytes)})` : "nothing new to send",
      pruned ? `${pruned} old backup${pruned === 1 ? "" : "s"} removed off-site` : null,
      kept ? `${kept} kept by the store's own retention` : null,
      support.sent || support.removed ? `support files: ${support.sent} sent, ${support.removed} removed` : null,
      orphans.workspaces ? `${orphans.workspaces} closed workspace${orphans.workspaces === 1 ? "'s" : "s'"} backups removed` : null,
      failed.length ? `${failed.length} failed` : null,
    ].filter(Boolean);
    return {
      ok: failed.length === 0,
      summary: `${parts.join("; ")}.`,
      error: failed.length ? failed.slice(0, 5).map((f) => `${f.slug}: ${f.error}`).join("\n") : null,
      objects: sent + chunks + support.sent,
      bytes,
    };
  });
}

async function controlDump(startedBy: string): Promise<Work> {
  const found = await currentStore().catch(() => null);
  return recorded("CONTROL_DUMP", startedBy, async () => {
    const done = await dumpControlPlane(found?.store ?? null, found?.setup ?? null);
    const where = done.sent ? "here and off-site" : "here only — no off-site store is set up";
    return {
      ok: done.sent,
      summary: `${done.filename} (${mb(done.sizeBytes)}) kept ${where}${done.prunedThere ? `; ${done.prunedThere} old one${done.prunedThere === 1 ? "" : "s"} removed off-site` : ""}.`,
      error: done.sent ? null : NOT_SET_UP,
      objects: done.sent ? 1 : 0,
      bytes: done.sent ? done.sizeBytes : 0,
    };
  });
}

async function logs(startedBy: string): Promise<Work> {
  const found = await currentStore().catch(() => null);
  const setup = found?.setup ?? (await offsiteSetup());
  return recorded("LOGS", startedBy, async () => {
    // Runs kept half a year: the record of the backups is evidence for an audit too.
    await controlDb().offsiteRun.deleteMany({ where: { startedAt: { lt: new Date(Date.now() - KEEP_RUNS_DAYS * 24 * HOUR) }, scratchDb: null } });
    if (!found) {
      const removed = await pruneLocalAccessLogs(setup.logKeepDays);
      return { ok: false, summary: `Logs kept on this server only, ${setup.logKeepDays} days${removed ? `; ${removed} older day${removed === 1 ? "" : "s"} removed` : ""}.`, error: NOT_SET_UP };
    }
    const work = path.join(backupBase(), "platform", "logs-work");
    await mkdir(work, { recursive: true });
    try {
      const access = await archiveAccessLogs(found.store);
      const platform = await exportPlatformLogs(found.store, work);
      const workspaces = await exportWorkspaceLogs(found.store, work);
      const prunedHere = await pruneLocalAccessLogs(setup.logKeepDays);
      const prunedThere = await pruneArchivedLogs(found.store, setup.logKeepDays);
      const bytes = access.bytes + platform.bytes + workspaces.bytes;
      const parts = [
        `${access.files} access log file${access.files === 1 ? "" : "s"}`,
        `${platform.days} day${platform.days === 1 ? "" : "s"} of the platform's logs`,
        `${workspaces.days} workspace-day${workspaces.days === 1 ? "" : "s"} of security logs (${workspaces.rows.toLocaleString("en-IN")} entries)`,
      ];
      const pruned = prunedThere.days ? `; ${prunedThere.days} day${prunedThere.days === 1 ? "" : "s"} past ${setup.logKeepDays} removed off-site` : "";
      return {
        ok: workspaces.failed.length === 0,
        summary: `Archived ${parts.join(", ")} — ${mb(bytes)}${pruned}${prunedHere ? `; ${prunedHere} day${prunedHere === 1 ? "" : "s"} removed here` : ""}.`,
        error: workspaces.failed.length ? workspaces.failed.slice(0, 5).map((f) => `${f.slug}: ${f.error}`).join("\n") : null,
        objects: access.files + platform.days + workspaces.days,
        bytes,
      };
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  });
}

async function drill(startedBy: string, tenantId?: string | null): Promise<Work> {
  const found = await currentStore();
  if (!found) return { ok: false, summary: "Nothing restored.", error: NOT_SET_UP };
  await dropLeftoverScratch();
  const results: Work[] = [];
  const tenant = await drillCandidate(tenantId);
  if (tenant) {
    results.push(
      await recorded(
        "DRILL",
        startedBy,
        async (runId) => {
          const outcome = await drillWorkspace(found.store, runId, tenant);
          await controlDb().offsiteWorkspace.update({ where: { tenantId: tenant.id }, data: { lastDrillAt: new Date(), lastDrillOk: outcome.ok } }).catch(() => {});
          return { ok: outcome.ok, summary: outcome.summary, error: outcome.error, bytes: outcome.bytes, tenantId: tenant.id };
        },
        tenant.id,
      ),
    );
  }
  // The control plane's own, unless a workspace was asked for by name.
  if (!tenantId) {
    results.push(await recorded("DRILL", startedBy, async (runId) => {
      const outcome = await drillControlPlane(found.store, runId);
      return { ok: outcome.ok, summary: outcome.summary, error: outcome.error, bytes: outcome.bytes, tenantId: null };
    }));
  }
  if (results.length === 0) return { ok: false, summary: "Nothing to restore yet.", error: "No workspace has backups off-site." };
  return { ok: results.every((r) => r.ok), summary: results.map((r) => r.summary).join(" "), error: results.map((r) => r.error).filter(Boolean).join("\n") || null };
}

async function clock(): Promise<Work> {
  const check = await checkClock();
  if (check.offsetMs === null) return { ok: false, summary: "No time server answered.", error: check.error };
  const behind = check.offsetMs < 0 ? "behind" : "ahead of";
  return { ok: true, summary: `${Math.abs(check.offsetMs)} ms ${behind} ${check.server}.` };
}

// ─── Running them ────────────────────────────────────────────────────────────────────────────────

/** One chore now, under its lease. `tenantId`: the workspace a drill restores (otherwise the one drilled longest ago). */
export async function runChore(chore: Chore, startedBy: string, options: { tenantId?: string | null } = {}): Promise<ChoreOutcome> {
  const work = () => {
    switch (chore) {
      case "sync":
        return sync(startedBy);
      case "control":
        return controlDump(startedBy);
      case "logs":
        return logs(startedBy);
      case "drill":
        return drill(startedBy, options.tenantId);
      case "clock":
        return clock();
    }
  };
  const leased = await withPlatformLease(`offsite-${chore}`, LEASE_MS[chore], work);
  if (!leased.ran) return { chore, ran: false, ok: false, summary: "Already running.", error: null };
  return { chore, ran: true, ok: leased.value.ok, summary: leased.value.summary, error: leased.value.error ?? null };
}

async function lastRun(kind: OffsiteRunKind, ok?: boolean): Promise<Date | null> {
  const row = await controlDb().offsiteRun.findFirst({ where: { kind, ...(ok ? { status: "SUCCEEDED" } : {}) }, orderBy: { startedAt: "desc" }, select: { startedAt: true } });
  return row?.startedAt ?? null;
}

/** Which chores are due now. */
export async function dueChores(now = new Date()): Promise<Chore[]> {
  const clockNow = await consoleClock();
  const hour = clockNow.parts(now).hour;
  const configured = !!(await offsiteSetup()).config;
  const since = (at: Date | null) => (at ? now.getTime() - at.getTime() : Infinity);
  const due: Chore[] = [];

  const check = await lastClockCheck();
  if (since(check ? new Date(check.at) : null) > 23 * HOUR) due.push("clock");
  // Tonight's, once: after 01:00 and not yet done since the console's midnight — tried again two hours
  // after a failure, so a passing problem doesn't cost a whole night.
  const today = clockNow.startOfDay(clockNow.today(now)) ?? now;
  const nightly = async (kind: OffsiteRunKind) => {
    const [ok, tried] = await Promise.all([lastRun(kind, true), lastRun(kind)]);
    return hour >= 1 && (!ok || ok < today) && (!tried || tried < today || since(tried) > 2 * HOUR);
  };
  if (await nightly("CONTROL_DUMP")) due.push("control");
  if (configured && since(await lastRun("SYNC")) > 55 * 60_000) due.push("sync");
  if (await nightly("LOGS")) due.push("logs");
  if (configured && hour >= 3 && hour < 7 && since(await lastRun("DRILL")) > 6.5 * 24 * HOUR) due.push("drill");
  return due;
}

/** A "Run now" from the console, waiting for the worker: the chore, who asked, and for a drill the workspace. */
export type ChoreRequest = { chore: Chore; by: string; tenantId: string | null; at: string };

export async function requestChore(request: Omit<ChoreRequest, "at">): Promise<void> {
  await setSetting("offsite.requested", JSON.stringify({ ...request, at: new Date().toISOString() }), request.by);
}

export async function pendingRequest(): Promise<ChoreRequest | null> {
  try {
    const raw = await getSetting("offsite.requested");
    const parsed = raw ? (JSON.parse(raw) as ChoreRequest) : null;
    return parsed && (CHORES as readonly string[]).includes(parsed.chore) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * What the worker calls between its other work: a chore asked for from the console first, then any
 * that are due, one after another. Returns what ran.
 */
export async function runDueChores(now = new Date()): Promise<ChoreOutcome[]> {
  const outcomes: ChoreOutcome[] = [];
  const asked = await pendingRequest();
  if (asked) {
    await setSetting("offsite.requested", null, "offsite");
    outcomes.push(await runChore(asked.chore, asked.by, { tenantId: asked.tenantId }));
  }
  for (const chore of await dueChores(now)) outcomes.push(await runChore(chore, "worker"));
  return outcomes;
}

import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { openBackupFileTo } from "@/lib/backup/at-rest";
import { reassemble, type Manifest } from "@/lib/backup/chunks";
import { backupBase } from "@/lib/backup/maintenance";
import { parseDatabaseUrl } from "@/lib/backup/policy";
import { runRestore, stageForTool } from "@/lib/backup/restore-tool";
import { resolveDumpTool } from "@/lib/backup/run";
import { CONTROL_SEAL, controlDumpTakenAt } from "@/lib/offsite/control";
import type { OffsiteStore } from "@/lib/offsite/store";
import { controlDb } from "@/lib/platform/control-db";
import { createWorkspaceDatabase, dropWorkspaceDatabase, withoutRoleLimits } from "@/lib/platform/provisioner";
import { directClient } from "@/lib/tenancy/direct-client";

/**
 * The restore drill: a backup fetched back from the off-site store and restored, to prove the copies
 * there are backups and not just files (docs/runbook.md §4 asked for a restore every quarter; this does
 * one a week without anybody remembering to).
 *
 * Exactly the path a disaster would take, from the store rather than this server's disk: the newest
 * backup of a workspace — its manifest and every piece, or its full file — downloaded into a scratch
 * folder, decrypted and checked against the checksum recorded when it was taken (src/lib/backup/chunks.ts
 * `reassemble`), restored with pg_restore into a scratch database made like a workspace's own, then read:
 * its newest migration must be the one the backup recorded, and it must have people in it. The scratch
 * database is dropped afterwards; its name is on the run until then, so a drill that dies part-way is
 * cleaned up by the next.
 *
 * Which workspace: the one drilled longest ago (never, first). The control plane's newest dump is drilled
 * too, as its own run — without it no workspace backup can be opened on another server.
 */

export type DrillOutcome = { ok: boolean; summary: string; error: string | null; tenantId: string | null; seconds: number; bytes: number };

const workDir = (runId: string) => path.join(backupBase(), "platform", "drill", runId);

/** Scratch databases of drills that died before dropping them. */
export async function dropLeftoverScratch(): Promise<number> {
  const control = controlDb();
  const stuckBefore = new Date(Date.now() - 6 * 3_600_000);
  const left = await control.offsiteRun.findMany({
    where: { kind: "DRILL", scratchDb: { not: null }, OR: [{ status: { not: "RUNNING" } }, { startedAt: { lt: stuckBefore } }] },
    select: { id: true, scratchDb: true, status: true },
  });
  for (const run of left) {
    await dropWorkspaceDatabase(run.scratchDb!, run.scratchDb!).catch(() => {});
    const died = run.status === "RUNNING" ? { status: "FAILED" as const, finishedAt: new Date(), error: "Stopped before it finished." } : {};
    await control.offsiteRun.update({ where: { id: run.id }, data: { scratchDb: null, ...died } });
  }
  return left.length;
}

/** The workspace to drill: named, or the one with backups off-site that was drilled longest ago. */
export async function drillCandidate(tenantId?: string | null): Promise<{ id: string; slug: string } | null> {
  const control = controlDb();
  if (tenantId) return control.tenant.findUnique({ where: { id: tenantId }, select: { id: true, slug: true } });
  const rows = await control.offsiteWorkspace.findMany({ where: { backups: { gt: 0 } }, orderBy: [{ lastDrillAt: { sort: "asc", nulls: "first" } }], select: { tenantId: true }, take: 50 });
  if (rows.length === 0) return null;
  const live = await control.tenant.findMany({ where: { id: { in: rows.map((r) => r.tenantId) }, status: { in: ["ACTIVE", "SUSPENDED"] } }, select: { id: true, slug: true } });
  for (const r of rows) {
    const t = live.find((x) => x.id === r.tenantId);
    if (t) return t;
  }
  return null;
}

export type OffsiteBackup = { kind: "manifest"; key: string; manifest: Manifest; takenAt: Date } | { kind: "dump"; key: string; takenAt: Date };

/** A workspace's backups off-site, newest first, each with when it was taken. */
export async function offsiteBackups(store: OffsiteStore, tenantId: string): Promise<OffsiteBackup[]> {
  const prefix = `backups/workspaces/${tenantId}/`;
  const [manifests, dumps] = await Promise.all([store.list(`${prefix}manifests/`), store.list(`${prefix}dumps/`)]);
  const found: OffsiteBackup[] = [];
  for (const o of manifests.objects) {
    const raw = await store.get(o.key);
    if (!raw) continue;
    let manifest: Manifest;
    try {
      manifest = JSON.parse(raw.toString("utf8")) as Manifest;
    } catch {
      continue;
    }
    if (Array.isArray(manifest.chunks)) found.push({ kind: "manifest", key: o.key, manifest, takenAt: new Date(manifest.takenAt ?? o.modified ?? 0) });
  }
  for (const o of dumps.objects) {
    if (!o.key.endsWith(".dump")) continue;
    let takenAt = o.modified ?? new Date(0);
    const sidecar = await store.get(`${o.key}.json`).catch(() => null);
    try {
      if (sidecar) takenAt = new Date((JSON.parse(sidecar.toString("utf8")) as { takenAt: string }).takenAt);
    } catch {
      // The file's own time, then.
    }
    found.push({ kind: "dump", key: o.key, takenAt });
  }
  return found.sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime());
}

/**
 * One backup fetched from the store and made into a plain dump at `plain`, ready for pg_restore: a chunked
 * one's pieces downloaded and reassembled (every piece and the whole checked against their hashes), a
 * full one downloaded and opened. Returns the bytes fetched.
 */
export async function fetchBackup(store: OffsiteStore, tenantId: string, backup: OffsiteBackup, work: string, plain: string): Promise<number> {
  let bytes = 0;
  await mkdir(work, { recursive: true });
  if (backup.kind === "manifest") {
    const prefix = `backups/workspaces/${tenantId}/chunks/`;
    for (const hash of new Set(backup.manifest.chunks)) {
      const target = path.join(work, ".chunks", hash.slice(0, 2), `${hash}.gz`);
      await mkdir(path.dirname(target), { recursive: true });
      if (!(await store.getToFile(`${prefix}${hash.slice(0, 2)}/${hash}.gz`, target))) throw new Error(`A piece of the backup is missing off-site (${hash.slice(0, 12)}…).`);
      bytes += (await stat(target)).size;
    }
    await reassemble(work, backup.manifest, plain, tenantId);
  } else {
    const sealed = path.join(work, "backup.dump");
    if (!(await store.getToFile(backup.key, sealed))) throw new Error("The backup disappeared from the store while it was being fetched.");
    bytes += (await stat(sealed)).size;
    await openBackupFileTo(tenantId, sealed, plain);
  }
  return bytes;
}

/** Restores `file` into a fresh scratch database, reads it with `check`, and drops it. */
async function restoreAndRead(runId: string, file: string, check: (url: string) => Promise<string>): Promise<string> {
  const tool = await resolveDumpTool("pg_restore");
  if (!tool) throw new Error("pg_restore could not be found — not on the PATH, not at PG_DUMP_PATH, and not in the database container.");
  const scratch = await createWorkspaceDatabase();
  const control = controlDb();
  await control.offsiteRun.update({ where: { id: runId }, data: { scratchDb: scratch.dbName } });
  try {
    const connection = parseDatabaseUrl(scratch.url);
    if (!connection) throw new Error("The scratch database's address couldn't be read.");
    const staged = await stageForTool(tool, file);
    try {
      // As a real restore does: without the workspace role's time limits, which a large COPY outlasts.
      await withoutRoleLimits(scratch.dbRole, () => runRestore(tool, staged.pathForTool, connection));
    } finally {
      await staged.cleanup();
    }
    return await check(scratch.url);
  } finally {
    await dropWorkspaceDatabase(scratch.dbName, scratch.dbRole).catch((err) => console.error("[drill] the scratch database could not be dropped", err));
    await control.offsiteRun.update({ where: { id: runId }, data: { scratchDb: null } }).catch(() => {});
  }
}

async function readBack<T>(url: string, work: (q: (sql: string) => Promise<Record<string, unknown>[]>) => Promise<T>): Promise<T> {
  const client = directClient(url, { max: 1 });
  try {
    return await work((sql) => client.$queryRawUnsafe<Record<string, unknown>[]>(sql));
  } finally {
    await client.$disconnect().catch(() => {});
  }
}

const sizeText = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** Drills one workspace's newest off-site backup. `runId` is its OffsiteRun, already started. */
export async function drillWorkspace(store: OffsiteStore, runId: string, tenant: { id: string; slug: string }): Promise<DrillOutcome> {
  const started = Date.now();
  const work = workDir(runId);
  let bytes = 0;
  try {
    const [newest] = await offsiteBackups(store, tenant.id);
    if (!newest) throw new Error(`${tenant.slug} has no backups off-site to restore.`);
    const plain = path.join(work, "restore.dump");
    bytes = await fetchBackup(store, tenant.id, newest, work, plain);

    const expected = newest.kind === "manifest" ? (newest.manifest.schemaVersion ?? null) : null;
    const found = await restoreAndRead(runId, plain, (url) =>
      readBack(url, async (q) => {
        const [migration] = await q(`SELECT migration_name::text AS name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`);
        const [tables] = await q(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = current_schema()`);
        const [people] = await q(`SELECT count(*)::int AS n FROM "users"`);
        const name = String(migration?.name ?? "");
        if (!name) throw new Error("The restored database has no migrations recorded.");
        if (expected && name !== expected) throw new Error(`The restored database is at ${name}, but the backup says ${expected}.`);
        if (Number(people?.n ?? 0) < 1) throw new Error("The restored database has nobody in it.");
        return `${Number(tables?.n ?? 0)} tables, ${Number(people?.n ?? 0)} people, at ${name}`;
      }),
    );
    const seconds = Math.round((Date.now() - started) / 1000);
    const summary = `${tenant.slug}: the backup taken ${newest.takenAt.toISOString().slice(0, 16).replace("T", " ")} UTC (${sizeText(bytes)} off-site) restored in ${seconds} s — ${found}.`;
    return { ok: true, summary, error: null, tenantId: tenant.id, seconds, bytes };
  } catch (err) {
    const seconds = Math.round((Date.now() - started) / 1000);
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, summary: `${tenant.slug}: the restore failed after ${seconds} s.`, error, tenantId: tenant.id, seconds, bytes };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/** Drills the control plane's newest off-site dump. */
export async function drillControlPlane(store: OffsiteStore, runId: string): Promise<DrillOutcome> {
  const started = Date.now();
  const work = workDir(runId);
  let bytes = 0;
  try {
    const { objects } = await store.list("backups/control/");
    const newest = objects
      .map((o) => ({ key: o.key, takenAt: controlDumpTakenAt(o.key) }))
      .filter((o): o is { key: string; takenAt: Date } => !!o.takenAt)
      .sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime())[0];
    if (!newest) throw new Error("There is no control plane dump off-site to restore.");
    await mkdir(work, { recursive: true });
    const sealed = path.join(work, "control.dump");
    const plain = path.join(work, "restore.dump");
    if (!(await store.getToFile(newest.key, sealed))) throw new Error("The dump disappeared from the store while it was being fetched.");
    bytes = (await stat(sealed)).size;
    await openBackupFileTo(CONTROL_SEAL, sealed, plain);
    const found = await restoreAndRead(runId, plain, (url) =>
      readBack(url, async (q) => {
        const [migration] = await q(`SELECT migration_name::text AS name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`);
        const [tenants] = await q(`SELECT count(*)::int AS n FROM "tenants"`);
        if (!migration?.name) throw new Error("The restored control plane has no migrations recorded.");
        if (Number(tenants?.n ?? 0) < 1) throw new Error("The restored control plane has no workspaces in it.");
        return `${Number(tenants?.n ?? 0)} workspaces, at ${String(migration.name)}`;
      }),
    );
    const seconds = Math.round((Date.now() - started) / 1000);
    return { ok: true, summary: `Control plane: the dump taken ${newest.takenAt.toISOString().slice(0, 16).replace("T", " ")} UTC (${sizeText(bytes)}) restored in ${seconds} s — ${found}.`, error: null, tenantId: null, seconds, bytes };
  } catch (err) {
    const seconds = Math.round((Date.now() - started) / 1000);
    return { ok: false, summary: `Control plane: the restore failed after ${seconds} s.`, error: err instanceof Error ? err.message : String(err), tenantId: null, seconds, bytes };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

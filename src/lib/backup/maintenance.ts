import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_BACKUP_DIR } from "@/lib/backup/policy";

/**
 * What a restore is doing, kept somewhere a restore cannot destroy.
 *
 * Every other piece of state in this application lives in Postgres. This one cannot: a restore
 * drops the schema and replaces it with the contents of a file, so a progress row written in the
 * database would be erased halfway through by the very operation it was describing — and the row
 * that came back in its place would be whatever the backup happened to contain. A restore that
 * fails at the worst moment has to leave a readable account of itself, so the account lives on
 * disk, beside the backups.
 *
 * Two files, and the separation matters:
 *
 *   · `restore.lock`  — exists only while a restore is in flight. `src/proxy.ts` checks it on every
 *                       request and holds the application at a maintenance page, because the
 *                       alternative is serving pages off a database whose tables are being dropped.
 *   · `restore.json`  — the last run's progress and outcome. Survives the lock, so the screen can
 *                       still say what happened after the lock is gone.
 *
 * The lock is a file rather than a flag in memory because the process that sets it and the process
 * that clears it are different ones: the restore runs detached so it outlives the request that
 * started it, which is the only way for the web process to be allowed to go quiet while the schema
 * underneath it is replaced.
 */

export const RESTORE_DIR_NAME = ".restore";
const LOCK_FILE = "restore.lock";
const STATUS_FILE = "restore.json";

/**
 * How long a lock is believed.
 *
 * A worker killed by the platform — a container revision replaced, an OOM, a host reboot — never
 * reaches its own cleanup, and a lock nobody clears is an application that never serves another
 * page. So the lock carries the time it was taken and anything older than this is treated as
 * abandoned. Generous, because a large restore genuinely takes a while and clearing the lock out
 * from under a live `pg_restore` would be worse than waiting.
 */
export const LOCK_STALE_AFTER_MS = 60 * 60 * 1000;

export type RestorePhase =
  | "staged"
  | "opening"
  | "dropping"
  | "restoring"
  | "done"
  | "failed";

export type RestoreStatus = {
  id: string;
  phase: RestorePhase;
  /** One sentence for a person watching the screen. */
  message: string;
  startedAt: string;
  finishedAt: string | null;
  /** The archive this came from, for the log. */
  archiveName: string | null;
  takenAt: string | null;
  /** Set only when the archive carried a secret this instance is not running under. */
  secretHandoffPath: string | null;
  error: string | null;
};

export function backupRoot(): string {
  return path.resolve(process.env.BACKUP_DIR?.trim() || DEFAULT_BACKUP_DIR);
}

export function restoreDir(): string {
  return path.join(backupRoot(), RESTORE_DIR_NAME);
}

export function lockPath(): string {
  return path.join(restoreDir(), LOCK_FILE);
}

export function statusPath(): string {
  return path.join(restoreDir(), STATUS_FILE);
}

export async function ensureRestoreDir(): Promise<string> {
  const dir = restoreDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Whether a restore is in flight, answered synchronously.
 *
 * `src/proxy.ts` runs on every request and cannot await a database round trip to decide whether to
 * serve a page, so this is two stat-sized syscalls and no I/O beyond them. It deliberately does not
 * throw: a backup directory that is missing, unreadable or on a mount that has gone away must read
 * as "no restore running" and let the application serve, rather than locking everybody out because
 * of a permissions problem on a folder most requests have nothing to do with.
 */
export function restoreInProgress(now = Date.now()): boolean {
  try {
    const file = lockPath();
    if (!existsSync(file)) return false;
    const raw = readFileSync(file, "utf8");
    const startedAt = Date.parse(JSON.parse(raw)?.startedAt ?? "");
    if (!Number.isFinite(startedAt)) return true;
    return now - startedAt < LOCK_STALE_AFTER_MS;
  } catch {
    return false;
  }
}

export async function takeLock(id: string, startedAt = new Date()): Promise<void> {
  await ensureRestoreDir();
  await writeFile(lockPath(), JSON.stringify({ id, startedAt: startedAt.toISOString() }), "utf8");
}

export async function releaseLock(): Promise<void> {
  await rm(lockPath(), { force: true }).catch(() => {});
}

/**
 * Writes the status, atomically.
 *
 * Written to a neighbouring file and renamed, because the page polls this several times a second
 * while the worker is writing it. A reader that catches a partial write gets unparseable JSON, and
 * the screen would flicker between "restoring" and "we cannot tell" for no reason. A rename within
 * one directory is atomic on every filesystem this runs on.
 */
export async function writeRestoreStatus(status: RestoreStatus): Promise<void> {
  await ensureRestoreDir();
  const target = statusPath();
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(status, null, 2), "utf8");
  await rename(temp, target);
}

export async function readRestoreStatus(): Promise<RestoreStatus | null> {
  try {
    const raw = await readFile(statusPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<RestoreStatus>;
    if (typeof parsed.id !== "string" || typeof parsed.phase !== "string") return null;
    return {
      id: parsed.id,
      phase: parsed.phase as RestorePhase,
      message: parsed.message ?? "",
      startedAt: parsed.startedAt ?? "",
      finishedAt: parsed.finishedAt ?? null,
      archiveName: parsed.archiveName ?? null,
      takenAt: parsed.takenAt ?? null,
      secretHandoffPath: parsed.secretHandoffPath ?? null,
      error: parsed.error ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Where an upload waits between being received and being confirmed.
 *
 * Its own folder under the restore directory so the pruner, which sweeps `backups/` by filename
 * pattern, never sees these and never deletes one out from under a confirmation screen.
 */
export function stagingPath(id: string, suffix: string): string {
  return path.join(restoreDir(), `staged-${id}${suffix}`);
}

/**
 * Removes everything a staged upload left behind.
 *
 * Both halves, always: the sealed archive as uploaded and the plain dump extracted from it. The
 * second is the one that matters — an unsealed dump is a complete, readable copy of the business,
 * and leaving one in a directory after a cancelled restore would undo the entire reason the archive
 * is encrypted in the first place.
 */
export async function clearStaged(id: string): Promise<void> {
  await Promise.all([
    rm(stagingPath(id, ".wbak"), { force: true }).catch(() => {}),
    rm(stagingPath(id, ".dump"), { force: true }).catch(() => {}),
    rm(stagingPath(id, ".meta.json"), { force: true }).catch(() => {}),
  ]);
}

/**
 * What a dump staged from this server's own backup folder is.
 *
 * An uploaded archive carries its own header, so nothing has to be remembered about it. A backup
 * already on this server does not: it is staged as a bare `.dump`, and the two facts a restore
 * reports — when it was taken and which schema it holds — live in the sidecar next to the original,
 * which the staged copy has left behind. So they are copied forward into this.
 *
 * Its presence is also what tells the restore route which kind of staging it is looking at, and
 * therefore whether a passphrase is required at all.
 */
export type StagedMeta = {
  takenAt: string | null;
  schemaVersion: string | null;
  secretFingerprint: string | null;
  /** The filename in the backup folder this was copied from, for the log. */
  source: string;
};

export async function writeStagedMeta(id: string, meta: StagedMeta): Promise<void> {
  await ensureRestoreDir();
  await writeFile(stagingPath(id, ".meta.json"), JSON.stringify(meta, null, 2), "utf8");
}

export async function readStagedMeta(id: string): Promise<StagedMeta | null> {
  try {
    const parsed = JSON.parse(await readFile(stagingPath(id, ".meta.json"), "utf8")) as Partial<StagedMeta>;
    if (typeof parsed.source !== "string") return null;
    return {
      takenAt: parsed.takenAt ?? null,
      schemaVersion: parsed.schemaVersion ?? null,
      secretFingerprint: parsed.secretFingerprint ?? null,
      source: parsed.source,
    };
  } catch {
    return null;
  }
}

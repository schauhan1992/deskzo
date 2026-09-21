import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { writeSidecar, sidecarPath } from "@/lib/backup/sidecar";
import { secretFingerprint } from "@/lib/backup/fingerprint";
import { RUNNING_PRESUMED_DEAD_MINUTES } from "@/lib/backup/schedule";
import {
  DEFAULT_BACKUP_DIR,
  backupFilename,
  parseDatabaseUrl,
  prunable,
  type Connection,
} from "@/lib/backup/policy";

/**
 * Running pg_dump, and recording what happened.
 *
 * Deliberately not a `"use server"` module. Every export from one is a public endpoint, and this
 * spawns a process and writes files — `check:rbac` refuses an ungated action for exactly this
 * reason, and the answer is not to bolt a permission check onto it but to keep it off the wire. The
 * callable surface is `src/actions/backup.ts`, which checks a permission and then calls in here.
 */

export type DumpTool = {
  command: string;
  args: string[];
  via: string;
  /**
   * True when the command runs *inside* the database container.
   *
   * The host and port in `DATABASE_URL` describe how the host machine reaches Postgres — through
   * a published port. Inside the container none of that applies: the server is on its own
   * loopback at its own port, and passing the host's view would have pg_dump trying to reach the
   * database through a port mapping that does not exist from where it is standing.
   */
  inContainer?: boolean;
};

/**
 * Where pg_dump actually is.
 *
 * Three places, tried in order, because all three are real deployments of this app:
 *
 * 1. `PG_DUMP_PATH`, when somebody has told us. Nothing beats being told.
 * 2. On the PATH, which is the case on a Linux host with the client tools installed, and for a
 *    managed Postgres where there is no container to exec into.
 * 3. Inside the compose container, which is this project's own development setup and a common small
 *    production one. The host has no pg_dump at all there, and guessing wrong produces "command not
 *    found" rather than a backup.
 *
 * Resolved at run time rather than configured once, so moving from Docker to a managed database
 * does not need a settings change to keep the backups working.
 */
export async function resolveDumpTool(binary: "pg_dump" | "pg_restore" | "psql"): Promise<DumpTool | null> {
  const configured = process.env.PG_DUMP_PATH?.trim();
  if (configured) {
    const dir = path.dirname(configured);
    const named = path.join(dir, binary + path.extname(configured));
    if (await runs(named, ["--version"])) return { command: named, args: [], via: "configured path" };
  }

  if (await runs(binary, ["--version"])) return { command: binary, args: [], via: "host" };

  const service = process.env.BACKUP_DB_SERVICE?.trim() || "postgres";
  const viaDocker: DumpTool = {
    command: "docker",
    args: ["compose", "exec", "-T", service, binary],
    via: `docker compose (${service})`,
    inContainer: true,
  };
  if (await runs(viaDocker.command, [...viaDocker.args, "--version"])) return viaDocker;

  return null;
}

function runs(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: false });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

export type BackupOutcome =
  | { ok: true; id: string; filename: string; sizeBytes: number; via: string; pruned: number }
  | { ok: false; id: string | null; error: string };

/**
 * Takes one backup.
 *
 * The record is written *before* pg_dump starts and updated after, so a run that is killed half way
 * leaves a `RUNNING` row rather than nothing. A backup log that only contains successes cannot tell
 * anybody that the nightly job has been dying since March, which is the single most useful thing a
 * backup log can say.
 */
export async function runBackup(options?: {
  triggeredById?: string | null;
  /** From the stored schedule when one drove this run; falls back to the environment and the defaults. */
  keepDays?: number;
  keepMinimum?: number;
}): Promise<BackupOutcome> {
  const connection = parseDatabaseUrl(process.env.DATABASE_URL);
  if (!connection) return { ok: false, id: null, error: "DATABASE_URL is missing or not a Postgres URL." };

  const tool = await resolveDumpTool("pg_dump");
  if (!tool) {
    return {
      ok: false,
      id: null,
      error:
        "pg_dump could not be found — not on the PATH, not at PG_DUMP_PATH, and not in the database container. Install the Postgres client tools or set PG_DUMP_PATH.",
    };
  }

  const directory = path.resolve(process.env.BACKUP_DIR?.trim() || DEFAULT_BACKUP_DIR);
  await mkdir(directory, { recursive: true });

  const startedAt = new Date();
  const filename = backupFilename(startedAt);

  const record = await db.backup.create({
    data: {
      filename,
      directory,
      status: "RUNNING",
      startedAt,
      via: tool.via,
      schemaVersion: await latestMigration(),
      secretFingerprint: secretFingerprint(process.env.AUTH_SECRET),
      triggeredById: options?.triggeredById ?? null,
    },
    select: { id: true },
  });

  try {
    await dump(tool, connection, path.join(directory, filename));
    const { size } = await stat(path.join(directory, filename));

    /**
     * An empty or near-empty file is a failed dump that exited zero, which does happen — a broken
     * pipe through `docker exec` is the usual way. Treating it as a success is how somebody
     * discovers their backups are 0 bytes on the day they need one.
     */
    if (size < 1024) {
      throw new Error(`The dump is only ${size} bytes, which cannot be a whole database.`);
    }

    // Written after the dump, so a sidecar existing means the file beside it is complete.
    await writeSidecar(path.join(directory, filename), {
      filename,
      takenAt: startedAt.toISOString(),
      schemaVersion: await latestMigration(),
      secretFingerprint: secretFingerprint(process.env.AUTH_SECRET),
      via: tool.via,
      sizeBytes: size,
      app: "Wroffy ERP",
    });

    await db.backup.update({
      where: { id: record.id },
      data: { status: "SUCCEEDED", finishedAt: new Date(), sizeBytes: BigInt(size) },
    });

    const pruned = await pruneOldBackups(directory, {
      keepDays: options?.keepDays,
      keepMinimum: options?.keepMinimum,
    });
    return { ok: true, id: record.id, filename, sizeBytes: size, via: tool.via, pruned };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await db.backup.update({
      where: { id: record.id },
      data: { status: "FAILED", finishedAt: new Date(), error },
    });
    // The part-written file goes with it, so a failed run cannot be mistaken for a restorable one.
    await rm(path.join(directory, filename), { force: true }).catch(() => {});
    await rm(sidecarPath(path.join(directory, filename)), { force: true }).catch(() => {});
    return { ok: false, id: record.id, error };
  }
}

function dump(tool: DumpTool, connection: Connection, target: string): Promise<void> {
  /**
   * Custom format, compressed. It is what `pg_restore` can read selectively and in parallel, and it
   * is a third the size of plain SQL — which matters when the thing has to be copied off the box.
   *
   * `--no-owner` and `--no-privileges`, because a restore into a differently-named role would
   * otherwise fail on every `ALTER TABLE ... OWNER TO` in the file. The application owns its own
   * schema; the role that happens to hold it is a property of the machine, not of the data.
   *
   * The password goes in the environment rather than the command line, where it would be visible to
   * anybody running `ps`.
   */
  /**
   * Inside the container, no `--host` at all.
   *
   * Two problems solve each other here. The host and port from `DATABASE_URL` describe how the
   * *host machine* reaches Postgres, through a published port that does not exist from inside;
   * and `PGPASSWORD` set on this process does not cross into a `docker compose exec`, so a TCP
   * connection in there would have no password to offer.
   *
   * Omitting the host makes libpq use the local unix socket, which the official Postgres image
   * trusts. No port mapping to get wrong and no password to smuggle across. If an image has been
   * configured to demand one on local connections too, pg_dump says so plainly and the message
   * reaches the backup record.
   */
  const connectionArgs = tool.inContainer
    ? []
    : [`--host=${connection.host}`, `--port=${connection.port}`];

  const args = [
    ...tool.args,
    "--format=custom",
    "--compress=6",
    "--no-owner",
    "--no-privileges",
    ...connectionArgs,
    `--username=${connection.user}`,
    connection.database,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(tool.command, args, {
      env: { ...process.env, PGPASSWORD: connection.password },
      shell: false,
    });

    /**
     * Written by us rather than by `--file`, because through `docker compose exec` the container
     * has no access to the host's filesystem — the dump has to come back over stdout. Doing it the
     * same way in both cases means one code path rather than two, and the one that only runs in
     * production is never the tested one.
     */
    const out = createWriteStream(target);
    child.stdout.pipe(out);

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (err) => reject(new Error(`Could not run ${tool.command}: ${err.message}`)));
    child.on("close", (code) => {
      out.end();
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `pg_dump exited with code ${code}.`));
    });
  });
}


/**
 * The migration the schema is on.
 *
 * Read from Prisma's own table rather than from the filesystem, because the question is what this
 * *database* is on, and a checkout can be ahead of the database it is pointed at.
 */
async function latestMigration(): Promise<string | null> {
  try {
    const rows = await db.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL
      ORDER BY finished_at DESC LIMIT 1
    `;
    return rows[0]?.migration_name ?? null;
  } catch {
    return null;
  }
}

/** Deletes what the retention policy says may go, and the rows that pointed at them. */
export async function pruneOldBackups(
  directory: string,
  retention?: { keepDays?: number; keepMinimum?: number },
): Promise<number> {
  const rows = await db.backup.findMany({
    where: { directory },
    select: { id: true, filename: true, startedAt: true, status: true },
  });

  const doomed = prunable(
    rows.map((r) => ({
      filename: r.filename,
      takenAt: r.startedAt,
      // A run in progress is still being written to, and a failed one has no file to delete but its
      // row is the evidence that it failed. Neither is age-pruned.
      keep: r.status !== "SUCCEEDED",
    })),
    new Date(),
    {
      keepDays: retention?.keepDays ?? (Number(process.env.BACKUP_KEEP_DAYS) || undefined),
      keepMinimum: retention?.keepMinimum ?? (Number(process.env.BACKUP_KEEP_MINIMUM) || undefined),
    },
  );

  for (const file of doomed) {
    const dump = path.join(directory, file.filename);
    await rm(dump, { force: true }).catch(() => {});
    // The sidecar goes with its dump. Left behind it is a description of a file that is not there.
    await rm(sidecarPath(dump), { force: true }).catch(() => {});
  }
  if (doomed.length > 0) {
    await db.backup.deleteMany({
      where: { directory, filename: { in: doomed.map((f) => f.filename) } },
    });
  }
  return doomed.length;
}

/** Files actually present, for spotting a row whose file somebody moved or deleted by hand. */
export async function filesOnDisk(directory: string): Promise<Set<string>> {
  try {
    return new Set((await readdir(directory)).filter((f) => f.endsWith(".dump")));
  } catch {
    return new Set();
  }
}

/**
 * Settles runs that say `RUNNING` and are not.
 *
 * Two ways a row gets stuck there, and the second one is guaranteed rather than unlucky:
 *
 *  1. The process was killed mid-dump. Nothing was left to write the closing status.
 *  2. **A restore.** The row is written *before* pg_dump starts, so every dump contains its own row
 *     in the `RUNNING` state. Restore that dump and the backup it came from is permanently mid-run,
 *     for ever, by construction. The one row you can be certain will be stuck is the one belonging
 *     to the backup you just restored.
 *
 * That used to be cosmetic. It stopped being cosmetic when the schedule learned not to start a
 * backup while one is running: a stuck row is then a schedule that has quietly switched itself off.
 * `RUNNING_PRESUMED_DEAD_MINUTES` keeps that from lasting, and this resolves it properly.
 *
 * The evidence is on disk, which is why this is a reconciliation rather than a guess: a complete
 * file of a plausible size means the dump finished, and its absence means it did not. `finishedAt`
 * comes from the file's own timestamp rather than now, so a run settled a week later does not claim
 * to have finished a week late.
 */
export async function settleStaleRuns(directory: string, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - RUNNING_PRESUMED_DEAD_MINUTES * 60000);
  const stuck = await db.backup.findMany({
    where: { status: "RUNNING", startedAt: { lt: cutoff } },
    select: { id: true, filename: true, directory: true },
  });

  for (const row of stuck) {
    const file = path.join(row.directory || directory, row.filename);
    const info = await stat(file).catch(() => null);

    if (info?.isFile() && info.size >= 1024) {
      await db.backup.update({
        where: { id: row.id },
        data: { status: "SUCCEEDED", finishedAt: info.mtime, sizeBytes: BigInt(info.size) },
      });
    } else {
      await db.backup.update({
        where: { id: row.id },
        data: {
          status: "FAILED",
          finishedAt: now,
          error: "Interrupted — the run never finished and left no complete file behind.",
        },
      });
    }
  }

  return stuck.length;
}

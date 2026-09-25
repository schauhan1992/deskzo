import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { writeSidecar, sidecarPath } from "@/lib/backup/sidecar";
import { collectGarbage, manifestExists, manifestPath, storeDump, writeManifest } from "@/lib/backup/chunks";
import type { BackupKind } from "@prisma/client";
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
  | {
      ok: true;
      id: string;
      filename: string;
      /** The size of the snapshot, whichever way it was stored. */
      sizeBytes: number;
      /**
       * What this run actually put on disk.
       *
       * The same as `sizeBytes` for a FULL backup, and usually a small fraction of it for a chunked
       * one. Reported separately because "38 MB backed up, 900 KB written" is the sentence that
       * makes an incremental backup believable, and one number cannot say it.
       */
      storedBytes: number;
      kind: BackupKind;
      via: string;
      pruned: number;
    }
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
  /**
   * FULL writes one standalone file. INCREMENTAL splits the same snapshot into the shared chunk
   * store and writes only what changed. Defaults to FULL, because the standalone file is the one
   * that survives losing this machine.
   */
  kind?: BackupKind;
}): Promise<BackupOutcome> {
  const kind: BackupKind = options?.kind ?? "FULL";
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
  /**
   * A chunked backup has no single file, so its name ends `.chunked` rather than `.dump`.
   *
   * It still gets a name because the log, the pruner and the sort order are all built on one, and
   * because "which backup is this" should be answerable without joining to the manifest. The
   * extension is the honest part: somebody looking in the folder for `.chunked` will not find it,
   * and should not go looking for a file that was never written.
   */
  const filename = kind === "FULL" ? backupFilename(startedAt) : backupFilename(startedAt).replace(/\.dump$/, ".chunked");

  const record = await db.backup.create({
    data: {
      filename,
      directory,
      status: "RUNNING",
      kind,
      startedAt,
      via: tool.via,
      schemaVersion: await latestMigration(),
      secretFingerprint: secretFingerprint(process.env.AUTH_SECRET),
      triggeredById: options?.triggeredById ?? null,
    },
    select: { id: true },
  });

  /**
   * Where the dump lands before anything is decided about it.
   *
   * A FULL backup writes straight to its final name. A chunked one writes to a working file that is
   * read into the store and then deleted — it is never a backup in its own right, and leaving one
   * behind would put an unreferenced complete copy of the database in the backup folder, which is
   * exactly what the store exists to avoid.
   */
  const workingPath =
    kind === "FULL" ? path.join(directory, filename) : path.join(directory, `.${filename}.building`);

  try {
    /**
     * Chunked backups dump uncompressed, and this is the decision the whole feature rests on.
     *
     * `--compress=6` puts one deflate stream over the file: change a single row and every byte
     * after it differs, so no two dumps share a chunk and an "incremental" backup stores the entire
     * database every time. Measured in `check:backup` — a compressed pair re-stores 100% against
     * 41% uncompressed on the same change. Compression is applied per chunk in the store instead,
     * so nothing is given up but the similarity is kept.
     */
    await dump(tool, connection, workingPath, kind === "FULL" ? 6 : 0);
    const { size } = await stat(workingPath);

    /**
     * An empty or near-empty file is a failed dump that exited zero, which does happen — a broken
     * pipe through `docker exec` is the usual way. Treating it as a success is how somebody
     * discovers their backups are 0 bytes on the day they need one.
     */
    if (size < 1024) {
      throw new Error(`The dump is only ${size} bytes, which cannot be a whole database.`);
    }

    let storedBytes = size;

    if (kind === "FULL") {
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
    } else {
      const manifest = await storeDump(directory, workingPath);
      await writeManifest(directory, record.id, manifest);
      storedBytes = manifest.newBytes;
      // The working copy goes as soon as its pieces are safely in the store. Until this line there
      // are two complete copies of the database on disk; after it, one.
      await rm(workingPath, { force: true }).catch(() => {});
    }

    await db.backup.update({
      where: { id: record.id },
      data: {
        status: "SUCCEEDED",
        finishedAt: new Date(),
        sizeBytes: BigInt(size),
        storedBytes: BigInt(storedBytes),
      },
    });

    const pruned = await pruneOldBackups(directory, {
      keepDays: options?.keepDays,
      keepMinimum: options?.keepMinimum,
    });
    return { ok: true, id: record.id, filename, sizeBytes: size, via: tool.via, pruned, kind, storedBytes };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await db.backup.update({
      where: { id: record.id },
      data: { status: "FAILED", finishedAt: new Date(), error },
    });
    // The part-written file goes with it, so a failed run cannot be mistaken for a restorable one.
    await rm(workingPath, { force: true }).catch(() => {});
    await rm(path.join(directory, filename), { force: true }).catch(() => {});
    await rm(sidecarPath(path.join(directory, filename)), { force: true }).catch(() => {});
    // A half-written manifest would name pieces that may not all be there. The chunks themselves are
    // left for the sweep: they are addressed by content, so any that were written are either shared
    // with a good backup or unreferenced, and unreferenced is the sweep's job rather than this one's.
    await rm(manifestPath(directory, record.id), { force: true }).catch(() => {});
    return { ok: false, id: record.id, error };
  }
}

function dump(tool: DumpTool, connection: Connection, target: string, compress = 6): Promise<void> {
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
    `--compress=${compress}`,
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

/**
 * Deletes what the retention policy says may go, and the rows that pointed at them.
 *
 * Returns a count rather than the bytes it freed. The freed figure is only knowable for the chunk
 * store and only after the sweep, so a caller reading one number would be comparing "rows" against
 * "bytes of chunks" depending on which kind aged out — and both callers, the settings page and
 * `check:backup`, want the count. `storeSize` answers the disk-usage question honestly instead.
 */
export async function pruneOldBackups(
  directory: string,
  retention?: { keepDays?: number; keepMinimum?: number },
): Promise<number> {
  const rows = await db.backup.findMany({
    where: { directory },
    // `kind` decides what there is to delete: a chunked backup has no file of its own, and deleting
    // by filename would quietly leave its manifest behind pinning chunks nothing can restore.
    select: { id: true, filename: true, kind: true, startedAt: true, status: true },
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

  // Matched back to their rows by the same filename the deletion below uses, so the set whose data
  // is removed and the set whose rows are removed cannot drift apart.
  const doomedNames = new Set(doomed.map((f) => f.filename));
  const doomedRows = rows.filter((r) => doomedNames.has(r.filename));

  let manifestsRemoved = 0;
  for (const row of doomedRows) {
    if (row.kind === "INCREMENTAL") {
      /**
       * A chunked backup is its manifest — there is no `.dump` and no sidecar to delete, and the
       * chunks it names are deliberately left alone here. See the sweep below for why.
       */
      if (await manifestExists(directory, row.id)) {
        await rm(manifestPath(directory, row.id), { force: true }).catch(() => {});
        manifestsRemoved += 1;
      }
      continue;
    }
    const dump = path.join(directory, row.filename);
    await rm(dump, { force: true }).catch(() => {});
    // The sidecar goes with its dump. Left behind it is a description of a file that is not there.
    await rm(sidecarPath(dump), { force: true }).catch(() => {});
  }

  if (doomed.length > 0) {
    await db.backup.deleteMany({
      where: { directory, filename: { in: doomed.map((f) => f.filename) } },
    });
  }

  /**
   * The sweep runs *last*, and the ordering is the safety rather than tidiness.
   *
   * Chunks are shared: two dumps taken a day apart have almost all of their pieces in common, which
   * is the entire point of the store. So deleting "this backup's chunks" as part of pruning it would
   * take pieces out from under every other backup that shares them — most of them — leaving
   * manifests that still name hashes nobody can supply. Nothing would report an error, nothing on
   * the settings page would look different, and it would be discovered at a restore.
   *
   * Mark-and-sweep is the only order that cannot do that: once the doomed manifests are gone, what
   * `collectGarbage` keeps is exactly what the *surviving* manifests name. It is run only when a
   * manifest actually went, because with none removed the answer is a foregone "nothing to free"
   * bought with a read of every manifest and a walk of the whole store.
   */
  if (manifestsRemoved > 0) {
    await collectGarbage(directory);
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
 * Which of these backups still have their data, by row id.
 *
 * "Is the file in the folder" stopped being the whole question once a backup could have no file:
 * a chunked row's `.chunked` name is a label, never written, so a listing check would mark every
 * one of them missing and a settings page would report the store's entire contents as lost.
 * What stands in for the file is the manifest — see `manifestExists` for why the chunks it names
 * are not verified here.
 *
 * Keyed by id rather than filename because that is what a chunked backup is indexed under, and
 * because two rows sharing a name should not vouch for each other.
 */
export async function presentBackups(
  directory: string,
  rows: { id: string; filename: string; kind: BackupKind }[],
): Promise<Set<string>> {
  // One listing for all the FULL rows. A stat per row turns a fifty-row table into fifty syscalls
  // to answer a question one readdir already answered.
  const onDisk = await filesOnDisk(directory);

  const present = new Set<string>();
  for (const row of rows) {
    const there =
      row.kind === "INCREMENTAL" ? await manifestExists(directory, row.id) : onDisk.has(row.filename);
    if (there) present.add(row.id);
  }
  return present;
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

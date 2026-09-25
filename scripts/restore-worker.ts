/**
 * Puts a staged dump back, in a process that outlives the request which asked for it.
 *
 *   npx tsx scripts/restore-worker.ts <staging-id>
 *
 * Not meant to be run by hand — `npm run db:restore` is the command for that, and it is the better
 * one because it talks to you. This is what the Restore button spawns.
 *
 * ## Why this is a separate process at all
 *
 * A restore drops the schema out from under the connection pool the web process is holding. If the
 * request that started it did the work itself, it would be executing `DROP SCHEMA` on a database it
 * is simultaneously reading its own session from, and the response would never arrive: the socket
 * dies with the tables. So the request stages the file, takes the lock, spawns this, and answers
 * immediately. This one is detached, so killing the web process does not kill the restore, and the
 * restore finishing does not depend on anybody keeping a browser tab open.
 *
 * ## Everything it knows is on disk
 *
 * There is no progress row in the database, because the database is the thing being replaced. The
 * status file in `backups/.restore/` is the only record while this runs, and the lock beside it is
 * what holds `src/proxy.ts` at a maintenance page meanwhile.
 *
 * ## The passphrase is not here
 *
 * By the time this starts, the archive has already been opened: the request verified the passphrase
 * and wrote out a plain dump. That is deliberate. A passphrase passed on a command line is visible
 * in `ps` to every user on the box, and one passed in the environment is readable from
 * `/proc/<pid>/environ`. This process never has it and cannot leak it.
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { parseDatabaseUrl } from "../src/lib/backup/policy";
import { resolveDumpTool } from "../src/lib/backup/run";
import {
  clearStaged,
  readRestoreStatus,
  releaseLock,
  stagingPath,
  writeRestoreStatus,
  type RestorePhase,
  type RestoreStatus,
} from "../src/lib/backup/maintenance";
import { db, getTenantDb } from "../src/lib/db";
import { ensurePincodes } from "../prisma/reference/pincodes";
import { ensureGeonames } from "../prisma/reference/geonames";

async function main() {
  const id = process.argv[2];
  if (!id || !/^[a-z0-9-]{6,64}$/i.test(id)) {
    console.error("restore-worker: a staging id is required.");
    process.exit(1);
  }

  const existing = await readRestoreStatus();
  const dumpPath = stagingPath(id, ".dump");

  const status: RestoreStatus = {
    id,
    phase: "opening",
    message: "Checking the staged backup…",
    startedAt: existing?.id === id ? existing.startedAt : new Date().toISOString(),
    finishedAt: null,
    archiveName: existing?.id === id ? existing.archiveName : null,
    takenAt: existing?.id === id ? existing.takenAt : null,
    secretHandoffPath: existing?.id === id ? existing.secretHandoffPath : null,
    error: null,
  };

  const say = async (phase: RestorePhase, message: string) => {
    status.phase = phase;
    status.message = message;
    await writeRestoreStatus(status);
  };

  const fail = async (error: string) => {
    status.phase = "failed";
    status.message = "The restore did not complete.";
    status.error = error;
    status.finishedAt = new Date().toISOString();
    await writeRestoreStatus(status);
    await releaseLock();
    process.exit(1);
  };

  await say("opening", "Checking the staged backup…");

  const info = await stat(dumpPath).catch(() => null);
  if (!info?.isFile()) {
    await fail("The staged backup is no longer on disk. Nothing has been changed.");
    return;
  }

  /**
   * The magic bytes, one last time.
   *
   * Already checked when the archive was opened, and checked again here because this is the last
   * moment at which stopping is free. Everything after the drop is a database that has to be
   * rebuilt from something, and "something" had better be a pg_dump.
   */
  const head = Buffer.alloc(5);
  const handle = await open(dumpPath, "r");
  try {
    await handle.read(head, 0, 5, 0);
  } finally {
    await handle.close();
  }
  if (head.toString("latin1") !== "PGDMP") {
    await fail("The staged file is not a pg_dump archive. Nothing has been changed.");
    return;
  }

  const connection = parseDatabaseUrl(process.env.DATABASE_URL);
  if (!connection) {
    await fail("DATABASE_URL is missing or is not a Postgres URL. Nothing has been changed.");
    return;
  }

  const tool = await resolveDumpTool("pg_restore");
  if (!tool) {
    await fail("pg_restore could not be found. Install the Postgres client tools or set PG_DUMP_PATH. Nothing has been changed.");
    return;
  }

  /**
   * Everything needed to rebuild is in place before anything is destroyed.
   *
   * `db:restore` learned this the hard way: it dropped the schema and then discovered it could not
   * hand the archive to pg_restore, which left an empty database and a stack trace. Staging through
   * a container is the only step that can fail for a reason unrelated to the data, so it happens on
   * this side of the drop.
   */
  let staged: { pathForTool: string; cleanup: () => Promise<void> };
  try {
    staged = await stageForTool(tool, dumpPath);
  } catch (err) {
    await fail(`The archive could not be handed to pg_restore: ${(err as Error).message}. Nothing has been changed.`);
    return;
  }

  await say("dropping", "Clearing the current database…");

  try {
    /**
     * Other connections are closed first, and this is not politeness.
     *
     * `DROP SCHEMA public CASCADE` waits for a lock on every table in it. The web process holds a
     * pool of connections to this database, and one of them sitting idle inside a transaction is
     * enough to make the drop hang until something times out — with the application already behind
     * a maintenance page, so nobody is coming to release it. The maintenance lock means no new work
     * is arriving, so the pool is disposable; Prisma reopens what it needs on the next query.
     */
    await db.$executeRawUnsafe(`
      SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
    `);
  } catch {
    // Not fatal. Without the privilege to do it the drop may still succeed; if it does not, the
    // error from the drop itself is the one worth reporting.
  }

  try {
    await db.$executeRawUnsafe("DROP SCHEMA public CASCADE");
    await db.$executeRawUnsafe("CREATE SCHEMA public");
  } catch (err) {
    await staged.cleanup();
    await fail(
      `The current schema could not be cleared: ${(err as Error).message}. The database may be in a partial state — restore again, or use npm run db:restore.`,
    );
    return;
  } finally {
    await db.$disconnect().catch(() => {});
  }

  await say("restoring", `Rebuilding from the backup via ${tool.via}…`);

  try {
    await runRestore(tool, staged.pathForTool, connection);
  } catch (err) {
    await staged.cleanup();
    await fail(
      `${(err as Error).message}\nThe database was cleared before this failed, so it is now empty or partial. Restore a known-good backup before using the application.`,
    );
    return;
  } finally {
    await staged.cleanup();
  }

  // The plain dump goes as soon as it is no longer needed. It is an unsealed copy of the whole
  // business, and the archive it came from was encrypted precisely so one would not be lying about.
  await clearStaged(id);

  /**
   * Reference data comes back from the committed file, not from the backup.
   *
   * A restore rewinds the business to the day the backup was taken, which is the point of it. The
   * country's post offices are not the business and should not rewind with it — and a backup taken
   * before the PIN directory was first loaded would otherwise leave every address form without its
   * lookup. A no-op when the backup already held the same file's rows. See `src/lib/reference-data.ts`.
   *
   * Never fatal: the restore itself has succeeded. If the backup predates the table altogether, the
   * schema needs `migrate deploy` first, and the message says what to run.
   */
  let referenceNote = "";
  try {
    await ensurePincodes(await getTenantDb(), () => {});
  } catch (err) {
    referenceNote = ` The PIN directory could not be reloaded (${(err as Error).message.split("\n")[0]}) — run npm run db:reference once the schema is current.`;
  }
  // World places the same way, from the GeoNames files on this server, if they are here.
  try {
    await ensureGeonames(await getTenantDb());
  } catch (err) {
    referenceNote += ` World places could not be reloaded (${(err as Error).message.split("\n")[0]}) — sync them from Settings → World places.`;
  }

  status.phase = "done";
  status.message =
    (status.secretHandoffPath
      ? "Restored. The backup was taken under a different AUTH_SECRET — set it and restart before trusting the vault."
      : "Restored.") + referenceNote;
  status.finishedAt = new Date().toISOString();
  await writeRestoreStatus(status);
  await releaseLock();
  process.exit(0);
}

type Tool = Awaited<ReturnType<typeof resolveDumpTool>>;

/**
 * Puts the dump where the tool can seek in it.
 *
 * A custom-format archive has a table of contents that pg_restore seeks around; handed it on a pipe
 * it closes the input instead. On the host that means passing the path; through a container it
 * means copying the file in first, because the host's filesystem is not visible from inside.
 */
async function stageForTool(tool: NonNullable<Tool>, file: string) {
  if (!tool.inContainer) return { pathForTool: file, cleanup: async () => {} };

  const service = process.env.BACKUP_DB_SERVICE?.trim() || "postgres";
  const inside = `/tmp/wroffy-restore-${path.basename(file)}`;
  await run("docker", ["compose", "cp", file, `${service}:${inside}`]);

  return {
    pathForTool: inside,
    cleanup: async () => {
      await run("docker", ["compose", "exec", "-T", service, "rm", "-f", inside]).catch(() => {});
    },
  };
}

function runRestore(
  tool: NonNullable<Tool>,
  fileForTool: string,
  connection: { host: string; port: string; user: string; password: string; database: string },
): Promise<void> {
  const connectionArgs = tool.inContainer ? [] : ["--host", connection.host, "--port", connection.port];
  const args = [
    ...tool.args,
    "--no-owner",
    "--no-privileges",
    ...connectionArgs,
    `--username=${connection.user}`,
    `--dbname=${connection.database}`,
    fileForTool,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(tool.command, args, {
      env: { ...process.env, PGPASSWORD: connection.password },
      shell: false,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      /**
       * Non-zero is a failure, and the stderr goes with it.
       *
       * pg_restore writes warnings on a clean run too, so stderr alone says nothing — it is the
       * exit code that decides, exactly as `npm run db:restore` decides it. The text is carried
       * into the status file regardless, because "pg_restore exited with code 1" on its own is not
       * something anybody can act on at the moment the database is empty.
       */
      if (code === 0) return resolve();
      reject(new Error(stderr.trim() || `pg_restore exited with code ${code}.`));
    });
  });
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false });
    let stderr = "";
    child.stderr?.on("data", (c) => {
      stderr += String(c);
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `${command} exited ${code}`))));
  });
}

main().catch(async (err) => {
  console.error(err);
  try {
    const status = await readRestoreStatus();
    if (status) {
      await writeRestoreStatus({
        ...status,
        phase: "failed",
        message: "The restore did not complete.",
        error: String((err as Error).message ?? err),
        finishedAt: new Date().toISOString(),
      });
    }
  } finally {
    await releaseLock();
  }
  process.exit(1);
});

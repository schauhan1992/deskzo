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
 *
 * ## Which workspace
 *
 * WROFFY_TENANT_ID, set by the route that spawns it, and nothing else: the worker never falls back
 * to "the" database. Everything it does — the status file, the database it clears and rebuilds, the
 * migrations after, the keys it installs — is that workspace's. After the data is back, the schema
 * is brought up to this version (`prisma migrate deploy`), because a backup from before the last
 * upgrade restores the tables as they were then.
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseDatabaseUrl } from "../src/lib/backup/policy";
import { controlDb } from "../src/lib/platform/control-db";
import { forgetRegistry, tenantById } from "../src/lib/tenancy/registry";
import { runAsTenant } from "../src/lib/tenancy/resolve";
import { installLogLabels } from "../src/lib/tenancy/log-labels";

installLogLabels();
import type { Tenant } from "../src/lib/tenancy/state";
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
import { db } from "../src/lib/db";
import { REFERENCE_TABLES } from "../src/lib/reference-data";

async function main(tenant: Tenant, id: string) {
  const existing = await readRestoreStatus();
  const dumpPath = await stagingPath(id, ".dump");
  // Read now: clearing the staging area after the restore removes it.
  const stagedKeys = await readFile(await stagingPath(id, ".keys"), "utf8").catch(() => null);

  const status: RestoreStatus = {
    id,
    phase: "opening",
    message: "Checking the staged backup…",
    startedAt: existing?.id === id ? existing.startedAt : new Date().toISOString(),
    finishedAt: null,
    archiveName: existing?.id === id ? existing.archiveName : null,
    takenAt: existing?.id === id ? existing.takenAt : null,
    secretHandoffPath: existing?.id === id ? existing.secretHandoffPath : null,
    keysFromBackup: false,
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

  const connection = parseDatabaseUrl(tenant.dbUrl);
  if (!connection) {
    await fail("This workspace's database address is not a Postgres URL. Nothing has been changed.");
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
   * A backup from before the shared reference database carries its own copy of the PIN directory and
   * world places. The shared copy (prisma/reference) is the one that counts, so this one is emptied —
   * otherwise the migration that retires these tables refuses to run, as it must for a workspace
   * whose copy was never moved. A newer backup has no such tables and nothing happens.
   */
  try {
    await db.$executeRawUnsafe(
      `DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY[${REFERENCE_TABLES.map((r) => `'${r.table}'`).join(", ")}] LOOP IF to_regclass(t) IS NOT NULL THEN EXECUTE format('TRUNCATE %I', t); END IF; END LOOP; END $$;`,
    );
  } catch (err) {
    await fail(`The backup was restored, but its own copy of the reference data could not be cleared: ${(err as Error).message}`);
    return;
  }

  await say("restoring", "Bringing the database up to this version…");
  try {
    await migrateDeploy(tenant.dbUrl);
  } catch (err) {
    await fail(
      `The backup was restored, but its schema could not be brought up to this version: ${(err as Error).message.split("\n").slice(-3).join(" ")} Run the migrations for this workspace before using it.`,
    );
    return;
  }

  /**
   * The backup's own keys, when it was taken under different ones (staged by the restore route,
   * sealed for this workspace). Installed only now that the data they open is back: installed
   * earlier, a failed restore would leave the old data under keys that do not open it.
   */
  if (stagedKeys && tenant.source === "control") {
    await controlDb().$transaction(async (tx) => {
      await tx.tenant.update({ where: { id: tenant.id }, data: { keyBundleCipher: stagedKeys.trim() } });
      await tx.platformAuditLog.create({
        data: { actorKind: "SYSTEM", actor: "restore-worker", action: "tenant.keys.from-backup", tenantId: tenant.id, detail: { restoreId: id } },
      });
    });
    forgetRegistry();
    status.keysFromBackup = true;
  }

  // Reference data is not in a workspace's database or its backups any more (prisma/reference), so a
  // restore neither rewinds nor reloads it: every workspace's address lookups carry on as they were.

  status.phase = "done";
  status.message =
    (status.secretHandoffPath
      ? "Restored. The backup was taken under different keys — see the file named below before trusting the vault."
      : status.keysFromBackup
        ? "Restored, with the keys the backup was taken under."
        : "Restored.");
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

/** `prisma migrate deploy` against this workspace's database, through the local Prisma CLI. */
function migrateDeploy(databaseUrl: string): Promise<void> {
  const cli = path.join(process.cwd(), "node_modules", "prisma", "build", "index.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "migrate", "deploy"], { shell: false, env: { ...process.env, DATABASE_URL: databaseUrl } });
    let output = "";
    child.stdout?.on("data", (c) => (output += String(c)));
    child.stderr?.on("data", (c) => (output += String(c)));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(output.trim() || `prisma migrate deploy exited ${code}`))));
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

async function start() {
  const id = process.argv[2];
  if (!id || !/^[a-z0-9-]{6,64}$/i.test(id)) {
    console.error("restore-worker: a staging id is required.");
    process.exit(1);
  }
  const tenantId = process.env.WROFFY_TENANT_ID?.trim();
  const tenant = tenantId ? await tenantById(tenantId) : null;
  if (!tenant) {
    console.error(tenantId ? `restore-worker: no workspace ${tenantId}.` : "restore-worker: WROFFY_TENANT_ID is required — the workspace to restore.");
    process.exit(1);
  }
  await runAsTenant(tenant, async () => {
    try {
      await main(tenant, id);
    } catch (err) {
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
    }
  });
}

void start();

/**
 * Puts a backup back.
 *
 *   npm run db:restore -- backups/wroffy-2026-09-20-143200.dump
 *
 * This destroys the current contents of the database. There is no undo, and the thing it replaces
 * is every order, invoice and stored password in the system. So it refuses unless told twice:
 *
 *   npm run db:restore -- <file> --i-understand-this-replaces-everything
 *
 * ## Why this is a script and not a button
 *
 * A restore drops the schema out from under the connection pool the application is holding. The app
 * cannot do that to itself while serving requests — anything mid-flight fails against a database
 * that no longer has the tables it was reading. So this runs with the app stopped, from a terminal,
 * by somebody who has decided to do it.
 *
 * ## The two checks that matter
 *
 * A dump restores cleanly and is still useless in two ways, neither of which pg_restore notices:
 *
 * 1. **The wrong encryption key.** Ten kinds of column here are encrypted from `AUTH_SECRET`. Under
 *    a different secret they come back byte-perfect and unreadable — the vault, e-invoice logins,
 *    two-factor secrets, all present and all gibberish. The restore reports success.
 * 2. **A newer schema.** Restoring last month's dump into a database the migrations have since
 *    moved on leaves tables the current code does not expect.
 *
 * Both are checked against the sidecar written beside the dump, and both are refusals rather than
 * warnings — with a flag to override, because there are real reasons to want either.
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { parseDatabaseUrl, formatBytes } from "../src/lib/backup/policy";
import { secretFingerprint } from "../src/lib/backup/fingerprint";
import { resolveDumpTool } from "../src/lib/backup/run";
import { readSidecar } from "../src/lib/backup/sidecar";
import { db } from "../src/lib/db";

const CONFIRM = "--i-understand-this-replaces-everything";

function say(line = "") {
  console.log(line);
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const confirmed = args.includes(CONFIRM);
  const force = args.includes("--force");

  if (!file) {
    say("\n  Which backup?\n");
    say("    npm run db:restore -- backups/wroffy-2026-09-20-143200.dump\n");
    process.exitCode = 1;
    return;
  }

  const target = path.resolve(file);
  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) {
    say(`\n  There is no file at ${target}\n`);
    process.exitCode = 1;
    return;
  }

  /**
   * The magic bytes, before anything else.
   *
   * A custom-format dump starts `PGDMP`. Checking it here means a truncated download, a plain-SQL
   * file or somebody's spreadsheet is refused now rather than half way through dropping the schema
   * — which is the one moment in this script where stopping is no longer an option.
   */
  const head = Buffer.alloc(5);
  const handle = await (await import("node:fs/promises")).open(target, "r");
  await handle.read(head, 0, 5, 0);
  await handle.close();
  if (head.toString("latin1") !== "PGDMP") {
    say(`\n  ${path.basename(target)} is not a custom-format pg_dump file.\n`);
    process.exitCode = 1;
    return;
  }

  const connection = parseDatabaseUrl(process.env.DATABASE_URL);
  if (!connection) {
    say("\n  DATABASE_URL is missing or not a Postgres URL.\n");
    process.exitCode = 1;
    return;
  }

  const sidecar = await readSidecar(target);
  const currentFingerprint = secretFingerprint(process.env.AUTH_SECRET);

  say("");
  say(`  Restoring ${path.basename(target)} (${formatBytes(info.size)})`);
  say(`  Into      ${connection.database} on ${connection.host}:${connection.port}`);
  if (sidecar) {
    say(`  Taken     ${sidecar.takenAt}`);
    say(`  Schema    ${sidecar.schemaVersion ?? "unknown"}`);
  } else {
    say("  Sidecar   missing — this dump was not taken by this app, so nothing can be checked");
  }
  say("");

  const problems: string[] = [];

  if (sidecar?.secretFingerprint && currentFingerprint && sidecar.secretFingerprint !== currentFingerprint) {
    problems.push(
      "The AUTH_SECRET differs from the one this backup was taken under.\n" +
        "    Every encrypted column — the vault, e-invoice and M365 credentials, two-factor secrets —\n" +
        "    would restore intact and unreadable. Restore this to an instance with the original secret,\n" +
        "    or accept losing all of them.",
    );
  }

  if (sidecar?.schemaVersion) {
    const current = await currentMigration();
    if (current && current !== sidecar.schemaVersion) {
      problems.push(
        `The database is on migration ${current} and this dump is from ${sidecar.schemaVersion}.\n` +
          "    Restoring replaces the schema with the older one, and the running code expects the newer.\n" +
          "    Run the migrations again afterwards, or check out the code that matches the dump.",
      );
    }
  }

  if (problems.length > 0) {
    say("  Problems:\n");
    for (const problem of problems) say(`  - ${problem}\n`);
    if (!force) {
      say("  Nothing has been changed. Add --force to go ahead anyway.\n");
      process.exitCode = 1;
      return;
    }
    say("  --force given, continuing.\n");
  }

  if (!confirmed) {
    say("  This DELETES everything currently in that database and cannot be undone.");
    say("  Nothing has been changed. To go ahead:\n");
    say(`    npm run db:restore -- ${file} ${CONFIRM}\n`);
    process.exitCode = 1;
    return;
  }

  const tool = await resolveDumpTool("pg_restore");
  if (!tool) {
    say("  pg_restore could not be found. Install the Postgres client tools or set PG_DUMP_PATH.\n");
    process.exitCode = 1;
    return;
  }

  /**
   * Everything needed to rebuild is put in place *before* anything is destroyed.
   *
   * The first version of this script dropped the schema and then discovered it could not feed the
   * archive to pg_restore, which left an empty database and a stack trace. Staging first means a
   * failure at this step is a failed restore rather than a destroyed one — the only moment that
   * matters is the one after the drop, and nothing unproven should happen on the far side of it.
   */
  const staged = await stage(tool, target);

  /**
   * The schema is dropped rather than the database.
   *
   * `DROP DATABASE` cannot run while anything is connected to it, and this script is connected to
   * it. Dropping and recreating the schema does the same job from the inside, and leaves the
   * database itself — with its roles and extensions — where it was.
   */
  say("  Dropping the current schema…");
  await db.$executeRawUnsafe("DROP SCHEMA public CASCADE");
  await db.$executeRawUnsafe("CREATE SCHEMA public");
  await db.$disconnect();

  say(`  Restoring via ${tool.via}…`);
  try {
    await restore(tool, staged, connection);
  } finally {
    await staged.cleanup();
  }

  say("\n  Done. Run the app and check that a stored password still opens before trusting this.\n");
}

async function currentMigration(): Promise<string | null> {
  try {
    const rows = await db.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1
    `;
    return rows[0]?.migration_name ?? null;
  } catch {
    return null;
  }
}

type Staged = { pathForTool: string; cleanup: () => Promise<void> };

/**
 * Puts the archive somewhere pg_restore can read it — and seek in it.
 *
 * A custom-format archive has a table of contents that pg_restore seeks around; handed the file on
 * a pipe it cannot, and closes the input. That is what `write EOF` was: not a broken dump but a
 * program declining to read one sideways.
 *
 * On the host that means passing the path. Through a container it means copying the file in first,
 * because the host's filesystem is not visible from inside — which is the same reason the dump has
 * to come back out over stdout, in the other direction.
 */
async function stage(tool: { inContainer?: boolean }, file: string): Promise<Staged> {
  if (!tool.inContainer) return { pathForTool: file, cleanup: async () => {} };

  const service = process.env.BACKUP_DB_SERVICE?.trim() || "postgres";
  const inside = `/tmp/wroffy-restore-${Date.now()}.dump`;

  say(`  Copying the archive into the ${service} container…`);
  await run("docker", ["compose", "cp", file, `${service}:${inside}`]);

  return {
    pathForTool: inside,
    // Removed whether the restore worked or not. A database dump left in a container's /tmp is a
    // complete copy of the system sitting somewhere nobody is looking after.
    cleanup: async () => {
      await run("docker", ["compose", "exec", "-T", service, "rm", "-f", inside]).catch(() => {});
    },
  };
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => reject(new Error(`${command} failed: ${err.message}`)));
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(stderr.trim() || `${command} exited with code ${code}.`)),
    );
  });
}

function restore(
  tool: { command: string; args: string[]; inContainer?: boolean },
  staged: Staged,
  connection: ReturnType<typeof parseDatabaseUrl>,
): Promise<void> {
  if (!connection) throw new Error("No connection.");

  const connectionArgs = tool.inContainer ? [] : [`--host=${connection.host}`, `--port=${connection.port}`];
  const args = [
    ...tool.args,
    "--no-owner",
    "--no-privileges",
    ...connectionArgs,
    `--username=${connection.user}`,
    `--dbname=${connection.database}`,
    staged.pathForTool,
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
    child.on("error", (err) => reject(new Error(`Could not run ${tool.command}: ${err.message}`)));
    child.on("close", (code) => {
      // pg_restore writes warnings to stderr on a clean run too, so they are shown rather than
      // treated as failure — but a non-zero exit is a failure.
      if (stderr.trim()) console.log(`
${stderr.trim()}
`);
      if (code === 0) resolve();
      else reject(new Error(`pg_restore exited with code ${code}.`));
    });
  });
}
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

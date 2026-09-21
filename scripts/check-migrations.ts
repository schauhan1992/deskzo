/**
 * That the migrations folder can rebuild this database from nothing.
 *
 * Every other check in this repo asks whether the code is right. This one asks whether the *history*
 * is — whether `prisma migrate deploy` against an empty database produces the schema the application
 * expects. That is the one property nobody exercises during development, because development always
 * runs against a database that is already migrated.
 *
 * ## What went wrong, and why it was invisible
 *
 * Prisma replays migrations in **lexical folder order**, and nothing enforces that this matches the
 * order they were actually applied in. Most of this history was hand-authored — the documented
 * workflow was to write the SQL, run `prisma db execute`, then `prisma migrate resolve --applied` —
 * and those folders were given round invented timestamps (`20260921030000_…`) that ran ahead of the
 * real clock. So when `prisma migrate dev` did autogenerate one, it stamped the true time
 * (`20260920174608_eway_enabled`) and landed *behind* migrations that had already run.
 *
 * That migration adds `eway_bills_createdById_fkey` — the one foreign key the table-creating
 * migration does not add. Replayed in folder order it reached for `eway_bills` two folders before
 * anything created it:
 *
 *     Error: P3018 … ERROR: relation "eway_bills" does not exist
 *
 * The applied database was perfectly healthy throughout. Only replay-from-scratch was broken, which
 * means the first time anybody would have found out is the first time they tried to stand up a new
 * environment — a new developer, a staging box, or a restore. `migrate dev` was broken by the same
 * fault, because its drift check replays the history into a shadow database.
 *
 * ## Why the last section is the only one that really matters
 *
 * The first three sections check things that are cheap to check and easy to reason about: names,
 * bookkeeping, checksums. They are worth having, but every one of them passed on the day the replay
 * was broken. The fourth section actually runs the replay. It is slower than the rest of this file
 * put together and it is the reason the file exists.
 *
 * Out-of-order names are *reported* rather than failed. Twelve of them sort earlier than they ran
 * and replay perfectly well, because nothing in them depends on what ran in between; renaming those
 * would make their names less truthful, not more. Whether an order is a problem is a question only
 * the replay can answer, so the replay is what decides.
 *
 * ## Do not squash this history
 *
 * The standard advice for a tangled migration history is to replace it with one baseline generated
 * from `prisma migrate diff --from-empty --to-schema-datamodel`. That would silently drop three
 * load-bearing objects, because `schema.prisma` cannot express any of them:
 *
 *   - `refuse_super_admin_delete()` / `require_remaining_super_admin()` and their two triggers on
 *     `users` (`20260920090000_protect_super_admin`). The application guard in
 *     `src/lib/authz/guards.ts` covers only the routes the UI offers; the triggers are what stop a
 *     script or a psql session leaving the installation with zero super admins, which nothing
 *     inside the app can recover from.
 *   - the CHECK constraint `users_super_admin_is_admin` (`20260920070000_rbac_foundation`), which
 *     around seventy `role === "ADMIN"` comparisons across `src/` quietly rest on.
 *   - the partial unique index `company_locations_one_primary_per_company`
 *     (`20260920120000_one_primary_location`). Prisma has no syntax for a `WHERE`-filtered index,
 *     so a diff regenerates a plain one and two locations can both be primary — which puts an
 *     arbitrary GSTIN and place of supply on a GST document, wrongly and without an error.
 *
 * `src/lib/backup/run.ts` also reads `_prisma_migrations` at runtime to stamp each backup with the
 * schema it belongs to, and a squash flattens every one of those labels to a single name.
 *
 *   npm run check:migrations
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const MIGRATIONS = "prisma/migrations";
const SCHEMA = "prisma/schema.prisma";

let failures = 0;
function ok(label: string, pass: boolean, detail: unknown = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
}
function section(title: string) {
  console.log(`\n— ${title} —\n`);
}

/** `postgresql://…/wroffy_crm?schema=public` with the database swapped for another. */
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");

  const folders = fs
    .readdirSync(MIGRATIONS)
    .filter((f) => fs.statSync(path.join(MIGRATIONS, f)).isDirectory())
    .sort();

  // ── The folder, on its own terms ──────────────────────────────────────────────────────────────
  section("The migrations folder");

  ok("there are migrations at all", folders.length > 0, `${folders.length} found`);

  const malformed = folders.filter((f) => !/^\d{14}_[a-z0-9_]+$/.test(f));
  ok(
    "every folder is <14-digit timestamp>_<snake_case name>",
    malformed.length === 0,
    malformed.length === 0 ? "" : malformed.join(", "),
  );

  const noSql = folders.filter((f) => !fs.existsSync(path.join(MIGRATIONS, f, "migration.sql")));
  ok("every folder holds a migration.sql", noSql.length === 0, noSql.length === 0 ? "" : noSql.join(", "));

  /**
   * A migration created *next to* the folder rather than inside it.
   *
   * `prisma/migrations${TS}_drop_legacy_industry_text` was sitting here — the fossil of a
   * `mkdir -p "prisma/migrations${TS}_…"` where the shell variable was empty and the slash was
   * missing. It was empty, so nothing was lost, but had the `migration.sql` landed in it the SQL
   * would have been applied by hand and then never replayed: Prisma only reads `prisma/migrations/`,
   * so a migration one level out is invisible to every tool and to the replay below.
   */
  const strays = fs
    .readdirSync("prisma")
    .filter((f) => f !== "migrations" && f.startsWith("migrations") && fs.statSync(path.join("prisma", f)).isDirectory());
  ok(
    "no migration folder was created beside prisma/migrations instead of inside it",
    strays.length === 0,
    strays.map((s) => `prisma/${s}`).join(", "),
  );

  /**
   * Two folders sharing a timestamp are ordered by the rest of their name, which is alphabetical
   * and therefore accidental. `20260920180000_backups` and `20260920180000_eway_enabled_backfill`
   * were one such pair, and their relative order was decided by "b" coming before "e".
   */
  const byStamp = new Map<string, string[]>();
  for (const f of folders) {
    const stamp = f.slice(0, 14);
    byStamp.set(stamp, [...(byStamp.get(stamp) ?? []), f]);
  }
  const collisions = [...byStamp.entries()].filter(([, list]) => list.length > 1);
  ok(
    "no two migrations share a timestamp, so none are ordered alphabetically by accident",
    collisions.length === 0,
    collisions.map(([stamp, list]) => `${stamp}: ${list.join(" + ")}`).join(" · "),
  );

  // ── The folder, against what the database says it ran ─────────────────────────────────────────
  section("The folder against the applied history");

  const db = new PrismaClient();
  let history: { migration_name: string; checksum: string; rolled_back_at: Date | null; started_at: Date }[];
  try {
    history = await db.$queryRawUnsafe(
      `SELECT migration_name, checksum, rolled_back_at, started_at FROM "_prisma_migrations" ORDER BY started_at ASC`,
    );
  } finally {
    await db.$disconnect();
  }

  const recorded = history.map((h) => h.migration_name);
  const onDisk = new Set(folders);
  const inTable = new Set(recorded);

  const ghosts = recorded.filter((n) => !onDisk.has(n));
  ok(
    "every migration the database has run still exists on disk",
    ghosts.length === 0,
    ghosts.length === 0
      ? ""
      : `${ghosts.join(", ")} — a renamed folder needs _prisma_migrations renamed with it`,
  );

  const pending = folders.filter((n) => !inTable.has(n));
  ok(
    "every migration on disk has been run here",
    pending.length === 0,
    pending.length === 0 ? "" : `${pending.join(", ")} — run prisma migrate deploy`,
  );

  const rolledBack = history.filter((h) => h.rolled_back_at !== null);
  ok(
    "nothing is sitting in a rolled-back state",
    rolledBack.length === 0,
    rolledBack.map((h) => h.migration_name).join(", "),
  );

  /**
   * The checksum is a sha256 of `migration.sql`. Drift means the file was edited after it was
   * applied — so this database and a freshly deployed one were built by different instructions,
   * and the difference between them is exactly the edit nobody will remember making.
   */
  const drifted = history.filter((h) => {
    const p = path.join(MIGRATIONS, h.migration_name, "migration.sql");
    if (!fs.existsSync(p)) return false;
    return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex") !== h.checksum;
  });
  ok(
    "no migration.sql has been edited since it was applied",
    drifted.length === 0,
    drifted.map((h) => h.migration_name).join(", "),
  );

  // ── Names that sort earlier than they ran ─────────────────────────────────────────────────────
  section("Names that sort earlier than they ran");

  const outOfOrder: string[] = [];
  let high = "";
  for (const name of recorded) {
    if (name < high) outOfOrder.push(`${name} (sorts before ${high}, which ran first)`);
    else high = name;
  }
  if (outOfOrder.length === 0) {
    console.log("  ..    none — lexical order and applied order agree");
  } else {
    // Reported, not failed. See the note at the top of this file: the replay below is the authority
    // on whether an order works, and these replay fine.
    console.log(`  ..    ${outOfOrder.length} of ${recorded.length}, which the replay below vets:`);
    for (const line of outOfOrder) console.log(`          ${line}`);
  }

  // ── The one that matters ──────────────────────────────────────────────────────────────────────
  section("Replaying the whole history into an empty database");

  /**
   * This is the one check in the repo that does more than read.
   *
   * It creates a database, replays 115 migrations into it and drops it again. That is harmless
   * against the Docker container in `docker-compose.yml` and it is not something to point at a
   * managed server by accident — a `DATABASE_URL` left pointing at staging would have this issuing
   * CREATE DATABASE there. The scratch name is derived from the real one and never equals it, so
   * the drop cannot reach the database being checked, but refusing outright is the clearer promise.
   */
  const host = new URL(url).hostname;
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "host.docker.internal";
  ok(
    "the database is a local one, so a scratch database may be created beside it",
    local,
    local ? host : `${host} — point DATABASE_URL at the local Docker Postgres to run the replay`,
  );
  if (!local) {
    console.log(`\n${failures} check(s) FAILED.\n`);
    process.exit(1);
  }

  const shadowName = `${new URL(url).pathname.slice(1)}_migration_check`;
  const adminUrl = withDatabase(url, "postgres");
  const shadowUrl = withDatabase(url, shadowName);

  const admin = new PrismaClient({ datasourceUrl: adminUrl });
  let replayed = false;
  let detail = "";
  try {
    // FORCE because a connection left open by a previous crashed run would otherwise block the drop,
    // and a stale shadow database is a worse failure than none: it makes the next run pass.
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${shadowName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${shadowName}"`);

    /**
     * `--from-migrations` is the shadow-database replay itself: Prisma applies every folder in
     * order into the empty database given, reads the result back, and diffs it against the
     * datamodel. It is the same step `prisma migrate dev` runs to detect drift, which is why
     * `migrate dev` and `migrate deploy` failed together and are fixed together.
     *
     * `--exit-code` turns "they differ" into exit status 2, as against 1 for a genuine error, so a
     * replay that fails to apply at all is distinguishable from one that applies to the wrong shape.
     */
    try {
      execSync(
        `npx prisma migrate diff --from-migrations "${MIGRATIONS}" --to-schema-datamodel "${SCHEMA}" ` +
          `--shadow-database-url "${shadowUrl}" --exit-code`,
        { stdio: "pipe", encoding: "utf8", timeout: 10 * 60 * 1000 },
      );
      replayed = true;
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      const output = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
      detail =
        err.status === 2
          ? `the replay applied but produced a different schema:\n${output}`
          : `the replay did not apply:\n${output}`;
    }
  } finally {
    try {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${shadowName}" WITH (FORCE)`);
    } finally {
      await admin.$disconnect();
    }
  }

  ok(
    "a fresh database built from the migrations matches schema.prisma exactly",
    replayed,
    replayed
      ? `${folders.length} migrations, no difference — migrate deploy works from empty`
      : detail,
  );

  console.log(failures === 0 ? "\nAll migration checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

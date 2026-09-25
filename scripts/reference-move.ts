/**
 * Moves a workspace's own copy of the reference data into the shared reference database — the
 * upgrade for a database from before there was one (SaaS M3).
 *
 *   npm run reference:move                            the first workspace
 *   npm run reference:move -- --workspace <slug>      another
 *   npm run reference:move -- --dry-run               say what would happen; change nothing
 *
 * For each reference table (src/lib/reference-data.ts):
 *
 *   · when the shared database has none of it yet, the rows are copied across in batches and the
 *     counts compared — the shared copy is then this one;
 *   · when the shared database already has it (another workspace was moved first), the shared copy
 *     is kept and this one is not copied: it is the same public data, loaded from the same sources.
 *
 * The data.gov.in API key, if one was saved, is opened with the workspace's keys and sealed again
 * under the platform key — it belongs to no workspace now.
 *
 * Only when every table has been copied and checked are the workspace's tables emptied, in one
 * statement. That is what lets the migration retiring them run (it refuses while any holds a row), so
 * the order is: this, then `npx prisma migrate deploy`.
 */
import "dotenv/config";
import { Prisma, PrismaClient } from "@prisma/client";
import { Prisma as RefPrisma, PrismaClient as ReferenceClient } from "@wroffy/reference-client";
import { decryptWith } from "../src/lib/crypto";
import { closeControlDb } from "../src/lib/platform/control-db";
import { sealForPlatform } from "../src/lib/platform/kek";
import { REFERENCE_TABLES } from "../src/lib/reference-data";
import { keysFor } from "../src/lib/tenancy/keys";
import { legacyTenant, tenantBySlug } from "../src/lib/tenancy/registry";

type Row = Record<string, unknown>;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const named = args.indexOf("--workspace");
const slug = named >= 0 ? args[named + 1] : null;
const say = (line: string) => console.log(line);

/** Decimals become strings, so the reference client's own Decimal parses them. */
const plain = (row: Row): Row =>
  Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Prisma.Decimal ? v.toString() : v]));

async function main() {
  if (!process.env.REFERENCE_DATABASE_URL) throw new Error("REFERENCE_DATABASE_URL is not set — see .env.example.");
  const tenant = slug ? await tenantBySlug(slug) : await legacyTenant();
  if (!tenant) throw new Error(slug ? `There is no workspace "${slug}".` : "There is no first workspace.");

  const workspace = new PrismaClient({ datasourceUrl: tenant.dbUrl });
  const reference = new ReferenceClient({ datasourceUrl: process.env.REFERENCE_DATABASE_URL });
  try {
    say(`Moving reference data out of workspace "${tenant.slug}"${dryRun ? " — dry run, nothing will change" : ""}\n`);

    const present = await workspace.$queryRaw<{ t: string }[]>`
      select t from unnest(${REFERENCE_TABLES.map((r) => r.table)}::text[]) as t where to_regclass(t) is not null`;
    if (present.length === 0) {
      say("Nothing to move: this workspace's database no longer has reference tables.");
      return;
    }
    const has = (table: string) => present.some((p) => p.t === table);
    const count = async (client: { $queryRawUnsafe: <T>(q: string) => Promise<T> }, table: string) =>
      Number((await client.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from "${table}"`))[0].n);

    const problems: string[] = [];

    /** A big table, copied in id order when the shared one is empty. */
    const copyById = async (table: string, write: (rows: Row[]) => Promise<unknown>, batch: number) => {
      if (!has(table)) return;
      const [here, there] = await Promise.all([count(workspace, table), count(reference, table)]);
      if (here === 0) return say(`  ${table}: empty here`);
      if (there > 0) return say(`  ${table}: ${here.toLocaleString("en-IN")} here; the shared copy already has ${there.toLocaleString("en-IN")} — kept`);
      if (dryRun) return say(`  ${table}: would copy ${here.toLocaleString("en-IN")} rows`);
      let after = -1;
      let copied = 0;
      for (;;) {
        const rows = await workspace.$queryRawUnsafe<Row[]>(`select * from "${table}" where id > $1 order by id limit ${batch}`, after);
        if (rows.length === 0) break;
        await write(rows.map(plain));
        copied += rows.length;
        after = rows[rows.length - 1].id as number;
        process.stdout.write(`\r  ${table}: ${copied.toLocaleString("en-IN")} / ${here.toLocaleString("en-IN")}   `);
      }
      process.stdout.write("\n");
      const now = await count(reference, table);
      if (now !== here) problems.push(`${table}: copied ${now}, expected ${here}`);
    };

    // States: small, and keyed by (countryCode, code) rather than an id.
    if (has("geo_states")) {
      const [here, there] = await Promise.all([count(workspace, "geo_states"), count(reference, "geo_states")]);
      if (here > 0 && there === 0 && !dryRun) {
        const rows = await workspace.$queryRawUnsafe<Row[]>(`select * from "geo_states"`);
        await reference.geoState.createMany({ data: rows.map(plain) as RefPrisma.GeoStateCreateManyInput[] });
        const now = await count(reference, "geo_states");
        if (now !== here) problems.push(`geo_states: copied ${now}, expected ${here}`);
        say(`  geo_states: ${now.toLocaleString("en-IN")} copied`);
      } else {
        say(`  geo_states: ${here === 0 ? "empty here" : there > 0 ? `the shared copy already has ${there.toLocaleString("en-IN")} — kept` : `would copy ${here.toLocaleString("en-IN")} rows`}`);
      }
    }
    await copyById("geo_cities", (rows) => reference.geoCity.createMany({ data: rows as RefPrisma.GeoCityCreateManyInput[] }), 10_000);
    await copyById("geo_postal_codes", (rows) => reference.geoPostalCode.createMany({ data: rows as RefPrisma.GeoPostalCodeCreateManyInput[] }), 20_000);
    await copyById("post_offices", (rows) => reference.postOffice.createMany({ data: rows as RefPrisma.PostOfficeCreateManyInput[] }), 20_000);

    // What was loaded from which file: each dataset the shared copy does not already describe.
    if (has("reference_datasets")) {
      const rows = await workspace.$queryRawUnsafe<Row[]>(`select * from "reference_datasets"`);
      for (const row of rows) {
        const exists = await reference.referenceDataset.findUnique({ where: { key: String(row.key) } });
        if (exists) continue;
        say(`  reference_datasets: ${String(row.key)}${dryRun ? " (would copy)" : ""}`);
        if (!dryRun) {
          await reference.referenceDataset.create({
            data: { ...(plain(row) as RefPrisma.ReferenceDatasetCreateInput), unresolvedStates: (row.unresolvedStates as RefPrisma.InputJsonValue | null) ?? RefPrisma.DbNull },
          });
        }
      }
    }

    // Sync state, and the API key — opened with this workspace's keys, sealed for the platform.
    if (has("reference_syncs")) {
      const keys = await keysFor(tenant);
      const rows = await workspace.$queryRawUnsafe<Row[]>(`select * from "reference_syncs"`);
      for (const row of rows) {
        const exists = await reference.referenceSync.findUnique({ where: { key: String(row.key) } });
        if (exists) continue;
        let apiKeyCipher: string | null = null;
        if (typeof row.apiKeyCipher === "string" && row.apiKeyCipher) {
          try {
            apiKeyCipher = sealForPlatform("reference-sync-key", decryptWith(keys, row.apiKeyCipher));
          } catch {
            say(`  reference_syncs: the saved API key for ${String(row.key)} could not be opened — it will have to be entered again`);
          }
        }
        say(`  reference_syncs: ${String(row.key)}${apiKeyCipher ? ", with its API key" : ""}${dryRun ? " (would copy)" : ""}`);
        if (!dryRun) {
          // A run in progress here is not one in progress there.
          const status = row.status === "RUNNING" ? "FAILED" : String(row.status ?? "IDLE");
          await reference.referenceSync.create({ data: { ...(plain(row) as RefPrisma.ReferenceSyncCreateInput), status, apiKeyCipher } });
        }
      }
    }

    if (problems.length) {
      console.error(`\nThe copy did not check out, so this workspace's tables were left as they are:\n  ${problems.join("\n  ")}`);
      process.exitCode = 1;
      return;
    }
    if (dryRun) {
      say("\nDry run: nothing was changed.");
      return;
    }

    // Autoincrement ids carried across: the shared tables' sequences continue after them.
    for (const table of ["post_offices", "geo_postal_codes"]) {
      await reference.$executeRawUnsafe(`select setval(pg_get_serial_sequence('"${table}"', 'id'), coalesce(max(id), 1), max(id) is not null) from "${table}"`);
    }
    await workspace.$executeRawUnsafe(`TRUNCATE ${present.map((p) => `"${p.t}"`).join(", ")}`);
    say(`\nMoved. This workspace's reference tables are empty; now run  npx prisma migrate deploy  for it.`);
  } finally {
    await workspace.$disconnect();
    await reference.$disconnect();
    await closeControlDb();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

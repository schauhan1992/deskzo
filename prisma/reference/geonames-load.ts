/**
 * The command-line way to load GeoNames' world places — see geonames.ts.
 *
 *   npm run db:geonames                  load from prisma/reference/geonames/
 *   npm run db:geonames:download         download the files first, then load
 *   … -- --force                         load even if unchanged, or much smaller than what is loaded
 */
import "dotenv/config";
import { PrismaClient } from "@wroffy/reference-client";
import { GEONAMES_DIR, downloadGeonames, loadGeonames } from "./geonames";

// The shared reference database (prisma/reference/schema.prisma), which belongs to no workspace.
const db = new PrismaClient({ datasourceUrl: process.env.REFERENCE_DATABASE_URL });

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const progress = (message: string, done?: number, total?: number) => {
    process.stdout.write(`\r  ${message}${done !== undefined && total ? ` ${done.toLocaleString("en-IN")} / ${total.toLocaleString("en-IN")}` : ""}          `);
  };
  if (args.includes("--download")) {
    await downloadGeonames(GEONAMES_DIR, progress);
    process.stdout.write("\n");
  }
  const started = Date.now();
  const outcomes = await loadGeonames(db, GEONAMES_DIR, progress, force);
  process.stdout.write("\n");
  for (const o of outcomes) {
    console.log(`  ${o.key}: ${o.outcome}${o.rows ? ` — ${o.rows.toLocaleString("en-IN")} rows` : ""}${o.detail ? ` (${o.detail})` : ""}`);
  }
  console.log(`  done in ${Math.round((Date.now() - started) / 1000)} s`);
  if (outcomes.some((o) => o.outcome === "refused")) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());

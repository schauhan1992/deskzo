/**
 * Brings every database up to this version — run it before deploying new code.
 *
 *   npm run tenants:migrate                     everything (src/lib/platform/tenant-migrations.ts)
 *   npm run tenants:migrate -- --only <slug>    one workspace, e.g. to retry one a run left held
 *
 * Exits non-zero when anything failed, so a deploy script stops there.
 */
import "dotenv/config";
import { closeControlDb } from "../src/lib/platform/control-db";
import { migrateEverything } from "../src/lib/platform/tenant-migrations";

async function main() {
  const args = process.argv.slice(2);
  const named = args.indexOf("--only");
  const only = named >= 0 ? (args[named + 1] ?? null) : null;
  console.log(only ? `Migrating workspace "${only}"` : "Migrating every database");
  const summary = await migrateEverything({ only, log: (line) => console.log(line) });
  console.log(`\nTo ${summary.version ?? "(no migrations)"} — run ${summary.runId}`);
  for (const p of summary.platform) console.log(`  ${p.ok ? "ok  " : "FAIL"} ${p.target}${p.error ? ` — ${p.error.split("\n")[0]}` : ""}`);
  for (const w of summary.workspaces) console.log(`  ${w.ok === true ? "ok  " : w.ok === "skipped" ? "skip" : "FAIL"} ${w.slug}${w.error ? ` — ${w.error.split("\n")[0]}` : ""}`);
  if (summary.stoppedAt) console.log(`\nStopped at ${summary.stoppedAt}: nothing after it was touched.`);
  const failed = summary.platform.some((p) => !p.ok) || summary.workspaces.some((w) => w.ok === false);
  if (failed) {
    console.log("A workspace whose migration failed is held at the maintenance page until a run brings it through.");
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeControlDb());

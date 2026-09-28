/**
 * Brings every database up to this version — run it before deploying new code.
 *
 *   npm run tenants:migrate                        everything (src/lib/platform/tenant-migrations.ts)
 *   npm run tenants:migrate -- --only <slug>       one workspace, e.g. to retry one a run left held
 *   npm run tenants:migrate -- --only a,b,c        those workspaces, and nothing else
 *
 * Exits non-zero when anything failed, so a deploy script stops there.
 */
import "dotenv/config";
import { closeControlDb } from "../src/lib/platform/control-db";
import { migrateEverything } from "../src/lib/platform/tenant-migrations";

/** The slugs after `--only` (or `--only=`), comma-separated; null without `--only`; empty when it names none. */
function onlyArgument(args: string[]): string[] | null {
  const inline = args.find((a) => a.startsWith("--only="));
  const at = args.indexOf("--only");
  if (inline === undefined && at < 0) return null;
  const value = inline !== undefined ? inline.slice("--only=".length) : (args[at + 1] ?? "");
  if (value.startsWith("--")) return [];
  return [...new Set(value.split(",").map((s) => s.trim()).filter(Boolean))];
}

async function main() {
  const only = onlyArgument(process.argv.slice(2));
  if (only && only.length === 0) {
    // Never read as "everything": a list that came out empty is a mistake, not a full run.
    console.error("Name the workspaces after --only: --only <slug>, or --only a,b,c");
    process.exitCode = 1;
    return;
  }
  console.log(!only ? "Migrating every database" : only.length === 1 ? `Migrating workspace "${only[0]}"` : `Migrating ${only.length} workspaces: ${only.join(", ")}`);
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

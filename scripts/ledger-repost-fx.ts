/**
 * Posts again, at their own rate, the foreign-currency documents the ledger booked at rate 1.
 *
 *   npm run ledger:repost-fx                               every active workspace — a dry run
 *   npm run ledger:repost-fx -- --workspace <slug>         one workspace
 *   npm run ledger:repost-fx -- --apply                    write the repairs
 *   npm run ledger:repost-fx -- --dry-run                  the default, said out loud
 *
 * A dry run by default: it lists each invoice, credit note and bill whose live entry carries the
 * wrong receivable or payable, what it should carry, and the day the repair would be dated, and
 * writes nothing. `--apply` reverses each one and posts it again at its rate (src/lib/ledger/repost-fx.ts),
 * a document per transaction, attributed to the workspace's super admin. Safe to run again: a
 * repaired document's live entry is right, so a second run finds nothing.
 *
 * Each workspace is opened on a client of its own (`directClient`), the way the other scripts do,
 * and closed before the next. Exits non-zero when any document could not be repaired.
 */
import "dotenv/config";
import { closeControlDb } from "../src/lib/platform/control-db";
import { repairFxPostings } from "../src/lib/ledger/repost-fx";
import { directClient } from "../src/lib/tenancy/direct-client";
import { activeTenants, tenantBySlug } from "../src/lib/tenancy/registry";
import type { Tenant } from "../src/lib/tenancy/state";

const args = process.argv.slice(2);
// `--dry-run` is what happens anyway; it wins if both are given.
const apply = args.includes("--apply") && !args.includes("--dry-run");
const say = (line: string) => console.log(line);

async function targets(): Promise<Tenant[]> {
  const named = args.indexOf("--workspace");
  if (named < 0) return activeTenants();
  const slug = args[named + 1] ?? "";
  const tenant = await tenantBySlug(slug);
  if (!tenant) throw new Error(`There is no workspace "${slug}".`);
  return [tenant];
}

async function main() {
  const tenants = await targets();
  say(apply ? "Repairing foreign-currency postings.\n" : "Dry run — nothing will be written. Pass --apply to repair.\n");

  let found = 0;
  let repaired = 0;
  let failed = 0;
  for (const tenant of tenants) {
    say(`— ${tenant.name} (${tenant.slug}) —`);
    const client = directClient(tenant.dbUrl, { max: 2 });
    try {
      const outcome = await repairFxPostings(client, { apply, say });
      found += outcome.found.length;
      repaired += outcome.repaired.length;
      failed += outcome.failures.length;
    } catch (error) {
      failed += 1;
      say(`  ✗ ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await client.$disconnect();
    }
    say("");
  }

  say(
    apply
      ? `${repaired} document(s) repaired across ${tenants.length} workspace(s)${failed ? `; ${failed} failed` : ""}.`
      : `${found} document(s) to repair across ${tenants.length} workspace(s).`,
  );
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeControlDb());

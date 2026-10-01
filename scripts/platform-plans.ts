/**
 * The plan catalogue, from the server.
 *
 *   npm run platform:plans -- products [--dry-run] [--allow-removals]   the products as plans, made or brought up to date
 *   npm run platform:plans -- list                                      every plan: key, kind, product, default, on sale
 *
 * `products` makes Deskzo One, a plan for each product and the add-ons (src/lib/platform/product-plans.ts,
 * which says what it owns and what it leaves to staff). It is safe to run again: a run that finds them
 * as products.ts has them changes nothing. `--dry-run` says what it would do and writes nothing;
 * `--allow-removals` lets it take a module off a plan that workspaces are on. Prices are staff's to
 * add in the console — nothing here calls a gateway.
 */
import "dotenv/config";
import { closeControlDb, controlDb } from "../src/lib/platform/control-db";
import { syncProductPlans } from "../src/lib/platform/product-plans";

const args = process.argv.slice(2);
const ACTOR = "script:platform:plans";

async function main() {
  const [command] = args;
  switch (command) {
    case "products": {
      const dryRun = args.includes("--dry-run");
      const lines = await syncProductPlans({ actor: ACTOR, dryRun, allowRemovals: args.includes("--allow-removals") });
      for (const line of lines) {
        const outcome = dryRun && (line.outcome === "created" || line.outcome === "updated") ? `would be ${line.outcome}` : line.outcome;
        const what = line.changes.length ? `  ${line.changes.join("; ")}` : "";
        console.log(`${line.key.padEnd(22)} ${outcome.padEnd(18)}${what}${line.note ? `  (${line.note})` : ""}`);
      }
      const refused = lines.filter((l) => l.outcome === "refused").length;
      const changed = lines.filter((l) => l.outcome === "created" || l.outcome === "updated").length;
      console.log(dryRun ? `\nDry run: ${changed} to change, nothing written.` : `\n${changed} changed, ${lines.length - changed - refused} as they were.`);
      if (refused) {
        console.error(`${refused} refused — see above.`);
        process.exitCode = 1;
      }
      return;
    }
    case "list": {
      const plans = await controlDb().plan.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { key: true, name: true, kind: true, productKey: true, isDefault: true, active: true, countries: true, _count: { select: { prices: { where: { active: true } } } } } });
      for (const p of plans) {
        const flags = [p.isDefault ? "default" : "", p.active ? "" : "retired", p._count.prices ? `${p._count.prices} price${p._count.prices === 1 ? "" : "s"}` : "no price", p.countries.length ? p.countries.join(",") : ""].filter(Boolean).join(", ");
        console.log(`${p.key.padEnd(24)} ${p.kind.padEnd(9)} ${(p.productKey ?? "—").padEnd(14)} ${p.name}  (${flags})`);
      }
      return;
    }
    default:
      console.log("Commands: products [--dry-run] [--allow-removals], list — see the top of scripts/platform-plans.ts.");
      process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeControlDb());

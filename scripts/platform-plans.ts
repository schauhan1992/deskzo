/**
 * The plan catalogue, from the server.
 *
 *   npm run platform:plans -- products [--dry-run] [--allow-removals]   the products as plans, made or brought up to date
 *   npm run platform:plans -- list                                      every plan: key, kind, product, default, on sale
 *   npm run platform:plans -- prices [--apply] [--remake]               the launch prices for India (src/lib/platform/price-book.ts)
 *
 * `products` makes Deskzo One, a plan for each product and the add-ons (src/lib/platform/product-plans.ts,
 * which says what it owns and what it leaves to staff). It is safe to run again: a run that finds them
 * as products.ts has them changes nothing. `--dry-run` says what it would do and writes nothing;
 * `--allow-removals` lets it take a module off a plan that workspaces are on. Nothing but `prices --apply`
 * calls a gateway.
 *
 * `prices` says what the launch price book would change — the people each plan's unit includes, and its
 * monthly and yearly price in rupees — and writes nothing. `prices --apply` makes each price at Razorpay
 * (its keys must be in the console, Settings › Billing — test keys first) and here, as the console does.
 * Prices are staff's to change in the console afterwards. `--remake` makes every price again, even one
 * that matches — once, when Razorpay's live keys replace its test keys.
 */
import "dotenv/config";
import { closeControlDb, controlDb } from "../src/lib/platform/control-db";
import { syncProductPlans } from "../src/lib/platform/product-plans";
import { INDIA_LAUNCH_PRICES, applyPriceBook } from "../src/lib/platform/price-book";

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
    case "prices": {
      const apply = args.includes("--apply");
      const lines = await applyPriceBook(INDIA_LAUNCH_PRICES, { actor: "script:platform:prices", dryRun: !apply, remake: args.includes("--remake") });
      for (const line of lines) {
        const outcome = !apply && line.outcome === "priced" ? "would be priced" : line.outcome;
        console.log(`${line.planKey.padEnd(22)} ${outcome.padEnd(16)}${line.changes.length ? `  ${line.changes.join("; ")}` : ""}${line.note ? `  (${line.note})` : ""}`);
      }
      const priced = lines.filter((l) => l.outcome === "priced").length;
      const failed = lines.filter((l) => l.outcome === "missing" || l.outcome === "refused").length;
      console.log(apply ? `
${priced} priced, ${lines.length - priced - failed} as they were.` : `
Dry run: ${priced} to price, nothing written and no gateway called. Add --apply to make them.`);
      if (failed) {
        console.error(`${failed} not priced — see above.`);
        process.exitCode = 1;
      }
      return;
    }
    default:
      console.log("Commands: products [--dry-run] [--allow-removals], list, prices [--apply] [--remake] — see the top of scripts/platform-plans.ts.");
      process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeControlDb());

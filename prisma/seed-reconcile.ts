/**
 * A distributor statement to look at, with the drift a real one has.
 *
 *   npm run db:seed:reconcile
 *
 * Builds the file the way the distributor would — from our own orders, then bent in the specific
 * ways subscription billing actually goes wrong — writes it to `public/` so it can be uploaded
 * through the real screen, and runs the real reconciler over it so the numbers can be checked
 * before anybody clicks anything.
 *
 * Deliberately built *from* live orders rather than from invented ones: a fixture that matches
 * itself proves nothing about whether the matcher can find a real order, and the failure this
 * module exists to catch is precisely a failure to match.
 */
import "dotenv/config";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { db } from "../src/lib/db";
import { reconcile } from "../src/lib/reconcile/match";
import { applyMapping, guessMapping } from "../src/lib/reconcile/mapping";
import { catalogueSkus, soldInPeriod } from "../src/lib/reconcile/data";

const HEADERS = ["Part Number", "Description", "End Customer", "Qty", "Unit Price", "Extended Price", "Charge Start Date", "Charge End Date"];

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function main() {
  // The month just gone, which is what a statement covers.
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const end = new Date(now.getFullYear(), now.getMonth(), 0);
  const period = { start, end };

  /**
   * A real distributor, and the orders attributed to it.
   *
   * Without this the sample is unrealistic in the way that matters: a statement covers what we buy
   * from *one* supplier, and every order sourced elsewhere is legitimately absent from it. Left
   * unattributed, the first run of this reported 231 orders as "sold, not billed" against 7 real
   * findings — which is what prompted the vendor scoping in `reconcile`.
   */
  const vendor = await db.company.findFirst({
    where: { relationshipType: { in: ["DISTRIBUTOR", "VENDOR", "OEM"] } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  if (!vendor) {
    console.log("\n  No vendor company to attribute the statement to. Seed the demo data first.\n");
    process.exitCode = 1;
    return;
  }

  const sold = await soldInPeriod(period);
  if (sold.length < 12) {
    console.log(`\n  Only ${sold.length} orders overlap ${iso(start)}–${iso(end)}. Seed the demo data first:\n`);
    console.log("    npm run db:seed:demo\n");
    process.exitCode = 1;
    return;
  }

  // Deterministic: the same statement every run, so a number that moves means the code moved.
  const pick = [...sold].sort((a, b) => a.orderId.localeCompare(b.orderId)).slice(0, 40);

  // These are the ones this distributor supplies. Recorded for real, because the reconciler reads
  // `vendorId` from the order and a seed that faked it would be testing nothing.
  await db.companyProduct.updateMany({
    where: { id: { in: pick.map((o) => o.orderId) } },
    data: { vendorId: vendor.id },
  });
  for (const o of pick) o.vendorId = vendor.id;

  const money = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

  const rows: string[][] = [];
  const planned: string[] = [];
  const monthly = (annual: number | null) => Math.round(((annual ?? 0) / 12) * 100) / 100;

  pick.forEach((order, index) => {
    const unit = monthly(order.purchasePrice);
    let quantity = order.quantity;
    let rate = unit;
    let customer = order.companyName;
    let sku = order.sku;

    /**
     * The five ways a month's billing actually drifts, spread thinly through the file so that
     * finding them is a real search rather than reading the first five rows.
     */
    if (index === 3) {
      quantity = order.quantity + 5;
      planned.push(`row ${index + 2}: five seats added mid-term that nobody invoiced (${order.companyName})`);
    } else if (index === 9) {
      rate = Math.round(unit * 1.12 * 100) / 100;
      planned.push(`row ${index + 2}: a 12% price rise the order never recorded (${order.companyName})`);
    } else if (index === 14) {
      quantity = Math.max(1, order.quantity - 3);
      planned.push(`row ${index + 2}: billed for three fewer seats than we are invoicing (${order.companyName})`);
    } else if (index === 21) {
      /**
       * The legal name, in full and in capitals — which is how a distributor's billing system
       * actually writes a customer, because it is transcribed from the GST registration rather
       * than from whoever typed it into our CRM.
       *
       * It has to remain genuinely unmatchable to be worth testing: `normalizeCompanyName` only
       * lowercases and collapses whitespace, so "private limited" and "pvt ltd" stay different
       * strings. Appending a suffix to a name that already ends in one produced "… Pvt Ltd Pvt
       * Ltd", which tested the same thing and read like a bug.
       */
      customer = order.companyName
        .replace(/\bPvt\.?\s+Ltd\.?$/i, "Private Limited")
        .replace(/\bLLP$/i, "Limited Liability Partnership")
        .replace(/\s+&\s+Co\.?$/i, " and Company")
        .toUpperCase();
      planned.push(`row ${index + 2}: the legal name as the distributor writes it — "${customer}"`);
    } else if (index === 27) {
      sku = "MS-NCE-UNKNOWN-01";
      planned.push(`row ${index + 2}: a SKU that is not in our catalogue`);
    }

    // Rounded to the rupee, the way a real statement reads.
    const lineTotal = Math.round(rate * quantity * 100) / 100;
    rows.push([sku, order.orderLabel ?? "", customer, String(quantity), rate.toFixed(2), lineTotal.toFixed(2), iso(start), iso(end)]);
  });

  /**
   * A subscription that lapsed in March and is still being charged for — the single most expensive
   * thing this module finds, and one that cannot be built by bending an existing row, because the
   * whole point is that no live order of ours covers it.
   */
  const allSkus = await catalogueSkus();

  /**
   * A real order whose term ended before this period.
   *
   * It has to be a real one, with its real customer and SKU, or the line reads as an unknown product
   * instead of as what it is — a subscription that ended and is still being charged for.
   */
  const ended = sold.find((o) => o.endDate && o.endDate < start);
  if (ended) {
    const rate = monthly(ended.purchasePrice) || 1250;
    const total = Math.round(rate * ended.quantity * 100) / 100;
    rows.push([ended.sku, `${ended.orderLabel ?? ""} (cancelled)`, ended.companyName, String(ended.quantity), rate.toFixed(2), total.toFixed(2), iso(start), iso(end)]);
    planned.push(`row ${rows.length + 1}: a subscription that ended ${iso(ended.endDate!)} and is still being billed — ${money(total)} a month`);
  }

  // One of ours left off the statement entirely: either a vendor error, or never provisioned.
  const dropped = pick[5]!;
  const droppedIndex = rows.findIndex((r) => r[2] === dropped.companyName && r[0] === dropped.sku);
  if (droppedIndex >= 0) {
    rows.splice(droppedIndex, 1);
    planned.push(`omitted: ${dropped.companyName} — live on our side, absent from the statement`);
  }

  const csv = [HEADERS, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
  const file = path.resolve("public", "sample-vendor-statement.csv");
  await writeFile(file, csv, "utf8");

  // The real path, end to end: guess the columns, map the rows, run the reconciler.
  const parsed = rows.map((r) => Object.fromEntries(HEADERS.map((h, i) => [h, r[i] ?? ""])));
  const mapping = guessMapping(HEADERS);
  const mapped = applyMapping(parsed, mapping);
  const result = reconcile(mapped.rows.map((m) => m.row), sold, period, {
    billing: "MONTHLY",
    catalogSkus: allSkus,
    vendorId: vendor.id,
  });

  console.log(`\n  Wrote ${path.relative(process.cwd(), file)} — ${rows.length} lines covering ${iso(start)} to ${iso(end)}`);
  console.log(`  Attributed ${pick.length} orders to ${vendor.name}, so it reads like one distributor's statement.\n`);
  console.log("  What was built into it:\n");
  for (const line of planned) console.log(`    · ${line}`);

  console.log(`\n  What the reconciler makes of it:\n`);
  console.log(`    ${result.summary.matched} matched, ${result.summary.exceptions} to look at, ${money(result.summary.atRisk)} worth checking\n`);
  for (const [state, count] of Object.entries(result.summary.byState)) {
    if (count > 0 && state !== "MATCHED") console.log(`    ${String(count).padStart(3)}  ${state}`);
  }

  console.log(`\n  Upload it at /purchase/reconciliation against ${vendor.name} — the columns are guessed.\n`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());

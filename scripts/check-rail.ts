/**
 * The side rail's arithmetic.
 *
 * Two sums that look trivial and are not. The inclusive-tax one is the classic mistake — the tax
 * inside a figure is `amount × rate / (100 + rate)` and not `amount × rate / 100` — and the margin
 * one is the classic ambiguity, where "thirty per cent" means two different numbers depending on
 * which end you measure from. Both are wrong in a way that looks perfectly plausible on a quote,
 * which is exactly the kind of error nobody catches by reading the screen.
 *
 *   npm run check:rail
 *
 * Pure. No database, no session, no Next runtime.
 */
import { GST_RATES, marginOf, parseTool, splitTax } from "../src/lib/side-rail";
import { computeLine } from "../src/lib/gst-engine";

let failures = 0;
function ok(label: string, pass: boolean, detail: unknown = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== null ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
}
function eq(label: string, actual: unknown, expected: unknown, why = "") {
  ok(label, actual === expected, actual === expected ? why : `${actual} (expected ${expected})`);
}
function section(title: string) {
  console.log(`\n— ${title} —\n`);
}

section("Adding tax");

const added = splitTax(100000, 18, false, false);
eq("Eighteen per cent on a lakh", added.total, 118000);
eq("  taxable is what was entered", added.taxable, 100000);
eq("  split in half within the state", added.cgst, 9000);
eq("  both halves", added.sgst, 9000);
eq("  and no IGST", added.igst, 0);

const inter = splitTax(100000, 18, true, false);
eq("Interstate is one IGST line", inter.igst, 18000);
eq("  with no CGST", inter.cgst, 0);
eq("  and no SGST", inter.sgst, 0);

eq("Zero-rated adds nothing", splitTax(100000, 0, false, false).total, 100000);

section("Taking tax out again");

/**
 * The assertion this file exists for. `118000 × 18 / 100` is 21,240 and wrong; the answer is
 * 18,000. Three thousand rupees of difference on one line, and nothing on screen looks odd.
 */
const inclusive = splitTax(118000, 18, false, true);
eq("A lakh and eighteen thousand, tax included", inclusive.taxable, 100000, "not 96,760");
eq("  the tax inside it", inclusive.tax, 18000, "not 21,240");
eq("  and the total is untouched", inclusive.total, 118000);
ok(
  "  which is not what the naive formula gives",
  Math.round((118000 * 18) / 100) !== inclusive.tax,
  `naive ${Math.round((118000 * 18) / 100)} vs ${inclusive.tax}`,
);

ok(
  "Adding tax and taking it out again round-trips",
  splitTax(splitTax(54321, 12, false, false).total, 12, false, true).taxable === 54321,
  "or the two halves of the control disagree",
);

section("The parts add up to the whole");

// Every rate against a figure that does not divide evenly, because that is where a split loses a
// paisa — and a tax total that is a paisa off its parts is the one thing an accountant will spot.
for (const rate of GST_RATES) {
  const odd = splitTax(33333.33, rate, false, false);
  ok(
    `Intra-state at ${rate}% reconciles`,
    Math.abs(odd.taxable + odd.cgst + odd.sgst - odd.total) < 0.005,
    `${odd.taxable} + ${odd.cgst} + ${odd.sgst} = ${odd.total}`,
  );
  const oddInter = splitTax(33333.33, rate, true, true);
  ok(
    `  and interstate at ${rate}% reconciles`,
    Math.abs(oddInter.taxable + oddInter.igst - oddInter.total) < 0.005,
    `${oddInter.taxable} + ${oddInter.igst} = ${oddInter.total}`,
  );
}

section("The same answer the invoice will give");

/**
 * The assertion the calculator is really for.
 *
 * Anybody can write a tool that halves a number. The promise being made here is narrower and more
 * useful: that what this panel says is what the document will say when the figure is actually
 * quoted. So the same amounts go through `computeLine` — the engine every invoice, quotation and
 * credit note in this system is built from — and the two have to agree to the paisa, including
 * which side the odd one falls on.
 *
 * The first version of this file did not make that comparison and got it backwards: the
 * calculator put the spare paisa on SGST and the engine puts it on CGST. The assertion that was
 * supposed to catch it used a figure that split evenly, so it passed while being wrong.
 */
for (const [amount, rate] of [
  [100.01, 18],
  [33333.33, 5],
  [1, 28],
  [749.99, 12],
  [12345.67, 18],
] as const) {
  const engine = computeLine({ quantity: 1, unitPrice: amount, taxRatePercent: rate }, "INTRA_STATE");
  const rail = splitTax(amount, rate, false, false);
  ok(
    `₹${amount} at ${rate}% matches the GST engine`,
    rail.cgst === engine.cgstAmount && rail.sgst === engine.sgstAmount && rail.total === engine.lineTotal,
    `rail ${rail.cgst}/${rail.sgst}/${rail.total} vs engine ${engine.cgstAmount}/${engine.sgstAmount}/${engine.lineTotal}`,
  );

  const interRail = splitTax(amount, rate, true, false);
  const interEngine = computeLine({ quantity: 1, unitPrice: amount, taxRatePercent: rate }, "INTER_STATE");
  ok(
    `  and interstate at ${rate}% too`,
    interRail.igst === interEngine.igstAmount && interRail.total === interEngine.lineTotal,
    `rail ${interRail.igst}/${interRail.total} vs engine ${interEngine.igstAmount}/${interEngine.lineTotal}`,
  );
}

section("Margin and markup");

const m = marginOf(80000, 104000);
eq("Profit is the difference", m.profit, 24000);
eq("Margin is measured on the selling price", m.marginPercent, 23.08);
eq("Markup is measured on what we paid", m.markupPercent, 30);
ok(
  "  and they are not the same number",
  m.marginPercent !== m.markupPercent,
  "a 30% markup is a 23% margin — quoting the wrong one is how a deal stops being profitable",
);

eq("Selling at cost is no margin", marginOf(1000, 1000).marginPercent, 0);
eq("Selling below cost is negative", marginOf(1000, 800).profit, -200);
eq("  and says so as a percentage", marginOf(1000, 800).marginPercent, -25);

// Neither divisor may take the page down. Both are empty fields for as long as somebody is typing.
eq("Nothing entered does not divide by zero", marginOf(0, 0).marginPercent, 0);
eq("  nor does a cost of nothing", marginOf(0, 500).markupPercent, 0);

section("What the rail will open");

eq("A known tool opens", parseTool("calculator"), "calculator");
eq("An unknown one does not", parseTool("nonsense"), null, "a stale value must not render a panel that does not exist");
eq("  nor does nothing at all", parseTool(null), null);
eq("Support access, the super admin's, is remembered like any other", parseTool("support-access"), "support-access");

console.log(failures === 0 ? "\nAll side rail checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);

/**
 * Whether the reconciler finds what it is for, and — just as important — stays quiet otherwise.
 *
 * This module's whole value is separating twelve lines worth looking at from a hundred and eighty
 * that are not. It can fail in two directions and both destroy it:
 *
 *   - **Missing a real one.** A five-seat mid-term addition nobody invoiced goes through as matched,
 *     and the module is worse than useless because somebody now trusts it.
 *   - **Crying wolf.** A monthly line compared against an annual cost makes every row a price
 *     mismatch. Two hundred exceptions get scrolled past, and the twelve real ones go with them.
 *
 * So most of what follows is about the *quiet* direction: rounding noise, a vendor writing a name
 * differently, a term that ended the day the statement period began.
 *
 *   npm run check:reconcile
 *
 * Pure — no database, no fixtures to clean up.
 */
import {
  customerKey,
  expectedUnitCost,
  loseSkuKey,
  overlaps,
  reconcile,
  skuKey,
  withinTolerance,
  type SoldOrder,
  type StatementRow,
} from "../src/lib/reconcile/match";
import {
  applyMapping,
  guessMapping,
  missingRequired,
  parseAmount,
  parseDate,
  parseQuantity,
} from "../src/lib/reconcile/mapping";
import { emptyManualRow, parseManualRows, parsePasted, type ManualRow } from "../src/lib/reconcile/manual";

let failures = 0;
function ok(label: string, pass: boolean, detail: unknown = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== null ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
}
function section(title: string) {
  console.log(`\n— ${title} —\n`);
}

const d = (iso: string) => new Date(iso);
const SEPTEMBER = { start: d("2026-09-01"), end: d("2026-09-30") };

/** An M365 subscription: 10 seats, ₹9,000 a seat a year, running all of 2026. */
function order(over: Partial<SoldOrder> = {}): SoldOrder {
  return {
    orderId: "ord-1",
    companyId: "co-1",
    companyName: "Acme Industries",
    aliases: [],
    sku: "CFQ7TTC0LH18-0001",
    quantity: 10,
    purchasePrice: 9000,
    startDate: d("2026-01-01"),
    endDate: d("2026-12-31"),
    ...over,
  };
}

/** A statement line billing that subscription for one month: 10 × ₹750. */
function row(over: Partial<StatementRow> = {}): StatementRow {
  return {
    rowNumber: 1,
    sku: "CFQ7TTC0LH18-0001",
    customerRef: "Acme Industries",
    quantity: 10,
    unitCost: 750,
    lineTotal: 7500,
    ...over,
  };
}

const run = (rows: StatementRow[], sold: SoldOrder[], options = {}) =>
  reconcile(rows, sold, SEPTEMBER, { billing: "MONTHLY", ...options });

const only = (rows: StatementRow[], sold: SoldOrder[], options = {}) => run(rows, sold, options).lines[0]!;

function main() {
  section("The quiet case — nothing to report");

  {
    const r = run([row()], [order()]);
    ok("a line that agrees is matched", r.lines[0]!.state === "MATCHED", r.lines[0]!.note || r.lines[0]!.state);
    ok("  with no variance", r.lines[0]!.variance === 0);
    ok("  and nothing at risk", r.summary.atRisk === 0 && r.summary.exceptions === 0, JSON.stringify(r.summary));
  }

  {
    /**
     * The single most important negative case. ₹9,000 a year is ₹750 a month exactly here, but most
     * real prices do not divide cleanly — and a reconciler that flags every twelfth of a rupee is one
     * nobody opens twice.
     */
    const awkward = order({ purchasePrice: 9499 });
    const monthly = 9499 / 12; // 791.5833…
    const r = only([row({ unitCost: 791.58, lineTotal: 7915.8 })], [awkward]);
    ok("a twelfth that does not divide cleanly is still matched", r.state === "MATCHED", `${monthly} vs 791.58 → ${r.state}`);
  }

  ok("an annual statement compares against the annual price", only([row({ unitCost: 9000, lineTotal: 90000 })], [order()], { billing: "ANNUAL" }).state === "MATCHED");
  // The reason `billing` exists at all: get it wrong and every line is a false alarm.
  ok(
    "  and comparing an annual line as monthly would have flagged it",
    only([row({ unitCost: 9000, lineTotal: 90000 })], [order()]).state === "PRICE_MISMATCH",
  );

  section("Seats — the one this was built for");

  {
    // A customer's own admin adds five seats. The distributor bills for them; nobody here invoices.
    const r = only([row({ quantity: 15, lineTotal: 11250 })], [order()]);
    ok("billed for more seats than we sold", r.state === "QUANTITY_MISMATCH", r.state);
    ok("  the variance is the extra seats, not the whole line", r.variance === 3750, r.variance);
    ok("  and the note says how many", /5 seats/.test(r.note), r.note);
  }

  {
    // The other way: we may be invoicing for seats that are not provisioned.
    const r = only([row({ quantity: 7, lineTotal: 5250 })], [order()]);
    ok("billed for fewer seats than we sold", r.state === "QUANTITY_MISMATCH", r.state);
    ok("  and the variance is negative, because that direction is not a loss", r.variance === -2250, r.variance);
    ok("  with the note pointing the other way", /not provisioned/.test(r.note), r.note);
  }

  ok(
    "one extra seat is singular, because a report that says “1 seats” stops being read",
    /1 seat\b/.test(only([row({ quantity: 11, lineTotal: 8250 })], [order()]).note),
    only([row({ quantity: 11, lineTotal: 8250 })], [order()]).note,
  );

  section("Price");

  {
    const r = only([row({ unitCost: 820, lineTotal: 8200 })], [order()]);
    ok("a real price rise is flagged", r.state === "PRICE_MISMATCH", r.state);
    ok("  and costed across every seat", r.variance === 700, r.variance);
  }

  ok("a 1% drift is tolerated", only([row({ unitCost: 757, lineTotal: 7570 })], [order()]).state === "MATCHED");
  ok("  but 3% is not", only([row({ unitCost: 772, lineTotal: 7720 })], [order()]).state === "PRICE_MISMATCH");
  // Tiny figures: 1% of ₹5 is 5 paise, which would make every small line an exception.
  ok("a rupee of slack on very small figures", withinTolerance(5, 5.9) && !withinTolerance(5, 6.5));

  {
    const r = only([row()], [order({ purchasePrice: null })]);
    ok("no cost recorded is not a mismatch", r.state === "MATCHED", r.state);
    ok("  but it is said out loud rather than passed silently", /could not be checked/.test(r.note), r.note);
  }

  section("Being billed for what we did not sell");

  {
    // The expensive one: a cancelled subscription still being charged for.
    const lapsed = order({ endDate: d("2026-06-30") });
    const r = only([row()], [lapsed], { catalogSkus: ["CFQ7TTC0LH18-0001"] });
    ok("a term that ended before the period is not a match", r.state === "BILLED_NOT_SOLD", r.state);
    ok("  and the whole line is the variance, because nothing offsets it", r.variance === 7500, r.variance);
    ok("  with the company still identified, so somebody can act", r.matchedCompanyId === "co-1");
  }

  {
    const r = only([row({ customerRef: "Globex Corporation" })], [order()], { catalogSkus: ["CFQ7TTC0LH18-0001"] });
    ok("a customer we have never heard of", r.state === "UNKNOWN_CUSTOMER", r.state);
    ok("  quotes the name back, so it can be searched for", r.note.includes("Globex Corporation"), r.note);
  }

  {
    const r = only([row({ sku: "ADB-CC-TEAMS-01" })], [order()]);
    ok("a SKU not in the catalogue", r.state === "UNKNOWN_SKU", r.state);
    ok("  and suggests the mapping, which is the likelier cause", /mapping/.test(r.note), r.note);
  }

  {
    // The distinction the catalogue buys: stocked-but-unsold is a different job from unknown.
    const r = only([row({ sku: "ADB-CC-TEAMS-01" })], [order()], { catalogSkus: ["ADB-CC-TEAMS-01"] });
    ok("a SKU we stock but have sold to nobody here reads differently", r.state === "BILLED_NOT_SOLD", r.state);
  }

  section("The direction nobody looks in");

  /**
   * Which of our orders may be reported as missing from a statement, and it is emphatically not all
   * of them. A distributor's statement covers what we buy from that distributor; every order
   * supplied by anybody else is legitimately absent. Reporting all of them produced 231 false alarms
   * against 7 real findings on the first real file — the "crying wolf" failure this module cannot
   * survive, found by running it rather than by reading it.
   */
  const INGRAM = "vendor-ingram";
  const OTHER = "vendor-redington";

  {
    const theirs = order({ vendorId: INGRAM });
    const r = run([], [theirs], { vendorId: INGRAM });
    ok("an order we bought from this vendor, absent from their statement, is reported", r.lines[0]?.state === "SOLD_NOT_BILLED", r.lines[0]?.state);
    ok("  from our side, not the file's", r.lines[0]!.source === "OURS" && r.lines[0]!.rowNumber === null);
    ok("  priced at what it should have cost", r.lines[0]!.lineTotal === 7500, r.lines[0]!.lineTotal);
    ok("  and signed negative, because not being charged is not a loss", r.lines[0]!.variance === -7500, r.lines[0]!.variance);
    ok("  so it never inflates the at-risk figure", r.summary.atRisk === 0, r.summary.atRisk);
    ok("  and the note says what to check", /provisioned/.test(r.lines[0]!.note), r.lines[0]!.note);
  }

  ok(
    "an order bought from a different distributor is not their problem",
    run([], [order({ vendorId: OTHER })], { vendorId: INGRAM }).lines.length === 0,
  );

  {
    /**
     * An order with no supplier recorded cannot be checked against any one vendor's statement, so it
     * is counted rather than guessed at. An earlier version guessed — "this statement bills that SKU
     * for somebody else, so a missing one is suspicious" — and produced 152 findings on a real file,
     * a number that turned out to track catalogue overlap rather than anything true.
     */
    const unattributed = order({ orderId: "ord-9", vendorId: null, companyName: "Beta Foods" });
    const r = run([row({ customerRef: "Acme Industries" })], [order({ vendorId: INGRAM }), unattributed], { vendorId: INGRAM });
    ok(
      "an order with no supplier recorded is not reported as missing",
      !r.lines.some((l) => l.matchedOrderId === "ord-9"),
      r.lines.map((l) => l.state).join(","),
    );
    ok("  but it is counted, so the caveat is visible", r.summary.uncheckable === 1, r.summary.uncheckable);
    ok("  and a matched order is never counted as uncheckable", run([row()], [order({ vendorId: null })]).summary.uncheckable === 0);
    ok(
      "  nor is one that fell outside the period",
      run([], [order({ vendorId: null, endDate: d("2026-08-01") })]).summary.uncheckable === 0,
    );
  }

  ok(
    "an order that expired before the period is not reported as missing from it",
    run([], [order({ endDate: d("2026-08-15"), vendorId: INGRAM })], { vendorId: INGRAM }).lines.length === 0,
  );
  ok(
    "nor one that starts after it",
    run([], [order({ startDate: d("2026-10-01"), endDate: d("2027-09-30"), vendorId: INGRAM })], { vendorId: INGRAM }).lines.length === 0,
  );
  ok("a matched order is not also reported as unbilled", run([row()], [order({ vendorId: INGRAM })], { vendorId: INGRAM }).lines.length === 1);
  // Matching never consults the vendor: an order with the wrong supplier recorded still wants finding.
  ok(
    "a line still matches an order bought from someone else",
    only([row()], [order({ vendorId: OTHER })], { vendorId: INGRAM }).state === "MATCHED",
  );

  {
    /**
     * A spot check says nothing about what is not on it. Typing three lines to query one seat count
     * against a vendor with forty orders reported thirty-seven of them as "sold, not billed" before
     * this existed — which is the whole finding buried under the thing it was not asking about.
     */
    const theirs = order({ vendorId: INGRAM });
    const other = order({ orderId: "ord-2", sku: "AUTOCAD-LT", vendorId: INGRAM, companyName: "Beta Foods" });
    const whole = run([row()], [theirs, other], { vendorId: INGRAM });
    const spot = run([row()], [theirs, other], { vendorId: INGRAM, reportMissing: false });
    ok("a complete statement reports what is missing from it", whole.lines.some((l) => l.state === "SOLD_NOT_BILLED"));
    ok("  a spot check does not", !spot.lines.some((l) => l.state === "SOLD_NOT_BILLED"), spot.lines.map((l) => l.state).join(","));
    ok("  but still judges the lines it was given", spot.lines[0]!.state === "MATCHED", spot.lines[0]!.state);
    ok("  and reporting is on unless switched off", run([row()], [theirs, other], { vendorId: INGRAM }).lines.length === 2);
  }

  section("Ambiguity is admitted, not guessed at");

  {
    // A renewal overlapping the term it replaces. Both cover September.
    const original = order({ orderId: "ord-1", endDate: d("2026-09-15") });
    const renewal = order({ orderId: "ord-2", startDate: d("2026-09-01"), endDate: d("2027-08-31") });
    const r = only([row()], [original, renewal]);
    ok("two orders that could both be the line", r.state === "AMBIGUOUS", r.state);
    ok("  no variance is claimed, because none is known", r.variance === 0);
    ok("  and it says what to do about it", /re-run/.test(r.note), r.note);
  }

  section("Names, as distributors actually write them");

  ok("case and spacing", customerKey("ACME  Industries") === customerKey("acme industries"));
  ok("a tenant domain reduces to the company", customerKey("acme.onmicrosoft.com") === "acme");
  ok("  as does the ordinary domain", customerKey("acme.com") === "acme");
  ok("  and a subdomain", customerKey("mail.acme.com") === "acme");
  ok("  and a .co.in", customerKey("acme.co.in") === "acme");
  ok("  and a URL", customerKey("https://www.acme.com/") === "acme");
  ok("two different companies stay different", customerKey("acme.com") !== customerKey("globex.com"));
  ok("an empty reference is empty, not a wildcard", customerKey("   ") === "");

  {
    // The alias list is how a statement that names the Microsoft tenant still finds the company.
    const r = only([row({ customerRef: "acme-industries.onmicrosoft.com" })], [order({ aliases: ["acme-industries.com"] })]);
    ok("an alias matches where the name does not", r.state === "MATCHED", `${r.state} — ${r.note}`);
  }

  {
    // A reseller's order: the distributor names the end customer, we invoice the reseller.
    const viaReseller = order({ companyName: "Partner Distribution", aliases: ["Beta Foods Ltd"] });
    ok(
      "an end customer behind a reseller still matches",
      only([row({ customerRef: "Beta Foods Ltd" })], [viaReseller]).state === "MATCHED",
    );
  }

  section("SKUs");

  ok("case and stray spaces", skuKey(" cfq7ttc0lh18-0001 ") === "CFQ7TTC0LH18-0001");
  /**
   * The one that matters. Two Microsoft SKUs differing only in the last digits are different
   * products, and a normaliser that stripped punctuation would reconcile one against the other —
   * producing a confident, wrong, and entirely invisible match.
   */
  ok("SKUs differing only in their suffix stay distinct", skuKey("CFQ7TTC0LH18-0001") !== skuKey("CFQ7TTC0LH18-0002"));
  ok("  even under the loose key", loseSkuKey("CFQ7TTC0LH18-0001") !== loseSkuKey("CFQ7TTC0LH18-0002"));
  ok("the loose key forgives a space for a dash", loseSkuKey("CFQ7TTC0LH18 0001") === loseSkuKey("CFQ7TTC0LH18-0001"));
  ok(
    "and that is enough to match a vendor who writes it differently",
    only([row({ sku: "CFQ7TTC0LH18 0001" })], [order()]).state === "MATCHED",
  );

  section("Periods");

  ok("a term covering the whole period overlaps", overlaps({ start: d("2026-01-01"), end: d("2026-12-31") }, SEPTEMBER));
  ok("one ending on the first day still overlaps", overlaps({ start: d("2026-01-01"), end: d("2026-09-01") }, SEPTEMBER));
  ok("one ending the day before does not", !overlaps({ start: d("2026-01-01"), end: d("2026-08-31") }, SEPTEMBER));
  ok("one starting on the last day overlaps", overlaps({ start: d("2026-09-30"), end: d("2027-09-29") }, SEPTEMBER));
  ok("one starting the day after does not", !overlaps({ start: d("2026-10-01"), end: d("2027-09-30") }, SEPTEMBER));
  // An order with no dates is a subscription somebody has not finished filling in, not an expired
  // one — excluding it would hide exactly the records most likely to be wrong.
  ok("an order with no dates is treated as running", overlaps({ start: null, end: null }, SEPTEMBER));

  {
    const r = only([row({ periodStart: d("2026-07-01"), periodEnd: d("2026-07-31") })], [order({ endDate: d("2026-06-30") })], {
      catalogSkus: ["CFQ7TTC0LH18-0001"],
    });
    ok("a line carrying its own period is judged on that, not the statement's", r.state === "BILLED_NOT_SOLD", r.state);
  }

  section("The summary a person reads first");

  {
    const r = run(
      [
        row({ rowNumber: 1 }),
        row({ rowNumber: 2, quantity: 15, lineTotal: 11250 }),
        row({ rowNumber: 3, sku: "ADB-CC-2024", customerRef: "Globex" }),
        row({ rowNumber: 4, customerRef: "Never Heard Of Ltd" }),
      ],
      [order(), order({ orderId: "ord-2", sku: "AUTOCAD-LT", companyName: "Beta Foods", vendorId: "vendor-ingram" })],
      { catalogSkus: ["CFQ7TTC0LH18-0001", "AUTOCAD-LT"], vendorId: "vendor-ingram" },
    );

    ok("every statement row gets a verdict", r.lines.filter((l) => l.source === "STATEMENT").length === 4, r.lines.length);
    ok("  plus the unbilled order from our side", r.lines.some((l) => l.state === "SOLD_NOT_BILLED"));
    ok("matched and exceptions add up to the total", r.summary.matched + r.summary.exceptions === r.summary.total, JSON.stringify(r.summary));
    ok("  and the state tally does too", Object.values(r.summary.byState).reduce((a, b) => a + b, 0) === r.summary.total);
    // The number the page leads with. It has to be what is genuinely at stake, not a sum of
    // absolute differences — otherwise a quiet month reads as a crisis.
    ok("at-risk counts only what costs us money", r.summary.atRisk > 0, r.summary.atRisk);
    ok(
      "  and equals the positive variances exactly",
      r.summary.atRisk === Math.round(r.lines.reduce((s, l) => s + Math.max(0, l.variance), 0) * 100) / 100,
      r.summary.atRisk,
    );
  }

  ok("an empty statement against no orders is empty, not an error", run([], []).summary.total === 0);
  {
    // A statement uploaded before anybody recorded the orders: every line unknown, nothing crashes.
    const r = run([row({ rowNumber: 1 }), row({ rowNumber: 2 })], []);
    ok("a statement with nothing to match against reports every line", r.summary.total === 2 && r.summary.matched === 0);
  }

  ok("expectedUnitCost divides by twelve for monthly and not otherwise", expectedUnitCost(12000, "MONTHLY") === 1000 && expectedUnitCost(12000, "ANNUAL") === 12000 && expectedUnitCost(12000, "ONE_OFF") === 12000);

  section("Reading a distributor's columns");

  {
    // Ingram-ish.
    const m = guessMapping(["Part Number", "Description", "End Customer", "Qty", "Unit Price", "Extended Price"]);
    ok("a supplier's headers are guessed", m.sku === "Part Number" && m.customer === "End Customer" && m.quantity === "Qty", JSON.stringify(m));
    ok("  including the money columns", m.unitCost === "Unit Price" && m.lineTotal === "Extended Price", JSON.stringify(m));
  }

  {
    // Microsoft Partner Center-ish.
    const m = guessMapping(["ProductId", "OfferName", "CustomerDomainName", "Quantity", "UnitPrice", "Subtotal", "ChargeStartDate", "ChargeEndDate"]);
    ok("and another supplier's, which shares no column name with the first", m.sku === "ProductId" && m.customer === "CustomerDomainName", JSON.stringify(m));
    ok("  with the per-line period picked up", m.periodStart === "ChargeStartDate" && m.periodEnd === "ChargeEndDate", JSON.stringify(m));
  }

  {
    /**
     * The trap. A file with both "Unit Price" and "Price" must not let the loose pass take the
     * wrong one — the cost would then be out by a factor of the quantity on every single line, and
     * every line would be a price mismatch.
     */
    const m = guessMapping(["SKU", "Customer", "Qty", "Unit Price", "Price"]);
    ok("an exact header beats a loose one", m.unitCost === "Unit Price", JSON.stringify(m));
    ok("  and no column is mapped to two fields", new Set(Object.values(m)).size === Object.values(m).length, JSON.stringify(m));
  }

  ok("a file of unrecognisable headers guesses nothing rather than guessing wrongly", Object.keys(guessMapping(["A", "B", "C"])).length === 0);
  ok("the required three are named when missing", missingRequired({}).sort().join(",") === "customer,quantity,sku");
  ok("  and nothing is missing once they are mapped", missingRequired({ sku: "A", customer: "B", quantity: "C" }).length === 0);

  section("Numbers and dates, as they arrive");

  ok("an Indian grouping", parseAmount("1,23,456.78") === 123456.78);
  ok("an international one", parseAmount("1,234.56") === 1234.56);
  ok("a rupee symbol", parseAmount("₹9,000") === 9000);
  ok("a currency code", parseAmount("INR 750.00") === 750);
  ok("accounting parentheses mean negative", parseAmount("(1,250.00)") === -1250);
  ok("a plain minus does too", parseAmount("-750") === -750);
  ok("a number that is already a number", parseAmount(1234.5) === 1234.5);
  // The important refusal: a silent 0 is a line that reconciles against nothing and is never seen.
  ok("unreadable text is null, never zero", parseAmount("n/a") === null && parseAmount("") === null && parseAmount(undefined) === null);
  ok("and so is a stray dash", parseAmount("—") === null);

  ok("a whole seat count", parseQuantity("15") === 15);
  ok("a fraction is refused — there is no half licence", parseQuantity("1.5") === null);
  ok("a negative credit line is allowed through", parseQuantity("-5") === -5);

  ok("an ISO date", parseDate("2026-09-01")?.getMonth() === 8);
  // Slashed dates read as dd/mm — an Indian business buying from Indian distributors.
  ok("a slashed date is read day-first", parseDate("01/09/2026")?.getMonth() === 8);
  ok("  so the 13th is not mistaken for a month", parseDate("13/09/2026")?.getDate() === 13);
  ok("a two-digit year", parseDate("01/09/26")?.getFullYear() === 2026);
  ok("an impossible month is refused rather than rolled over", parseDate("01/13/2026") === null);
  ok("blank is null", parseDate("") === null && parseDate(null) === null);

  section("Applying the mapping to a file");

  {
    const mapping = { sku: "Part Number", customer: "End Customer", quantity: "Qty", unitCost: "Unit Price" };
    const result = applyMapping(
      [
        { "Part Number": "CFQ7TTC0LH18-0001", "End Customer": "Acme Industries", Qty: "10", "Unit Price": "750.00" },
        { "Part Number": "", "End Customer": "Globex", Qty: "5", "Unit Price": "100" },
        { "Part Number": "X", "End Customer": "Y", Qty: "two", "Unit Price": "100" },
        { "Part Number": "", "End Customer": "", Qty: "", "Unit Price": "" },
      ],
      mapping,
    );

    ok("the good row comes through", result.rows.length === 1, result.rows.length);
    ok("  numbered as the file numbers it, header included", result.rows[0]!.row.rowNumber === 2, result.rows[0]!.row.rowNumber);
    ok("  with the line total derived from the rate", result.rows[0]!.row.lineTotal === 7500, result.rows[0]!.row.lineTotal);
    ok("  and the original row kept whole", result.rows[0]!.raw["Part Number"] === "CFQ7TTC0LH18-0001");

    // 197 of 200 rows importing beats stopping at the first bad one and finding them one at a time.
    ok("bad rows are collected, not thrown on", result.problems.length === 2, JSON.stringify(result.problems));
    ok("  each naming its line and its reason", result.problems.every((p) => p.rowNumber > 0 && p.reason.length > 3));
    ok("  and a trailing blank line is not called a problem", !result.problems.some((p) => p.rowNumber === 5));
  }

  {
    // Only a total, no rate — a perfectly ordinary statement that must not be rejected.
    const result = applyMapping([{ S: "ABC", C: "Acme", Q: "10", T: "7,500.00" }], { sku: "S", customer: "C", quantity: "Q", lineTotal: "T" });
    ok("a unit cost is worked back from the total", result.rows[0]!.row.unitCost === 750, result.rows[0]!.row.unitCost);
  }

  {
    // Both present and disagreeing: kept as given, because that is the vendor's arithmetic to explain.
    const result = applyMapping([{ S: "ABC", C: "Acme", Q: "10", U: "750", T: "8000" }], { sku: "S", customer: "C", quantity: "Q", unitCost: "U", lineTotal: "T" });
    ok("neither figure is silently recomputed over the other", result.rows[0]!.row.unitCost === 750 && result.rows[0]!.row.lineTotal === 8000);
  }

  {
    // End to end: a raw file through the mapping and into the reconciler.
    const raw = [
      { "Part Number": "CFQ7TTC0LH18-0001", "End Customer": "acme.onmicrosoft.com", Qty: "15", "Unit Price": "₹750.00" },
    ];
    const mapped = applyMapping(raw, { sku: "Part Number", customer: "End Customer", quantity: "Qty", unitCost: "Unit Price" });
    const r = run(mapped.rows.map((m) => m.row), [order({ aliases: ["acme.com"] })]);
    ok("a file lands on the right order and the right verdict", r.lines[0]!.state === "QUANTITY_MISMATCH", r.lines[0]!.state);
    ok("  worth the five extra seats", r.lines[0]!.variance === 3750, r.lines[0]!.variance);
  }

  section("Typed in rather than uploaded");

  const typed = (over: Partial<ManualRow> = {}): ManualRow => ({
    ...emptyManualRow(),
    sku: "CFQ7TTC0LH18-0001",
    customerRef: "Acme Industries",
    quantity: "10",
    unitCost: "750",
    ...over,
  });

  {
    const r = parseManualRows([typed()]);
    ok("a typed line becomes a statement row", r.rows.length === 1 && r.problems.length === 0, JSON.stringify(r.problems));
    ok("  with the total worked out", r.rows[0]!.lineTotal === 7500, r.rows[0]!.lineTotal);
    ok("  and numbered from one, as the grid shows it", r.rows[0]!.rowNumber === 1);
  }

  ok(
    "a total with no rate works, and the rate is worked back",
    parseManualRows([typed({ unitCost: "", lineTotal: "7,500" })]).rows[0]!.unitCost === 750,
  );

  {
    /**
     * The same rules as a file, deliberately. Somebody typing has no more right to a silently-wrong
     * line than somebody uploading — and a hand-entered statement is if anything likelier to hold a
     * typo, because there is no source file to check it against afterwards.
     */
    const r = parseManualRows([
      typed(),
      typed({ sku: "" }),
      typed({ customerRef: "" }),
      typed({ quantity: "ten" }),
      typed({ quantity: "2.5" }),
      typed({ unitCost: "", lineTotal: "" }),
    ]);
    ok("one good line out of six", r.rows.length === 1, r.rows.length);
    ok("  and five refusals, each with a reason", r.problems.length === 5 && r.problems.every((p) => p.reason.length > 3), JSON.stringify(r.problems));
    ok("  a fractional seat count is refused", r.problems.some((p) => /whole number/.test(p.reason)));
    ok("  and a line with neither figure says which two it wants", r.problems.some((p) => /unit cost or a line total/.test(p.reason)));
  }

  // A grid always has a blank row at the bottom; complaining about it would be absurd.
  ok("blank rows are ignored without complaint", (() => {
    const r = parseManualRows([typed(), emptyManualRow(), emptyManualRow()]);
    return r.rows.length === 1 && r.problems.length === 0;
  })());
  ok("an empty grid parses to nothing, not an error", parseManualRows([emptyManualRow()]).rows.length === 0);

  {
    // End to end: typed rows through the same engine as a file.
    const r = run(parseManualRows([typed({ quantity: "15" })]).rows, [order()]);
    ok("typed rows reconcile exactly as uploaded ones do", r.lines[0]!.state === "QUANTITY_MISMATCH", r.lines[0]!.state);
    ok("  same variance", r.lines[0]!.variance === 3750, r.lines[0]!.variance);
  }

  section("Pasting from a sheet or a PDF");

  {
    // What Excel and Google Sheets actually put on the clipboard.
    const rows = parsePasted("CFQ7TTC0LH18-0001\tAcme Industries\t10\t750.00\nADB-CC-2024\tGlobex\t5\t2100.00");
    ok("tab-separated, as a spreadsheet copies it", rows.length === 2 && rows[0]!.sku === "CFQ7TTC0LH18-0001", JSON.stringify(rows[0]));
    ok("  columns land in the right fields", rows[0]!.customerRef === "Acme Industries" && rows[0]!.quantity === "10" && rows[0]!.unitCost === "750.00");
  }

  ok(
    "comma-separated, for a CSV opened in Notepad",
    parsePasted("SKU-1,Acme Industries,10,750").length === 1,
  );

  {
    /**
     * A PDF table has no separator at all — the columns were laid out with whitespace. Two or more
     * spaces, never one, because "Acme Engineering & Co" is a single cell and splitting on one
     * space would turn it into four.
     */
    const rows = parsePasted("CFQ7TTC0LH18-0001   Acme Engineering & Co   10   750.00");
    ok("space-aligned, as a PDF gives it", rows.length === 1 && rows[0]!.customerRef === "Acme Engineering & Co", JSON.stringify(rows[0]));
  }

  {
    // Pasting a table usually brings its headings; reconciling a row called "SKU / Customer / Qty"
    // produces one baffling exception every single time.
    const rows = parsePasted("Part Number\tCustomer\tQty\tUnit Price\nSKU-1\tAcme\t10\t750");
    ok("a heading row is dropped", rows.length === 1 && rows[0]!.sku === "SKU-1", JSON.stringify(rows));
  }
  ok(
    "but a first line that is real data is kept",
    parsePasted("SKU-1\tAcme\t10\t750\nSKU-2\tGlobex\t5\t100").length === 2,
  );

  ok("blank lines between rows are skipped", parsePasted("SKU-1\tAcme\t10\t750\n\n\nSKU-2\tGlobex\t5\t100").length === 2);
  ok("an empty paste gives nothing", parsePasted("").length === 0 && parsePasted("   \n  ").length === 0);
  ok("a short row leaves the rest blank rather than shifting", (() => {
    const r = parsePasted("SKU-1\tAcme\t10")[0]!;
    return r.unitCost === "" && r.lineTotal === "";
  })());

  {
    // The whole path: paste a PDF table, parse it, reconcile it.
    const pasted = parsePasted("Part Number   Customer   Qty   Unit Price\nCFQ7TTC0LH18-0001   Acme Industries   15   750.00");
    const parsed = parseManualRows(pasted);
    const r = run(parsed.rows, [order()]);
    ok("a pasted PDF table reaches a verdict", r.lines[0]!.state === "QUANTITY_MISMATCH", r.lines[0]!.state);
    ok("  worth the five extra seats", r.lines[0]!.variance === 3750, r.lines[0]!.variance);
  }

  console.log(failures === 0 ? "\nAll reconciliation checks passed.\n" : `\n${failures} check(s) failed.\n`);
  if (failures > 0) process.exitCode = 1;
}

main();

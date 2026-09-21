/**
 * Pro-rating seats added part-way through a subscription.
 *
 * The worked example throughout is the real one: 10 seats of M365 Business Basic from 10/08/2026 to
 * 09/08/2027, with more seats added later. Every figure here is one a customer can check with a
 * calendar, so each is stated rather than assumed.
 *
 *   npm run check:proration
 */
import {
  canAddTo,
  proRata,
  proRataMonths,
  remainingDays,
  remainingMonths,
  renewalGroup,
  termDays,
  termMonths,
} from "../src/lib/subscriptions/proration";
import { addonQuote } from "../src/lib/subscriptions/addon-quote";
import { computeLine } from "../src/lib/gst-engine";
import {
  addMonths,
  nextTerm,
  renewalOrderDraft,
} from "../src/lib/subscriptions/renewal-order";

let failures = 0;
function ok(label: string, pass: boolean, detail: string | number | null = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== null ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
}
function eq(label: string, actual: number | null, expected: number | null, why = "") {
  // Null is a real answer here — "there is no price" is different from zero, which reads as free —
  // so it is compared exactly, and only two numbers get the rounding tolerance.
  const pass =
    actual === null || expected === null ? actual === expected : Math.abs(actual - expected) < 0.005;
  console.log(
    `${pass ? "  ok  " : " FAIL "} ${label} — ${actual}${pass ? "" : ` (expected ${expected})`}${why ? ` · ${why}` : ""}`,
  );
  if (!pass) failures += 1;
}

const PARENT_START = "2026-08-10";
const PARENT_END = "2027-08-09";

console.log("\n— Counting days —\n");

eq("A one-year term is 365 days", termDays(PARENT_START, PARENT_END), 365, "10/08/2026 to 09/08/2027, both counted");
eq("A single day is one day", termDays("2026-08-10", "2026-08-10"), 1, "not zero");
eq("A leap year term is 366", termDays("2024-01-01", "2024-12-31"), 366);
eq("A calendar year is 365", termDays("2026-01-01", "2026-12-31"), 365);

console.log("\n— Days left to sell —\n");

eq("Adding on the first day buys the whole term", remainingDays(PARENT_START, PARENT_END), 365);
eq("Adding on the last day buys one day", remainingDays(PARENT_END, PARENT_END), 1, "they still get that day");
eq("Adding after expiry buys nothing", remainingDays("2027-08-10", PARENT_END), 0, "you can't sell time that's gone");
eq(
  "Adding on 15/11/2026",
  remainingDays("2026-11-15", PARENT_END),
  268,
  "15/11/2026 to 09/08/2027 inclusive",
);

console.log("\n— The price —\n");

// The scenario: ₹6,000 a year a seat, 5 extra seats from 15/11/2026, co-terming 09/08/2027.
const addon = proRata({
  fullTermUnitPrice: 6000,
  quantity: 5,
  addonStart: "2026-11-15",
  parentStart: PARENT_START,
  parentEnd: PARENT_END,
});
eq("  days charged", addon.daysCharged, 268);
eq("  full term", addon.fullTermDays, 365);
eq(
  "  per seat",
  addon.unitPrice,
  4405.48,
  "6,000 ÷ 365 × 268",
);
eq("  for five seats", addon.total, 22027.4, "the unit price × 5, exactly");
eq("  share of the term", Math.round(addon.fraction * 1000) / 10, 73.4, "%");

// The line has to multiply out, or a purchase manager queries it immediately.
ok(
  "The total is the unit price times the quantity, exactly",
  Math.abs(addon.total - Math.round(addon.unitPrice * 5 * 100) / 100) < 0.005,
  "rounding on the unit, not on the total",
);

ok("The workings name the daily rate", addon.workings.includes("a day"), addon.workings);
ok("  and the days", addon.workings.includes("268 of 365"));

const dayOne = proRata({
  fullTermUnitPrice: 6000,
  quantity: 3,
  addonStart: PARENT_START,
  parentStart: PARENT_START,
  parentEnd: PARENT_END,
});
eq("Adding on day one costs the full year", dayOne.unitPrice, 6000, "365 of 365 days");

const lastDay = proRata({
  fullTermUnitPrice: 6000,
  quantity: 1,
  addonStart: PARENT_END,
  parentStart: PARENT_START,
  parentEnd: PARENT_END,
});
eq("Adding on the last day costs one day", lastDay.unitPrice, 16.44, "6,000 ÷ 365");

const expired = proRata({
  fullTermUnitPrice: 6000,
  quantity: 5,
  addonStart: "2027-09-01",
  parentStart: PARENT_START,
  parentEnd: PARENT_END,
});
eq("Adding after expiry costs nothing", expired.total, 0);
ok("  and says to renew instead", expired.workings.includes("Renew it instead"), expired.workings);

// A monthly subscription, to confirm nothing assumes a year.
const monthly = proRata({
  fullTermUnitPrice: 500,
  quantity: 2,
  addonStart: "2026-08-20",
  parentStart: "2026-08-01",
  parentEnd: "2026-08-31",
});
eq("A monthly term pro-rates on its own length", monthly.daysCharged, 12, "20/08 to 31/08");
eq("  at the monthly daily rate", monthly.unitPrice, 193.55, "500 ÷ 31 × 12");

console.log("\n— What can be added to —\n");

const liveParent = {
  startDate: PARENT_START,
  endDate: PARENT_END,
  orderStatus: "FULFILLED",
  itemType: "SUBSCRIPTION",
  parentId: null,
};

ok(
  "A live subscription accepts seats",
  canAddTo({ parent: liveParent, addonStart: "2026-11-15", quantity: 5 }).length === 0,
);

const beforeStart = canAddTo({ parent: liveParent, addonStart: "2026-07-01", quantity: 5 });
ok("Starting before the parent is refused", beforeStart.some((p) => p.field === "startDate"), beforeStart[0]?.message);

const afterEnd = canAddTo({ parent: liveParent, addonStart: "2027-09-01", quantity: 5 });
ok("Starting after expiry is refused", afterEnd.some((p) => p.field === "startDate"), afterEnd[0]?.message);
ok("  and points at renewal", afterEnd[0]?.message.includes("Renew"), afterEnd[0]?.message);

const hardware = canAddTo({
  parent: { ...liveParent, itemType: "HARDWARE" },
  addonStart: "2026-11-15",
  quantity: 5,
});
ok("Hardware has no term to add to", hardware.some((p) => p.field === "parent"), hardware[0]?.message);

// An addon on an addon would leave the renewal not knowing which row is the real subscription.
const nested = canAddTo({
  parent: { ...liveParent, parentId: "some-parent" },
  addonStart: "2026-11-15",
  quantity: 5,
});
ok("An addon can't have its own addon", nested.some((p) => p.field === "parent"), nested[0]?.message);

const cancelled = canAddTo({
  parent: { ...liveParent, orderStatus: "CANCELLED" },
  addonStart: "2026-11-15",
  quantity: 5,
});
ok("A cancelled subscription is refused", cancelled.length > 0, cancelled[0]?.message);

const undated = canAddTo({
  parent: { ...liveParent, startDate: null, endDate: null },
  addonStart: "2026-11-15",
  quantity: 5,
});
ok("No term means nothing to pro-rate against", undated.some((p) => p.field === "parent"), undated[0]?.message);

const noSeats = canAddTo({ parent: liveParent, addonStart: "2026-11-15", quantity: 0 });
ok("Zero seats is refused", noSeats.some((p) => p.field === "quantity"));

console.log("\n— Renewal —\n");

// The whole scenario: 10 seats at ₹6,000, plus 5 added in November at a pro-rated ₹4,405.48.
const group = renewalGroup([
  { id: "parent", quantity: 10, unitPrice: 6000, fullTermUnitPrice: 6000, startDate: PARENT_START, isAddon: false },
  { id: "addon", quantity: 5, unitPrice: 4405.48, fullTermUnitPrice: 6000, startDate: "2026-11-15", isAddon: true },
]);
eq("The renewal is for every seat", group.totalQuantity, 15, "10 original plus 5 added");
eq("  at the full-year price, not the pro-rated one", group.renewalValue, 90000, "15 × 6,000, not 15 × 4,405");
ok("  and says what it's made of", group.note.includes("1 addon"), group.note);
ok("  with nothing missing", !group.incomplete);

// The trap: renewing at what the addon was actually charged would under-bill by the elapsed part.
const naive = 10 * 6000 + 5 * 4405.48;
ok(
  "Renewing at the charged price would under-bill",
  Math.round(group.renewalValue - naive) === 7973,
  `by ₹${Math.round(group.renewalValue - naive).toLocaleString("en-IN")} — which is why the full-year price is kept`,
);

const several = renewalGroup([
  { id: "p", quantity: 10, unitPrice: 6000, fullTermUnitPrice: 6000, startDate: PARENT_START, isAddon: false },
  { id: "a1", quantity: 5, unitPrice: 4405, fullTermUnitPrice: 6000, startDate: "2026-11-15", isAddon: true },
  { id: "a2", quantity: 3, unitPrice: 1200, fullTermUnitPrice: 6000, startDate: "2027-05-01", isAddon: true },
]);
eq("Several addons all come back together", several.totalQuantity, 18);
eq("  at the full price throughout", several.renewalValue, 108000, "18 × 6,000");
eq("  counted", several.addonCount, 2);

const missing = renewalGroup([
  { id: "p", quantity: 10, unitPrice: 6000, fullTermUnitPrice: null, startDate: PARENT_START, isAddon: false },
  { id: "a", quantity: 5, unitPrice: 4405, fullTermUnitPrice: null, startDate: "2026-11-15", isAddon: true },
]);
eq("A parent with no full-term price falls back to its own", missing.renewalValue, 60000, "the parent's price is a full term");
ok("  but the addon can't, so it's flagged", missing.incomplete, missing.note);
ok("  and the note warns before quoting", missing.note.includes("check before quoting"), missing.note);

const alone = renewalGroup([
  { id: "p", quantity: 10, unitPrice: 6000, fullTermUnitPrice: 6000, startDate: PARENT_START, isAddon: false },
]);
eq("A subscription with no addons is just itself", alone.totalQuantity, 10);
ok("  and says so plainly", alone.note === "10 seat(s).", alone.note);

const ro_iso = (d: Date) => d.toISOString().slice(0, 10);
/** `eq` above compares numbers with a tolerance; a date is a string and needs exact equality. */
function sameText(label: string, actual: unknown, expected: unknown, why = "") {
  const pass = actual === expected;
  console.log(
    `${pass ? "  ok  " : " FAIL "} ${label} — ${String(actual)}${pass ? "" : ` (expected ${String(expected)})`}${why ? ` · ${why}` : ""}`,
  );
  if (!pass) failures += 1;
}

console.log("\n— The renewal order —\n");

// The scenario from the addon work: 10 seats 10/08/2026–09/08/2027 at ₹6,000, plus seats added later.
const annual = nextTerm({ previousEnd: "2027-08-09", billingCycle: "ANNUAL" });
sameText("A renewal starts the day after the old term ends", annual.startDate, "2027-08-10", "no gap in cover");
sameText("  and ends the day before the next would begin", annual.endDate, "2028-08-09", "no day billed on two orders");
eq("  which is a full year", annual.days, 366, "2028 is a leap year");

const monthlyTerm = nextTerm({ previousEnd: "2026-09-30", billingCycle: "MONTHLY" });
sameText("A monthly term rolls a month", monthlyTerm.startDate, "2026-10-01");
sameText("  to the end of it", monthlyTerm.endDate, "2026-10-31");

const quarterly = nextTerm({ previousEnd: "2026-03-31", billingCycle: "QUARTERLY" });
sameText("A quarter is three months", quarterly.startDate, "2026-04-01");
sameText("  ending on the last day of the third", quarterly.endDate, "2026-06-30");

// Month-end arithmetic, which naive date maths gets wrong and nobody notices for a year.
sameText("31 January plus a month is the end of February", ro_iso(addMonths(new Date("2027-01-31T00:00:00Z"), 1)), "2027-02-28");
sameText("  and in a leap year, the 29th", ro_iso(addMonths(new Date("2028-01-31T00:00:00Z"), 1)), "2028-02-29");
sameText("  never spilling into March", ro_iso(addMonths(new Date("2027-01-31T00:00:00Z"), 1)).startsWith("2027-02") ? "february" : "spilled", "february");
sameText("29 February plus a year is the 28th", ro_iso(addMonths(new Date("2028-02-29T00:00:00Z"), 12)), "2029-02-28");

// A term ending on 28 Feb renews to 1 Mar, and that is right: the day after is the day after.
sameText("The term after one ending 28 Feb starts 1 March", nextTerm({ previousEnd: "2027-02-28" }).startDate, "2027-03-01");

console.log("\n— What it renews at —\n");

// The trap. `unitPrice` on a mid-term addition is a part-year figure.
const withAddons = renewalOrderDraft({
  quantity: 10,
  unitPrice: 6000,
  fullTermUnitPrice: 6000,
  endDate: "2027-08-09",
  billingCycle: "ANNUAL",
  group: { totalQuantity: 20, renewalValue: 120000, incomplete: false, note: "" },
});
eq("The renewal covers every seat", withAddons.quantity, 20, "10 original plus 10 added mid-term");
eq("  at the full-year price", withAddons.unitPrice, 6000);
eq("  so the order is worth", withAddons.value, 120000);
ok(
  "  and it says why the number grew",
  withAddons.warnings.some((w) => w.includes("added mid-term")),
  withAddons.warnings[0],
);

const proRatedOnly = renewalOrderDraft({
  quantity: 5,
  // What a mid-term addition was actually charged — eight months of a ₹6,000 seat.
  unitPrice: 4405.48,
  fullTermUnitPrice: 6000,
  endDate: "2027-08-09",
  billingCycle: "ANNUAL",
  group: null,
});
eq(
  "A pro-rated last price is never what it renews at",
  proRatedOnly.unitPrice,
  6000,
  "renewing at ₹4,405 would under-bill by four months",
);

const noFullTerm = renewalOrderDraft({
  quantity: 3,
  unitPrice: 2500,
  fullTermUnitPrice: null,
  endDate: "2027-08-09",
  billingCycle: "ANNUAL",
  group: null,
});
eq("With no full-term price it falls back to the last one", noFullTerm.unitPrice, 2500);
ok(
  "  but says so rather than pretending",
  noFullTerm.warnings.some((w) => w.includes("No full-term price")),
  noFullTerm.warnings[0],
);

const priceless = renewalOrderDraft({
  quantity: 1,
  unitPrice: null,
  fullTermUnitPrice: null,
  endDate: "2027-08-09",
  group: null,
});
eq("With no price at all there is no value", priceless.value, null, "rather than zero, which reads as free");
ok("  and it has to be filled in", priceless.warnings.some((w) => w.includes("No price on the original")));

const undatedRenewal = renewalOrderDraft({
  quantity: 1,
  unitPrice: 100,
  fullTermUnitPrice: 100,
  endDate: null,
  group: null,
});
sameText("With no expiry there is no term to propose", undatedRenewal.term, null);
ok("  and it says the dates need setting by hand", undatedRenewal.warnings.some((w) => w.includes("no expiry date")));

const plain = renewalOrderDraft({
  quantity: 10,
  unitPrice: 6000,
  fullTermUnitPrice: 6000,
  endDate: "2027-08-09",
  billingCycle: "ANNUAL",
  group: { totalQuantity: 10, renewalValue: 60000, incomplete: false, note: "" },
});
eq("A subscription with no additions renews as itself", plain.quantity, 10);
eq("  with nothing to warn about", plain.warnings.length, 0, "a quiet renewal should be quiet");



console.log("\n— The month basis —\n");

/**
 * The same worked example, counted the other way.
 *
 * 10/08/2026 to 09/08/2027 is a twelve-month term. A seat added on 10/11/2026 has nine months left
 * of it — August's final part-month counts because the seat is in use for it, which is how a vendor
 * who bills monthly bills.
 */
eq("A year is twelve months", termMonths("2026-08-10", "2027-08-09"), 12);
eq("  and a month is one", termMonths("2026-08-10", "2026-09-09"), 1);
eq("  a part month still counts as one", termMonths("2026-08-10", "2026-08-20"), 1);
eq("  never zero, however short", termMonths("2026-08-10", "2026-08-10"), 1);

eq("Nine months left from November", remainingMonths("2026-11-10", "2027-08-09"), 9);
eq("  none once the parent has expired", remainingMonths("2027-09-01", "2027-08-09"), 0);

const byMonth = proRataMonths({
  fullTermUnitPrice: 12000,
  quantity: 5,
  addonStart: "2026-11-10",
  parentStart: "2026-08-10",
  parentEnd: "2027-08-09",
});
eq("₹12,000 a year is ₹1,000 a month", Math.round(byMonth.dailyRate), 1000);
eq("  nine of them is ₹9,000 a seat", byMonth.unitPrice, 9000);
eq("  and ₹45,000 for five", byMonth.total, 45000);
eq("  charged for nine of twelve", byMonth.daysCharged, 9);
eq("  which is three quarters of the term", byMonth.fraction, 0.75);

/**
 * The reason both bases are offered rather than one.
 *
 * They genuinely differ, and the difference is what somebody is checking when they hold our figure
 * against a vendor's monthly invoice. If these ever came out equal the toggle would be decoration.
 */
const byDay = proRata({
  fullTermUnitPrice: 12000,
  quantity: 5,
  addonStart: "2026-11-10",
  parentStart: "2026-08-10",
  parentEnd: "2027-08-09",
});
ok(
  "The two bases do not agree, and are not meant to",
  byDay.total !== byMonth.total,
  `days ${byDay.total} vs months ${byMonth.total}`,
);
ok(
  "  both being a sensible share of the year",
  byDay.fraction > 0.7 && byDay.fraction < 0.8 && byMonth.fraction === 0.75,
  `${byDay.fraction} and ${byMonth.fraction}`,
);

// The invoice line has to multiply out in both, or a purchase manager queries it on sight.
for (const basis of [byDay, byMonth]) {
  ok(
    "A line multiplies out",
    Math.abs(basis.unitPrice * 5 - basis.total) < 0.005,
    `${basis.unitPrice} × 5 = ${basis.total}`,
  );
}

const lapsed = proRataMonths({
  fullTermUnitPrice: 12000,
  quantity: 3,
  addonStart: "2027-09-01",
  parentStart: "2026-08-10",
  parentEnd: "2027-08-09",
});
eq("Nothing is charged after the parent expires", lapsed.total, 0);
ok(
  "  and it says to renew instead",
  lapsed.workings.includes("Renew it instead"),
  "a zero with no explanation reads as a bug",
);


console.log("\n— The quote a salesperson pastes into an email —\n");

/**
 * The worked example from the request: 1 seat of M365 Business Premium at ₹18,870 a year, added
 * with 40 billable days left of a 365-day term.
 */
const forty = proRata({
  fullTermUnitPrice: 18870,
  quantity: 1,
  addonStart: "2026-09-20",
  parentStart: "2025-10-30",
  parentEnd: "2026-10-29",
});
eq("Forty billable days", forty.daysCharged, 40);
eq("  of a 365-day term", forty.fullTermDays, 365);

const quoted = addonQuote({
  productName: "Microsoft 365 Business Premium",
  quantity: 1,
  unit: "User",
  from: "2026-09-20",
  to: "2026-10-29",
  baseUnitPrice: 18870,
  taxRatePercent: 18,
  proRata: forty,
});

eq("Excluding tax", quoted.totalExclTax, forty.total);
eq("  eighteen per cent on top", quoted.taxAmount, Math.round(forty.total * 0.18 * 100) / 100);
eq("  and the payable figure is the two added", quoted.totalInclTax, quoted.totalExclTax + quoted.taxAmount);

/**
 * The assertion this file is for: the quote's tax is the invoice's tax.
 *
 * It comes from `computeLine`, the function every invoice line is built from, rather than from
 * multiplying by the rate here. A quote that is a paisa from the invoice it becomes is the kind of
 * discrepancy a purchase manager queries and nobody can explain, because both figures look right.
 */
const asInvoiced = computeLine(
  { quantity: 1, unitPrice: forty.unitPrice, taxRatePercent: 18 },
  "INTRA_STATE",
);
eq("The quote's tax is the invoice's tax", quoted.taxAmount, asInvoiced.cgstAmount + asInvoiced.sgstAmount);
eq("  and its payable is the invoice's line total", quoted.totalInclTax, asInvoiced.lineTotal);

ok(
  "Interstate would come to the same payable",
  computeLine({ quantity: 1, unitPrice: forty.unitPrice, taxRatePercent: 18 }, "INTER_STATE").lineTotal ===
    asInvoiced.lineTotal,
  "the split changes, the total does not — which is why only the total is quoted",
);

// Several seats, because per-seat and total are both printed and a reader will divide one by the
// other. They have to agree.
const five = proRata({
  fullTermUnitPrice: 18870,
  quantity: 5,
  addonStart: "2026-09-20",
  parentStart: "2025-10-30",
  parentEnd: "2026-10-29",
});
const fiveQuote = addonQuote({
  productName: "Microsoft 365 Business Premium",
  quantity: 5,
  unit: "User",
  from: "2026-09-20",
  to: "2026-10-29",
  baseUnitPrice: 18870,
  taxRatePercent: 18,
  proRata: five,
});
eq("Five seats multiply out before tax", fiveQuote.totalExclTax, Math.round(five.unitPrice * 5 * 100) / 100);
ok(
  "  and the per-seat inclusive figure divides back",
  Math.abs(fiveQuote.unitInclTax * 5 - fiveQuote.totalInclTax) < 0.05,
  `${fiveQuote.unitInclTax} × 5 vs ${fiveQuote.totalInclTax}`,
);

console.log("\n  The text it copies:\n");
console.log(
  quoted.text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n"),
);
console.log();

ok(
  "It is addressed to the team, not to one person",
  quoted.text.startsWith("Dear Team,"),
  "the quote gets forwarded on, and a name at the top of the right figures is how the wrong one gets sent",
);
ok("  and the product", quoted.text.includes("Microsoft 365 Business Premium"));
ok("  states the validity in full", quoted.text.includes("20-09-2026 to 29-10-2026"));
ok("  the billable days against the term", quoted.text.includes("Billable Days: 40") && quoted.text.includes("Total Period Days: 365"));
ok("  and the base it was worked out from", quoted.text.includes("Base Amount / User: ₹18,870.00"));
ok("The HTML flavour is a table", quoted.html.includes("<table") && quoted.html.includes("Product Details"));
ok("  carrying the same payable figure", quoted.html.includes("₹2,440.18"));
ok(
  "  with the styles written on the elements",
  !quoted.html.includes("<style") && quoted.html.includes("style=\""),
  "every email client strips a style block, so anything not inline is lost on paste",
);
ok(
  "  and its data escaped",
  addonQuote({
    productName: "AT&T <Business> Suite",
    quantity: 1,
    unit: "User",
    from: "2026-09-20",
    to: "2026-10-29",
    baseUnitPrice: 1000,
    taxRatePercent: 18,
    proRata: forty,
  }).html.includes("AT&amp;T &lt;Business&gt; Suite"),
  "a product name is data, and data that reaches markup unescaped breaks the table",
);

ok(
  "  with nothing left unfilled",
  !/\bundefined\b|\bNaN\b|\bnull\b/.test(quoted.text),
  "a placeholder that reaches a customer is worse than a missing line",
);

console.log(failures === 0 ? "\nAll proration checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);

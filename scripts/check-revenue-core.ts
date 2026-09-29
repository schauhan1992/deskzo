/**
 * check:revenue-core — revenue recognition's arithmetic and calendar, with no database.
 *
 * Revenue & Close (src/lib/revenue/periods.ts, and the two posting builders in src/lib/ledger/posting.ts):
 *
 *   · which invoice lines are earned over time, with the issue month read in India — 00:00 IST on
 *     1 October is October's, although UTC still says 30 September;
 *   · spreading an amount by day and evenly by month: month ends, leap years, one-day periods, periods
 *     inside one month, and every spread adding up to its amount to the paisa;
 *   · re-planning the unposted months, and which month a closed month's revenue is posted in;
 *   · the invoice and credit-note entries with a deferred part — and exactly the old entries without.
 *
 * Dates are written with India's offset spelled out. The suite also runs itself again under four
 * clocks (UTC, Asia/Kolkata, America/New_York, Pacific/Auckland) and requires identical answers:
 *
 *   npm run check:revenue-core
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  addMonths,
  allocate,
  dayKeyAt,
  dayKeyOf,
  defers,
  firstOpenMonth,
  isMonthOpen,
  lastCompletedMonth,
  lineRupees,
  monthDate,
  monthEntryDate,
  monthKeyAt,
  monthLabel,
  monthsBetween,
  patternFor,
  postingMonthFor,
  replan,
  spreadByDay,
  spreadEvenly,
  spreadOver,
  termDays,
  type MonthAmount,
} from "../src/lib/revenue/periods";
import { unrecognisedOf, recognisedOf, movedByHandOf, firstReplannableMonth } from "../src/lib/revenue/state";
import { inRupees, isBalanced, postCreditNote, postSalesInvoice, revenueOf, type DocumentFinancials } from "../src/lib/ledger/posting";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const ist = (s: string) => new Date(`${s}+05:30`);
const paise = (months: MonthAmount[]) => months.reduce((t, m) => t + Math.round(m.amount * 100), 0);
const sumsTo = (months: MonthAmount[], amount: number) => paise(months) === Math.round(amount * 100);
const show = (months: MonthAmount[]) => months.map((m) => `${m.month}:${m.amount}`).join(" ");
const amountOf = (months: MonthAmount[], month: string) => months.find((m) => m.month === month)?.amount;

// ─── What every clock must agree on ──────────────────────────────────────────────────────────────

/** A battery of answers that depend on dates, to be identical under every TZ. */
function fingerprint(): string {
  const instants = [
    "2026-09-30T23:59:59", "2026-10-01T00:00:00", "2026-10-01T05:29:59", "2026-10-01T05:30:00",
    "2027-03-31T23:30:00", "2027-04-01T00:10:00", "2028-02-29T12:00:00", "2028-03-01T00:00:00",
    "2026-12-31T23:59:59", "2027-01-01T00:00:00",
  ].map(ist);
  const lock = new Date("2026-09-30T00:00:00.000Z");
  const service = { type: "SERVICE", revenuePattern: null };
  const answers = {
    months: instants.map((d) => [monthKeyAt(d), dayKeyAt(d), lastCompletedMonth(d)]),
    defers: instants.map((d) => defers({ servicePeriodFrom: "2026-10-01", servicePeriodTo: "2026-10-31" }, service, d)),
    defersArrears: instants.map((d) => defers({ servicePeriodFrom: "2026-08-01", servicePeriodTo: "2026-08-31" }, { type: "SUBSCRIPTION" }, d)),
    patterns: instants.map((d) => patternFor(service, { servicePeriodFrom: "2026-10-15", servicePeriodTo: "2026-11-14" }, d)),
    year: spreadByDay(120000, "2026-01-01", "2026-12-31"),
    leap: spreadByDay(36600, "2028-01-01", "2028-12-31"),
    straddle: spreadByDay(1000, "2028-02-15", "2028-03-14"),
    evenly: spreadEvenly(12000, "2026-01-15", "2027-01-14"),
    dbDates: spreadByDay(5000, new Date("2026-09-15T00:00:00.000Z"), new Date("2026-11-14T00:00:00.000Z")),
    replan: replan(spreadByDay(120000, "2026-01-01", "2026-12-31").slice(9), 20000, "2026-10"),
    posting: ["2026-08", "2026-09", "2026-10"].map((m) => postingMonthFor(m, lock)),
    entryDates: ["2026-02", "2028-02", "2026-09"].map((m) => monthEntryDate(m).toISOString()),
    firstOpen: [firstOpenMonth(lock), firstOpenMonth(new Date("2026-09-15T00:00:00.000Z")), firstOpenMonth(null)],
    dayOfDb: dayKeyOf(new Date("2026-09-30T00:00:00.000Z")),
  };
  return JSON.stringify(answers);
}

if (process.argv.includes("--fingerprint")) {
  // A child run: print the zone it believes it is in, and the answers.
  console.log(JSON.stringify({ offset: new Date(2026, 0, 1).getTimezoneOffset(), hash: createHash("sha256").update(fingerprint()).digest("hex") }));
  process.exit(0);
}

// ─── 1. The calendar ─────────────────────────────────────────────────────────────────────────────

section("1. Months are India's");
ok("00:00 IST on 1 October (30 Sep 18:30 UTC) is October's", monthKeyAt(ist("2026-10-01T00:00:00")) === "2026-10", ist("2026-10-01T00:00:00").toISOString());
ok("  and 23:59:59 IST on 30 September is September's", monthKeyAt(ist("2026-09-30T23:59:59")) === "2026-09");
ok("  the day, too: 1 Oct 00:10 IST is 2026-10-01", dayKeyAt(ist("2026-10-01T00:10:00")) === "2026-10-01");
ok("a @db.Date value is read by its UTC parts: 2026-09-30T00:00Z is 30 September", dayKeyOf(new Date("2026-09-30T00:00:00.000Z")) === "2026-09-30");
ok("the last completed month at 00:10 IST on 1 October is September", lastCompletedMonth(ist("2026-10-01T00:10:00")) === "2026-09");
ok("  and at 23:50 IST on 30 September it is still August", lastCompletedMonth(ist("2026-09-30T23:50:00")) === "2026-08");
ok("  and across a year end: 1 Jan 2027 00:05 IST → Dec 2026", lastCompletedMonth(ist("2027-01-01T00:05:00")) === "2026-12");
ok("addMonths walks years both ways", addMonths("2026-11", 3) === "2027-02" && addMonths("2026-01", -1) === "2025-12" && addMonths("2026-09", 0) === "2026-09");
ok("monthsBetween is inclusive, and empty backwards", monthsBetween("2026-11", "2027-02").join() === "2026-11,2026-12,2027-01,2027-02" && monthsBetween("2026-05", "2026-04").length === 0);
ok("monthLabel reads 'Sep 2026'", monthLabel("2026-09") === "Sep 2026");
ok("a month's @db.Date is midnight UTC of its 1st", monthDate("2026-09").toISOString() === "2026-09-01T00:00:00.000Z");
const entry = monthEntryDate("2026-09");
ok("a month's entry is dated its last day at 12:00 UTC — 17:30 IST, the same day in India", entry.toISOString() === "2026-09-30T12:00:00.000Z" && dayKeyAt(entry) === "2026-09-30");
ok("  February's in a leap year is the 29th", monthEntryDate("2028-02").toISOString() === "2028-02-29T12:00:00.000Z");
ok("termDays counts both ends: a year is 365, a leap year 366, one day is 1", termDays("2026-01-01", "2026-12-31") === 365 && termDays("2028-01-01", "2028-12-31") === 366 && termDays("2026-09-30", "2026-09-30") === 1);

// ─── 2. Which lines defer ────────────────────────────────────────────────────────────────────────

section("2. Which lines are earned over time");
const service = { type: "SERVICE", revenuePattern: null };
const good = { type: "GOOD", revenuePattern: null };
const subscription = { type: "SUBSCRIPTION", revenuePattern: null };
const october = { servicePeriodFrom: "2026-10-01", servicePeriodTo: "2026-10-31" };
ok("patternFor: a SUBSCRIPTION is RATABLE without being told", patternFor(subscription, {}, ist("2026-09-10T10:00:00")) === "RATABLE");
ok("  a GOOD is earned at a point in time", patternFor(good, {}, ist("2026-09-10T10:00:00")) === "POINT_IN_TIME");
ok("  a SERVICE with a period past the issue month is RATABLE", patternFor(service, { servicePeriodFrom: "2026-09-15", servicePeriodTo: "2026-10-14" }, ist("2026-09-10T10:00:00")) === "RATABLE");
ok("  a SERVICE whose period ends in the issue month is not", patternFor(service, { servicePeriodFrom: "2026-09-01", servicePeriodTo: "2026-09-30" }, ist("2026-09-10T10:00:00")) === "POINT_IN_TIME");
ok("  an item's own pattern wins: POINT_IN_TIME on a subscription, RATABLE on a good",
  patternFor({ type: "SUBSCRIPTION", revenuePattern: "POINT_IN_TIME" }, {}, ist("2026-09-10T10:00:00")) === "POINT_IN_TIME" &&
  patternFor({ type: "GOOD", revenuePattern: "RATABLE" }, {}, ist("2026-09-10T10:00:00")) === "RATABLE");
ok("an October service invoiced at 23:59 IST on 30 September defers", defers(october, service, ist("2026-09-30T23:59:00")) === "RATABLE");
ok("  the same invoiced at 00:00 IST on 1 October is all earned in its issue month — recognised at once",
  defers(october, service, ist("2026-10-01T00:00:00")) === null, "a host-clock reading would put 1 Oct 00:00 IST in September and defer it");
ok("a period starting in the issue month and running on defers, for any item", defers({ servicePeriodFrom: "2026-09-15", servicePeriodTo: "2026-10-14" }, good, ist("2026-09-10T10:00:00")) === "RATABLE");
ok("  even one whose item says POINT_IN_TIME — the line's period past the month is the more specific fact",
  defers({ servicePeriodFrom: "2026-09-15", servicePeriodTo: "2026-10-14" }, { type: "SERVICE", revenuePattern: "POINT_IN_TIME" }, ist("2026-09-10T10:00:00")) === "RATABLE");
ok("a period wholly inside the issue month is recognised at once, RATABLE item or not",
  defers({ servicePeriodFrom: "2026-09-01", servicePeriodTo: "2026-09-30" }, subscription, ist("2026-09-10T10:00:00")) === null);
ok("a subscription billed in arrears (August, invoiced in September) defers into its months",
  defers({ servicePeriodFrom: "2026-08-01", servicePeriodTo: "2026-08-31" }, subscription, ist("2026-09-05T10:00:00")) === "RATABLE");
ok("  a service billed in arrears is recognised on the invoice", defers({ servicePeriodFrom: "2026-08-01", servicePeriodTo: "2026-08-31" }, service, ist("2026-09-05T10:00:00")) === null);
ok("no period, no deferral — even for a subscription", defers({}, subscription, ist("2026-09-10T10:00:00")) === null);
ok("half a period is no period", defers({ servicePeriodFrom: "2026-10-01" }, service, ist("2026-09-10T10:00:00")) === null);
ok("@db.Date values work as period ends", defers({ servicePeriodFrom: new Date("2026-10-01T00:00:00.000Z"), servicePeriodTo: new Date("2027-09-30T00:00:00.000Z") }, service, ist("2026-09-10T10:00:00")) === "RATABLE");
const stage = { billingMilestoneId: "bm1" };
ok("a line on a billing stage whose delivery milestone isn't done defers MILESTONE", defers(stage, service, ist("2026-09-10T10:00:00"), { deliveryMilestoneId: "m1", deliveryCompletedAt: null }) === "MILESTONE");
ok("  one whose milestone is done is recognised at once", defers(stage, service, ist("2026-09-10T10:00:00"), { deliveryMilestoneId: "m1", deliveryCompletedAt: ist("2026-09-01T10:00:00") }) === null);
ok("  one whose stage has no delivery milestone is recognised at once", defers(stage, service, ist("2026-09-10T10:00:00"), { deliveryMilestoneId: null, deliveryCompletedAt: null }) === null);

// ─── 3. Spreading ────────────────────────────────────────────────────────────────────────────────

section("3. By day, evenly, and to the paisa");
const year = spreadByDay(120000, "2026-01-01", "2026-12-31");
ok("₹1,20,000 over 1 Jan–31 Dec 2026 is twelve months", year.length === 12 && year[0].month === "2026-01" && year[11].month === "2026-12");
ok("  January is 31/365 of it: ₹10,191.78", amountOf(year, "2026-01") === 10191.78, amountOf(year, "2026-01"));
ok("  February 28/365: ₹9,205.48", amountOf(year, "2026-02") === 9205.48, amountOf(year, "2026-02"));
ok("  April 30/365: ₹9,863.01", amountOf(year, "2026-04") === 9863.01);
ok("  December takes the rounding difference: ₹10,191.80", amountOf(year, "2026-12") === 10191.8, amountOf(year, "2026-12"));
ok("  and the twelve add up to ₹1,20,000.00 exactly", sumsTo(year, 120000), paise(year));
const leap = spreadByDay(36600, "2028-01-01", "2028-12-31");
ok("a leap year at ₹100 a day: February is 29 days, ₹2,900", amountOf(leap, "2028-02") === 2900 && amountOf(leap, "2028-01") === 3100 && sumsTo(leap, 36600), show(leap.slice(0, 3)));
const common = spreadByDay(36500, "2027-01-01", "2027-12-31");
ok("  and a common year's February is ₹2,800", amountOf(common, "2027-02") === 2800 && sumsTo(common, 36500));
const straddle = spreadByDay(1000, "2028-02-15", "2028-03-14");
ok("15 Feb–14 Mar 2028 is 15 + 14 days: ₹517.24 and ₹482.76", amountOf(straddle, "2028-02") === 517.24 && amountOf(straddle, "2028-03") === 482.76 && sumsTo(straddle, 1000), show(straddle));
ok("one day is all in its month", show(spreadByDay(999.99, "2026-09-30", "2026-09-30")) === "2026-09:999.99");
ok("a period inside one month is one month", show(spreadByDay(5000, "2026-09-05", "2026-09-20")) === "2026-09:5000");
const twoDays = spreadByDay(100.01, "2026-09-30", "2026-10-01");
ok("30 Sep–1 Oct splits a paisa and still adds up", show(twoDays) === "2026-09:50.01 2026-10:50" && sumsTo(twoDays, 100.01), show(twoDays));
ok("@db.Date ends read as their calendar days", show(spreadByDay(5000, new Date("2026-09-15T00:00:00.000Z"), new Date("2026-11-14T00:00:00.000Z"))) === show(spreadByDay(5000, "2026-09-15", "2026-11-14")));
let backwards = "";
try {
  spreadByDay(100, "2026-10-01", "2026-09-30");
} catch (e) {
  backwards = e instanceof Error ? e.message : String(e);
}
ok("a period ending before it starts is refused", /can't end/.test(backwards), backwards);

const even = spreadEvenly(120000, "2026-01-01", "2026-12-31");
ok("evenly: a calendar year is ₹10,000 a month", even.every((m) => m.amount === 10000) && even.length === 12);
const offset = spreadEvenly(12000, "2026-01-15", "2027-01-14");
ok("evenly: 15 Jan–14 Jan is 17/31 of a month, eleven whole ones at ₹1,000, and 14/31",
  offset.length === 13 && amountOf(offset, "2026-01") === 548.39 && offset.slice(1, 12).every((m) => m.amount === 1000) && amountOf(offset, "2027-01") === 451.61 && sumsTo(offset, 12000),
  `${amountOf(offset, "2026-01")} … ${amountOf(offset, "2027-01")}`);
ok("evenly, one day is still the whole amount", show(spreadEvenly(250, "2026-02-28", "2026-02-28")) === "2026-02:250");

// Sweep: any amount over any period adds up.
let sweepBad = 0;
let sweepRuns = 0;
const starts = ["2026-01-01", "2026-01-31", "2026-02-28", "2027-12-31", "2028-02-29", "2026-09-17"];
const lengths = [1, 2, 27, 28, 29, 30, 31, 45, 59, 60, 89, 364, 365, 366, 400, 731, 1096];
const amounts = [0.01, 0.07, 1, 99.99, 1234.56, 100000, 9999999.99];
for (const s of starts) {
  for (const len of lengths) {
    const endAt = new Date(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)) + len - 1));
    const e = endAt.toISOString().slice(0, 10);
    for (const a of amounts) {
      for (const f of [spreadByDay, spreadEvenly]) {
        sweepRuns += 1;
        const out = f(a, s, e);
        if (!sumsTo(out, a) || out.some((m) => m.amount < 0 || Math.abs(m.amount * 100 - Math.round(m.amount * 100)) > 1e-6)) sweepBad += 1;
      }
    }
  }
}
ok(`every spread in a sweep of ${sweepRuns} adds up to its amount, to the paisa, with no negative month`, sweepBad === 0, `${sweepBad} bad`);

section("4. allocate");
ok("₹100 three ways: 33.33, 33.33, 33.34", allocate(100, [1, 1, 1]).join() === "33.33,33.33,33.34");
ok("₹0.06 over twelve equal months never goes negative, and adds up", (() => {
  const parts = allocate(0.06, Array(12).fill(1));
  return parts.every((p) => p >= 0) && Math.round(parts.reduce((t, p) => t + p, 0) * 100) === 6;
})(), allocate(0.06, Array(12).fill(1)).join());
ok("no weight at all puts it all in the last", allocate(50, [0, 0]).join() === "0,50");
ok("lineRupees at rate 1 gives each line its own taxable value", lineRupees(1500.5, [1000, 500.5]).join() === "1000,500.5");
ok("  a foreign invoice's $1,000 + $200 at ₹83.47 is ₹83,470 + ₹16,694", lineRupees(100164, [1000, 200]).join() === "83470,16694");
ok("  and $50.19 + $50.19 at ₹83.47 (₹8,378.72) splits to the paisa", lineRupees(8378.72, [50.19, 50.19]).join() === "4189.36,4189.36");

// ─── 5. Re-planning ──────────────────────────────────────────────────────────────────────────────

section("5. Re-planning the unposted months");
const q4 = year.slice(9); // Oct–Dec: 10191.78, 9863.01, 10191.80
const shrunk = replan(q4, 20000, "2026-10");
ok("Oct–Dec re-spread to ₹20,000 in proportion, adding up", shrunk.length === 3 && sumsTo(shrunk, 20000), show(shrunk));
ok("  in the same proportions: November stays the smallest", shrunk[1].amount < shrunk[0].amount && shrunk[1].amount < shrunk[2].amount);
const fromNov = replan(q4, 12000, "2026-11");
ok("from November on, only November and December are re-planned", fromNov.map((m) => m.month).join() === "2026-11,2026-12" && sumsTo(fromNov, 12000), show(fromNov));
ok("to nil, every month is nil", replan(q4, 0, "2026-10").every((m) => m.amount === 0));
const regrown = replan([], 5000, "2026-11", { from: "2026-01-01", to: "2026-12-31" });
ok("with no months left, it spreads by day over what is left of the period: 30 + 31 days", show(regrown) === "2026-11:2459.02 2026-12:2540.98" && sumsTo(regrown, 5000), show(regrown));
ok("  evenly when the schedule says so", show(replan([], 5000, "2026-11", { from: "2026-01-01", to: "2026-12-31", evenly: true })) === "2026-11:2500 2026-12:2500");
ok("  skipping posted months", show(replan([], 5000, "2026-11", { from: "2026-01-01", to: "2026-12-31", skip: ["2026-11"] })) === "2026-12:5000");
ok("  and all in the first open month once the period is over", show(replan([], 5000, "2027-02", { from: "2026-01-01", to: "2026-12-31" })) === "2027-02:5000");
ok("spreadOver leaves out skipped months and spreads over the rest", show(spreadOver(3000, "2026-01-01", "2026-03-31", { skip: ["2026-02"] })) === "2026-01:1500 2026-03:1500");
let negative = "";
try {
  replan(q4, -1, "2026-10");
} catch (e) {
  negative = e instanceof Error ? e.message : String(e);
}
ok("a re-plan to less than nothing is refused", /less than nothing/.test(negative));

section("6. What a schedule holds");
const lines = [
  { id: "a", month: "2026-10", amount: 100, posted: true },
  { id: "b", month: "2026-11", amount: 200, posted: false },
  { id: "c", month: "2026-12", amount: 300, posted: false },
];
ok("an ACTIVE schedule holds its unposted months", unrecognisedOf({ kind: "RATABLE", status: "ACTIVE", amount: 600, lines, credited: 0 }) === 500);
ok("  a COMPLETED or CANCELLED one holds nothing", unrecognisedOf({ kind: "RATABLE", status: "CANCELLED", amount: 600, lines, credited: 0 }) === 0);
ok("  a MILESTONE one not yet earned holds its amount less credits", unrecognisedOf({ kind: "MILESTONE", status: "ACTIVE", amount: 600, lines: [], credited: 150 }) === 450);
ok("recognised = amount − credited − unrecognised", recognisedOf({ kind: "RATABLE", status: "ACTIVE", amount: 650, lines, credited: 50 }) === 100);
ok("a schedule cancelled by hand shows what it moved outside its months", movedByHandOf({ kind: "RATABLE", status: "CANCELLED", amount: 600, lines: lines.slice(0, 1), credited: 0 }) === 500);
ok("  one credited to nil shows none", movedByHandOf({ kind: "RATABLE", status: "CANCELLED", amount: 600, lines: lines.slice(0, 1), credited: 500 }) === 0);
ok("the next month to re-plan into: the first unposted, else after the last posted, else the start",
  firstReplannableMonth({ lines, startDate: "2026-10-01" }, "2030-01") === "2026-11" &&
  firstReplannableMonth({ lines: lines.slice(0, 1), startDate: "2026-10-01" }, "2030-01") === "2026-11" &&
  firstReplannableMonth({ lines: [], startDate: "2026-10-01" }, "2030-01") === "2026-10");

// ─── 7. Posting month ────────────────────────────────────────────────────────────────────────────

section("7. Closed months catch up in the first open one");
const lock = new Date("2026-08-31T00:00:00.000Z");
ok("with the books closed to 31 Aug, August is closed and September open", !isMonthOpen("2026-08", lock) && isMonthOpen("2026-09", lock));
ok("  August's revenue goes to September as a catch-up", JSON.stringify(postingMonthFor("2026-08", lock)) === JSON.stringify({ month: "2026-09", catchUp: true }));
ok("  and so does June's", postingMonthFor("2026-06", lock).month === "2026-09");
ok("  September's stays in September", JSON.stringify(postingMonthFor("2026-09", lock)) === JSON.stringify({ month: "2026-09", catchUp: false }));
const midMonth = new Date("2026-09-15T00:00:00.000Z");
ok("closed to 15 Sep, September's last day is still open, so September takes its own", postingMonthFor("2026-09", midMonth).month === "2026-09" && !postingMonthFor("2026-09", midMonth).catchUp);
ok("  and August catches up into September", postingMonthFor("2026-08", midMonth).month === "2026-09");
ok("closed to 30 Sep, September's entry (30 Sep 12:00 UTC) is closed — P0's calendar-day rule", !isMonthOpen("2026-09", new Date("2026-09-30T00:00:00.000Z")) && postingMonthFor("2026-09", new Date("2026-09-30T00:00:00.000Z")).month === "2026-10");
ok("a lock carrying a time is read as its day", !isMonthOpen("2026-09", new Date("2026-09-30T18:29:00.000Z")) && isMonthOpen("2026-10", new Date("2026-09-30T18:29:00.000Z")));
ok("with no lock every month is its own", postingMonthFor("2020-01", null).month === "2020-01" && firstOpenMonth(null) === null);

// ─── 8. The entries ──────────────────────────────────────────────────────────────────────────────

section("8. The invoice and credit-note entries");
const invoice: DocumentFinancials = {
  companyId: "c1", docNumber: "INV-1", taxableValue: 120500, cgstAmount: 10845, sgstAmount: 10845, igstAmount: 0,
  shippingCharge: 500, withholdingAmount: -2410, adjustment: 0, adjustmentLabel: null, roundOff: 0, total: 139780,
};
ok("revenueOf is taxable value less freight", revenueOf(invoice) === 120000);
ok("with nothing deferred the entry is exactly the old one", JSON.stringify(postSalesInvoice({ ...invoice, deferred: 0 })) === JSON.stringify(postSalesInvoice(invoice)));
ok("  and without the field at all", JSON.stringify(postSalesInvoice({ ...invoice, deferred: undefined })) === JSON.stringify(postSalesInvoice(invoice)));
const split = postSalesInvoice({ ...invoice, deferred: 90000 });
const lineOf = (e: ReturnType<typeof postSalesInvoice>, key: string) => e.lines.filter((l) => l.account === key);
ok("₹90,000 deferred: Cr Sales ₹30,000, Cr Deferred Revenue ₹90,000",
  lineOf(split, "SALES")[0]?.credit === 30000 && lineOf(split, "DEFERRED_REVENUE")[0]?.credit === 90000, JSON.stringify(lineOf(split, "DEFERRED_REVENUE")));
ok("  the Deferred Revenue line names the customer", lineOf(split, "DEFERRED_REVENUE")[0]?.companyId === "c1");
ok("  AR, TDS, GST and freight untouched, and it balances",
  isBalanced(split.lines) && JSON.stringify(split.lines.filter((l) => l.account !== "SALES" && l.account !== "DEFERRED_REVENUE")) ===
    JSON.stringify(postSalesInvoice(invoice).lines.filter((l) => l.account !== "SALES")));
const allDeferred = postSalesInvoice({ ...invoice, deferred: 120000 });
ok("everything deferred: no Sales line at all", lineOf(allDeferred, "SALES").length === 0 && isBalanced(allDeferred.lines));
const usd = inRupees({ ...invoice, taxableValue: 1000, cgstAmount: 90, sgstAmount: 90, shippingCharge: 0, withholdingAmount: 0, total: 1180 }, 83.47);
const usdSplit = postSalesInvoice({ ...usd, deferred: lineRupees(revenueOf(usd), [600, 400])[0] });
ok("a $1,000 invoice at ₹83.47 deferring a $600 line: ₹50,082 deferred, ₹33,388 to Sales",
  lineOf(usdSplit, "DEFERRED_REVENUE")[0]?.credit === 50082 && lineOf(usdSplit, "SALES")[0]?.credit === 33388 && isBalanced(usdSplit.lines));

const credit: DocumentFinancials = { ...invoice, docNumber: "CN-1", taxableValue: 12000, cgstAmount: 1080, sgstAmount: 1080, shippingCharge: 0, withholdingAmount: 0, total: 14160 };
ok("a credit note with no reduction is exactly the old one", JSON.stringify(postCreditNote({ ...credit, deferredReduction: 0 })) === JSON.stringify(postCreditNote(credit)));
const reduced = postCreditNote({ ...credit, deferredReduction: 9000 });
ok("₹9,000 off deferred revenue: Dr Deferred Revenue ₹9,000, Dr Sales Returns ₹3,000",
  lineOf(reduced, "DEFERRED_REVENUE")[0]?.debit === 9000 && lineOf(reduced, "SALES_RETURNS")[0]?.debit === 3000 && isBalanced(reduced.lines));
const allReduced = postCreditNote({ ...credit, deferredReduction: 12000 });
ok("  all of it off deferred revenue: no Sales Returns line", lineOf(allReduced, "SALES_RETURNS").length === 0 && isBalanced(allReduced.lines));

// ─── 9. Every clock ──────────────────────────────────────────────────────────────────────────────

section("9. The same answers under every clock");
const mine = createHash("sha256").update(fingerprint()).digest("hex");
const zones: [string, number][] = [["UTC", 0], ["Asia/Kolkata", -330], ["America/New_York", 300], ["Pacific/Auckland", -780]];
for (const [zone, offsetMinutes] of zones) {
  let out = "";
  try {
    out = execSync("npx tsx scripts/check-revenue-core.ts --fingerprint", { encoding: "utf8", env: { ...process.env, TZ: zone }, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? e);
  }
  const line = out.trim().split("\n").pop() ?? "";
  let parsed: { offset?: number; hash?: string } = {};
  try {
    parsed = JSON.parse(line);
  } catch {
    parsed = {};
  }
  ok(`TZ=${zone}: the run really was on that clock (Jan offset ${parsed.offset} min)`, parsed.offset === offsetMinutes);
  ok(`  and gave the same answers as this run`, parsed.hash === mine, parsed.hash?.slice(0, 12));
}

console.log(failures === 0 ? `\nAll ${passes} revenue core checks passed.\n` : `\n${failures} check(s) FAILED, ${passes} passed.\n`);
process.exit(failures === 0 ? 0 : 1);

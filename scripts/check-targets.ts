/**
 * The target arithmetic.
 *
 * Worth checking because these numbers are shown to people about their own performance, and a
 * wrong one is not a rounding error — it tells somebody they are failing when they are not, or the
 * reverse. The pace calculation in particular is the whole value of the page: "60% achieved" says
 * almost nothing without knowing how much of the month is left.
 *
 *   npm run check:targets
 */
import type { TargetMetric } from "@prisma/client";
import {
  METRICS,
  financialYearLabel,
  formatMetric,
  metricByKey,
  monthWindow,
  progressOf,
  quarterWindow,
  suggestedWindows,
  whatIsNeeded,
  yearWindow,
} from "../src/lib/targets/metrics";

let failures = 0;
function ok(label: string, pass: boolean, detail: string | number | null = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== null ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
}
function eq(label: string, actual: number, expected: number, why = "") {
  const pass = Math.abs(actual - expected) < 0.005;
  console.log(
    `${pass ? "  ok  " : " FAIL "} ${label} — ${actual}${pass ? "" : ` (expected ${expected})`}${why ? ` · ${why}` : ""}`,
  );
  if (!pass) failures += 1;
}
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

// September 2026: 30 days, from the 1st to the 30th.
const SEP = { fromDate: "2026-09-01", toDate: "2026-09-30" };

console.log("\n— Periods —\n");

const sep = monthWindow(2026, 9);
ok("A month runs to its last day", sep.toDate === "2026-09-30", `${sep.fromDate} → ${sep.toDate}`);
ok("  and reads properly", sep.label === "September 2026", sep.label);

const feb = monthWindow(2024, 2);
ok("February in a leap year is 29 days", feb.toDate === "2024-02-29", feb.toDate);

// The financial year runs April to March, so Q1 is April to June — not January to March.
const q1 = quarterWindow(2026, 1);
ok("Q1 starts in April", q1.fromDate === "2026-04-01" && q1.toDate === "2026-06-30", `${q1.fromDate} → ${q1.toDate}`);
ok("  and is labelled by the financial year", q1.label === "Q1 2026-27", q1.label);

const q4 = quarterWindow(2026, 4);
ok("Q4 ends in March, the following calendar year", q4.toDate === "2027-03-31", `${q4.fromDate} → ${q4.toDate}`);

const fy = yearWindow(2026);
ok("A financial year is April to March", fy.fromDate === "2026-04-01" && fy.toDate === "2027-03-31", fy.label);

ok("April is in the new financial year", financialYearLabel(d("2026-04-01")) === "2026-27", financialYearLabel(d("2026-04-01")));
ok("March is still in the old one", financialYearLabel(d("2026-03-31")) === "2025-26", financialYearLabel(d("2026-03-31")));

// The quarter a date sits in, via the suggestions.
const inSeptember = suggestedWindows(d("2026-09-19"));
ok("September suggests Q2", inSeptember.some((w) => w.label === "Q2 2026-27"), inSeptember.map((w) => w.label).join(", "));
const inApril = suggestedWindows(d("2026-04-10"));
ok("April suggests Q1", inApril.some((w) => w.label === "Q1 2026-27"));
const inJanuary = suggestedWindows(d("2027-01-15"));
ok("January suggests Q4", inJanuary.some((w) => w.label === "Q4 2026-27"), inJanuary.map((w) => w.label).join(", "));
ok("  and the right financial year", inJanuary.some((w) => w.label === "FY 2026-27"));

const decemberNext = suggestedWindows(d("2026-12-05"));
ok("December rolls the next month into January", decemberNext.some((w) => w.label === "January 2027"));

console.log("\n— Pace —\n");

// Two thirds through the month (day 20 of 30), with two thirds done. Exactly on pace.
const onTrack = progressOf({ target: 3000000, achieved: 2000000, ...SEP, now: d("2026-09-20") });
eq("  days elapsed", onTrack.daysElapsed, 20, "the 20th is the 20th day");
eq("  days left", onTrack.daysLeft, 10);
eq("  expected by now", onTrack.expectedByNow, 2000000, "two thirds of ₹30L");
ok("Dead on pace reads as on track", onTrack.status === "ON_TRACK", onTrack.label);
eq("  and nothing is ahead or behind", onTrack.aheadBy, 0);

// Same 60%, wildly different situations — the reason pace exists at all.
const early = progressOf({ target: 1000000, achieved: 600000, ...SEP, now: d("2026-09-10") });
const late = progressOf({ target: 1000000, achieved: 600000, ...SEP, now: d("2026-09-27") });
eq("60% on the 10th is ahead", early.aheadBy, 266666.67, "expected only ₹3.33L by then");
ok("  and says so", early.status === "AHEAD", early.label);
ok("60% on the 27th is at risk", late.status === "AT_RISK", late.label);
ok(
  "  the same percentage, opposite readings",
  early.percent === late.percent && early.status !== late.status,
  `both ${early.percent}%`,
);

const behind = progressOf({ target: 1000000, achieved: 500000, ...SEP, now: d("2026-09-18") });
ok("A bit behind is amber, not red", behind.status === "BEHIND", behind.label);

// Past the finish line.
const met = progressOf({ target: 1000000, achieved: 1000000, ...SEP, now: d("2026-09-20") });
ok("Hitting it exactly is met", met.status === "MET", met.label);
const over = progressOf({ target: 1000000, achieved: 1400000, ...SEP, now: d("2026-09-20") });
ok("Beating it is still met", over.status === "MET", over.label);
eq("  and the percentage isn't capped", over.percent, 140, "140% is a real and useful number");

const missed = progressOf({ target: 1000000, achieved: 700000, ...SEP, now: d("2026-10-05") });
ok("A finished period that fell short is missed", missed.status === "MISSED", missed.label);
eq("  with no days left", missed.daysLeft, 0);
eq("  and elapsed capped at the period", missed.daysElapsed, 30, "not 35");

// A target set for next month.
const future = progressOf({ target: 1000000, achieved: 0, ...SEP, now: d("2026-08-15") });
ok("A period that hasn't started says so", future.status === "NOT_STARTED", future.label);
eq("  with nothing elapsed", future.daysElapsed, 0, "not a negative");
eq("  and nothing expected", future.expectedByNow, 0);

// The first day is day one, not day zero — otherwise everybody is infinitely behind on the 1st.
const firstDay = progressOf({ target: 3000000, achieved: 0, ...SEP, now: d("2026-09-01") });
eq("The first day counts as elapsed", firstDay.daysElapsed, 1);
eq("  so one day's worth is expected", firstDay.expectedByNow, 100000, "₹30L over 30 days");
eq("  and 29 days remain", firstDay.daysLeft, 29);

const lastDay = progressOf({ target: 3000000, achieved: 2900000, ...SEP, now: d("2026-09-30") });
eq("The last day has none left", lastDay.daysLeft, 0);
eq("  so nothing per day is required", lastDay.requiredPerDay, 0, "there's no day to spread it over");

console.log("\n— What's needed —\n");

const needing = progressOf({ target: 1000000, achieved: 400000, ...SEP, now: d("2026-09-20") });
eq("  remaining", needing.remaining, 600000);
eq("  per day from here", needing.requiredPerDay, 60000, "₹6L over the last 10 days");
eq("  managed per day so far", needing.currentPerDay, 20000, "₹4L over 20 days");
const sentence = whatIsNeeded(needing, "CURRENCY");
ok("The sentence says the amount", sentence.includes("₹6,00,000"), sentence);
ok("  the daily rate", sentence.includes("₹60,000"));
ok("  and the days left", sentence.includes("10 days left"));

const oneDay = progressOf({ target: 100, achieved: 90, ...SEP, now: d("2026-09-29") });
ok("One day left reads naturally", whatIsNeeded(oneDay, "COUNT").includes("the last day"), whatIsNeeded(oneDay, "COUNT"));

ok("A met target says so plainly", whatIsNeeded(met, "CURRENCY") === "Target met.");
ok("A future one doesn't scold", whatIsNeeded(future, "CURRENCY").includes("hasn't started"));

// Zero target: division by zero must not produce NaN or Infinity anywhere.
const zero = progressOf({ target: 0, achieved: 5000, ...SEP, now: d("2026-09-20") });
ok(
  "A zero target produces no NaN or Infinity",
  Object.values(zero).every((v) => typeof v !== "number" || Number.isFinite(v)),
  `percent ${zero.percent}, required ${zero.requiredPerDay}`,
);

const nothingYet = progressOf({ target: 1000000, achieved: 0, ...SEP, now: d("2026-09-15") });
ok("Nothing achieved is finite too", Number.isFinite(nothingYet.currentPerDay) && nothingYet.currentPerDay === 0);

console.log("\n— Metrics —\n");

ok("Every metric has a definition", METRICS.length === 15, `${METRICS.length}`);
ok(
  "  and every one says what it counts",
  METRICS.every((m) => m.counts.length > 20),
  "so nobody has to guess",
);
ok(
  "  the contentious ones say what they exclude",
  ["INVOICED_VALUE", "CALLS_CONNECTED", "ORDER_MARGIN", "VISITS_COMPLETED", "NEW_CUSTOMERS", "ADDON_VALUE"].every(
    (k) => !!metricByKey[k as TargetMetric].excludes,
  ),
  "cancelled invoices, unanswered calls, unknown margin, planned visits, repeat orders, the original subscription",
);
// A new customer is not a directory entry. Confusing the two would have the profiling team and the
// sales team paid for the same act.
ok(
  "New customers and companies added are different things",
  metricByKey.NEW_CUSTOMERS.team === "Sales" && metricByKey.COMPANIES_ADDED.team === "Profiling",
  "research versus revenue",
);
ok(
  "  and the definition says a repeat order doesn't count",
  metricByKey.NEW_CUSTOMERS.excludes!.includes("growth, not a new customer"),
  metricByKey.NEW_CUSTOMERS.excludes,
);
ok(
  "  and they cover every team",
  new Set(METRICS.map((m) => m.team)).size >= 5,
  [...new Set(METRICS.map((m) => m.team))].join(", "),
);
ok(
  "Money metrics are money and counts are counts",
  metricByKey.INVOICED_VALUE.unit === "CURRENCY" && metricByKey.CALLS_CONNECTED.unit === "COUNT",
);

console.log("\n— Formatting —\n");

ok("Rupees read Indian", formatMetric(2500000, "CURRENCY") === "₹25,00,000", formatMetric(2500000, "CURRENCY"));
ok("Counts are plain", formatMetric(1450, "COUNT") === "1,450", formatMetric(1450, "COUNT"));
ok("Minutes become hours", formatMetric(150, "MINUTES") === "2h 30m", formatMetric(150, "MINUTES"));
ok("  and stay minutes under an hour", formatMetric(45, "MINUTES") === "45m", formatMetric(45, "MINUTES"));

console.log(failures === 0 ? "\nAll target checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);

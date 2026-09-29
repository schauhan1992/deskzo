/**
 * check:close-core — the month-end close's calendar and arithmetic, with no database.
 *
 * Every date is written with India's offset spelled out, and every answer compared as an instant or a
 * `yyyy-mm-dd` calendar day, so the suite means the same under any clock — run it under a foreign one:
 *
 *   npm run check:close-core
 *   TZ=UTC npm run check:close-core
 *   $env:TZ = "America/New_York"; npm run check:close-core      (PowerShell — Git Bash drops a TZ with "/")
 *
 * What it pins:
 *   · months: parsing, the month an instant falls in at India's midnight, the half-open window, the
 *     last day and the 12:00 UTC posting date;
 *   · working days and due dates (Monday to Friday; a due day past the month's last working day is the
 *     last one), and "the last completed month" at 00:10 IST on the 1st;
 *   · the catch-up rule: which month a closed month's posting lands in, on what date, and an accrual's
 *     reversal date;
 *   · a schedule's months to the paisa, and re-planning only the unposted ones;
 *   · the flux flag at both thresholds;
 *   · the pure checks and the receivables tie-out on hand-built fixtures.
 */
import {
  addMonths,
  currentMonth,
  dayKey,
  dueOnFor,
  indiaToday,
  isWorkingDay,
  lastCompletedMonth,
  monthEnd,
  monthEndPostingDate,
  monthKeyOf,
  monthLabel,
  monthOfInstant,
  monthWindow,
  nextMonthFirstPostingDate,
  parseMonthKey,
  workingDayOfMonth,
} from "../src/lib/close/months";
import { postingDateFor, postingMonthFor, reversalDateFor, openDateToday } from "../src/lib/close/posting-months";
import { planLines, replanUnposted, spreadEvenly } from "../src/lib/close/plan";
import {
  checkBankReconciled,
  checkDepreciationRun,
  checkFluxExplained,
  checkInvoicesIssued,
  checkPayrollPosted,
  checkRevenueRecognised,
  checkSchedulesPosted,
} from "../src/lib/close/checks";
import { AUTO_CHECK_KEYS, DEFAULT_TEMPLATES, taskHref } from "../src/lib/close/catalogue";
import { fluxFigures, isFlagged, naturalBalance, percentChange } from "../src/lib/close/flux";
import { tieOut, type TieOutDocument } from "../src/lib/close/tieout";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const ist = (s: string) => new Date(`${s}+05:30`);
const day = (d: Date) => dayKey(d);
const month = (key: string) => parseMonthKey(key)!;
const sum = (xs: number[]) => Math.round(xs.reduce((t, x) => t + x, 0) * 100) / 100;

console.log(`Clock: TZ=${process.env.TZ ?? "(host)"}, offset ${-new Date().getTimezoneOffset()} min`);

section("Months");
ok("2026-09 parses to the 1st of September, as a @db.Date holds it", month("2026-09").toISOString() === "2026-09-01T00:00:00.000Z");
ok("  a month that isn't one is refused", parseMonthKey("2026-13") === null && parseMonthKey("26-09") === null && parseMonthKey("") === null);
ok("  and it prints back", monthKeyOf(month("2026-09")) === "2026-09" && monthLabel(month("2026-09")) === "September 2026" && monthLabel(month("2026-09"), "short") === "Sep 2026");
ok("23:59 IST on 30 September is September's", monthKeyOf(monthOfInstant(ist("2026-09-30T23:59:00"))) === "2026-09");
ok("00:10 IST on 1 October is October's (18:40 UTC on the 30th)", monthKeyOf(monthOfInstant(ist("2026-10-01T00:10:00"))) === "2026-10");
const sep = monthWindow(month("2026-09"));
ok("September's window opens at 00:00 IST on the 1st", sep.from.getTime() === ist("2026-09-01T00:00:00").getTime(), sep.from.toISOString());
ok("  and closes (exclusive) at 00:00 IST on 1 October", sep.to.getTime() === ist("2026-10-01T00:00:00").getTime(), sep.to.toISOString());
ok("its last day is the 30th", day(monthEnd(month("2026-09"))) === "2026-09-30");
ok("  February 2028 has a 29th (leap year)", day(monthEnd(month("2028-02"))) === "2028-02-29");
ok("  February 2026 doesn't", day(monthEnd(month("2026-02"))) === "2026-02-28");
ok("a month's entry is dated its last day at 12:00 UTC — 17:30 IST, the same day under any clock", monthEndPostingDate(month("2026-09")).getTime() === ist("2026-09-30T17:30:00").getTime());
ok("an accrual's reversal is dated the 1st of the next month, 17:30 IST", nextMonthFirstPostingDate(month("2026-09")).getTime() === ist("2026-10-01T17:30:00").getTime());
ok("months add across a year", monthKeyOf(addMonths(month("2026-11"), 3)) === "2027-02" && monthKeyOf(addMonths(month("2026-01"), -1)) === "2025-12");

section("Today, and the last completed month");
ok("at 00:10 IST on 1 October, India's today is the 1st", day(indiaToday(ist("2026-10-01T00:10:00"))) === "2026-10-01");
ok("  and the last completed month is September", monthKeyOf(lastCompletedMonth(ist("2026-10-01T00:10:00"))) === "2026-09");
ok("at 23:50 IST on 30 September it is still August", monthKeyOf(lastCompletedMonth(ist("2026-09-30T23:50:00"))) === "2026-08");
ok("the current month at 05:00 IST on 1 January is January", monthKeyOf(currentMonth(ist("2027-01-01T05:00:00"))) === "2027-01");

section("Working days and due dates");
ok("1 October 2026 is a Thursday, a working day", isWorkingDay(month("2026-10")));
ok("3 October 2026 is a Saturday", !isWorkingDay(new Date(Date.UTC(2026, 9, 3))));
ok("October 2026's 1st, 2nd and 3rd working days: 1, 2 and 5 October", [1, 2, 3].map((n) => day(workingDayOfMonth(month("2026-10"), n))).join(",") === "2026-10-01,2026-10-02,2026-10-05");
ok("September 2026's checklist, due on the 3rd working day, is due 5 October", day(dueOnFor(month("2026-09"), 3)) === "2026-10-05");
ok("a month that starts on a Saturday: August 2026's 1st working day is Monday the 3rd", day(workingDayOfMonth(month("2026-08"), 1)) === "2026-08-03");
ok("  so July 2026's day-1 task is due 3 August", day(dueOnFor(month("2026-07"), 1)) === "2026-08-03");
ok("a due day past the month's working days is its last working day (March 2026 → Tue 31 March)", day(dueOnFor(month("2026-02"), 31)) === "2026-03-31");
ok("  and one ending on a weekend stops at Friday (May 2026 → Fri 29 May)", day(workingDayOfMonth(month("2026-05"), 25)) === "2026-05-29");
ok("December's close falls due in January of the next year", day(dueOnFor(month("2026-12"), 3)) === "2027-01-05");
ok("June 2025's day-3 task is due Thursday 3 July 2025", day(dueOnFor(month("2025-06"), 3)) === "2025-07-03");

section("Where a scheduled month posts (the catch-up rule)");
const noLock = postingMonthFor(month("2026-08"), null);
ok("an open month posts in itself", monthKeyOf(noLock.postingMonth) === "2026-08" && !noLock.catchUp);
const lockAug = new Date(Date.UTC(2026, 7, 31));
const late = postingMonthFor(month("2026-07"), lockAug);
ok("July under a lock to 31 August catches up into September", monthKeyOf(late.postingMonth) === "2026-09" && late.catchUp);
const edge = postingMonthFor(month("2026-08"), lockAug);
ok("  so does August itself — its last day is locked", monthKeyOf(edge.postingMonth) === "2026-09" && edge.catchUp);
const lockMid = new Date(Date.UTC(2026, 7, 15));
const mid = postingMonthFor(month("2026-08"), lockMid);
ok("a lock to 15 August leaves August's last day open, so August posts in itself", monthKeyOf(mid.postingMonth) === "2026-08" && !mid.catchUp);
ok(
  "an open month's entry is dated its last day",
  postingDateFor(month("2026-09"), lockAug, ist("2026-10-05T10:00:00")).getTime() === ist("2026-09-30T17:30:00").getTime(),
);
ok(
  "a catch-up into the month in progress is dated today, not a month end still to come",
  postingDateFor(month("2026-10"), new Date(Date.UTC(2026, 8, 30)), ist("2026-10-05T10:00:00")).getTime() === ist("2026-10-05T17:30:00").getTime(),
);
ok(
  "  and never inside the lock: locked through today, it is tomorrow",
  day(postingDateFor(month("2026-10"), new Date(Date.UTC(2026, 9, 5)), ist("2026-10-05T10:00:00"))) === "2026-10-06",
);
ok(
  "an accrual's reversal: the 1st of the next month",
  reversalDateFor(month("2026-08"), monthEndPostingDate(month("2026-08")), null).getTime() === ist("2026-09-01T17:30:00").getTime(),
);
ok(
  "  a caught-up accrual's reversal lands with it, never before",
  day(reversalDateFor(month("2026-07"), ist("2026-09-05T17:30:00"), lockAug)) === "2026-09-05",
);
ok("\"today\" for an entry is India's today at 12:00 UTC", openDateToday(null, ist("2026-10-01T00:10:00")).toISOString() === "2026-10-01T12:00:00.000Z");

section("A schedule's months, to the paisa");
const thirds = spreadEvenly(100, 3);
ok("₹100 over 3: 33.33, 33.33, 33.34 — the last takes the rounding", thirds.join(",") === "33.33,33.33,33.34");
ok("₹200 over 3: 66.66, 66.66, 66.68", spreadEvenly(200, 3).join(",") === "66.66,66.66,66.68");
let exact = true;
let negative = false;
for (const amount of [0.01, 0.9, 1, 99.99, 12000, 123456.78, 1e9]) {
  for (const n of [1, 2, 7, 12, 59, 60]) {
    const parts = spreadEvenly(amount, n);
    if (sum(parts) !== Math.round(amount * 100) / 100) exact = false;
    if (parts.some((p) => p < 0)) negative = true;
  }
}
ok("every spread sums exactly to its amount (7 amounts × 6 lengths)", exact);
ok("  and no month is ever negative — ₹0.90 over 60 months included", !negative, spreadEvenly(0.9, 60).slice(-2).join(","));
const plan = planLines(12000, month("2026-04"), 12);
ok("₹12,000 over 12 months from April 2026: ₹1,000 a month, April to March", plan.length === 12 && plan.every((l) => l.amount === 1000) && monthKeyOf(plan[11]!.month) === "2027-03");
const posted3 = plan.slice(0, 3).map((l) => ({ month: l.month, amount: l.amount }));
const grown = replanUnposted({ amount: 13200, startMonth: month("2026-04"), months: 12, posted: posted3 });
ok(
  "raised to ₹13,200 with 3 months posted: the other 9 share ₹10,200 (1,133.33 × 8 + 1,133.36)",
  grown.ok && grown.lines.length === 9 && grown.lines[0]!.amount === 1133.33 && grown.lines[8]!.amount === 1133.36 && sum(grown.lines.map((l) => l.amount)) === 10200,
);
ok("  posted months are never in the new plan", grown.ok && !grown.lines.some((l) => posted3.some((p) => p.month.getTime() === l.month.getTime())));
const shrunk = replanUnposted({ amount: 12000, startMonth: month("2026-04"), months: 2, posted: posted3 });
ok("shortened below the months already posted: refused", !shrunk.ok, shrunk.ok ? "" : shrunk.error);
const under = replanUnposted({ amount: 2500, startMonth: month("2026-04"), months: 12, posted: posted3 });
ok("an amount below what is already posted: refused", !under.ok, under.ok ? "" : under.error);
const done = replanUnposted({ amount: 3000, startMonth: month("2026-04"), months: 3, posted: posted3 });
ok("exactly what is posted, over exactly the posted months: nothing left to plan", done.ok && done.lines.length === 0);

section("Flux: flagged at both thresholds");
const t = { percent: 20, amount: 25000 };
ok("₹1,25,000 → ₹1,50,000: +₹25,000 and +20% — both met exactly, flagged", fluxFigures({ accountId: "a", type: "EXPENSE", current: 150000, previous: 125000, lastYear: 0 }, t).flagged);
ok("₹1,25,100 → ₹1,50,100: +₹25,000 but 19.98% — under the percentage, not flagged", !fluxFigures({ accountId: "a", type: "EXPENSE", current: 150100, previous: 125100, lastYear: 0 }, t).flagged);
ok("₹1,24,999.95 → ₹1,49,999.94: 19.99996% is not rounded up to 20%", !fluxFigures({ accountId: "a", type: "EXPENSE", current: 149999.94, previous: 124999.95, lastYear: 0 }, t).flagged);
ok("₹1,00,000 → ₹1,24,999.99: +25% but ₹0.01 under the amount — not flagged", !isFlagged(24999.99, 100000, t));
ok("₹10,00,000 → ₹11,50,000: ₹1.5 lakh but 15% — not flagged", !fluxFigures({ accountId: "a", type: "EXPENSE", current: 1150000, previous: 1000000, lastYear: 0 }, t).flagged);
ok("from nothing to ₹30,000: the percentage is infinite, the amount decides — flagged", fluxFigures({ accountId: "a", type: "INCOME", current: 30000, previous: 0, lastYear: 0 }, t).flagged && percentChange(0, 30000) === null);
ok("a fall counts the same as a rise: ₹1,50,000 → ₹1,00,000 is flagged", fluxFigures({ accountId: "a", type: "EXPENSE", current: 100000, previous: 150000, lastYear: 0 }, t).flagged);
ok("no change is never flagged, even with a 0 threshold", !isFlagged(0, 100, { percent: 0, amount: 0 }));
ok("natural balances: an asset and an expense read debit − credit, the rest credit − debit", naturalBalance("ASSET", 100, 30) === 70 && naturalBalance("LIABILITY", 30, 100) === 70 && naturalBalance("INCOME", 0, 5) === 5);
const vsYear = fluxFigures({ accountId: "a", type: "EXPENSE", current: 120, previous: 100, lastYear: 80 }, t);
ok("the change against last year is worked out too: +40, +50%", vsYear.changeYear === 40 && vsYear.changeYearPct === 50 && vsYear.changePrevPct === 20);

section("The catalogue");
ok("fourteen default tasks", DEFAULT_TEMPLATES.length === 14);
ok("  eleven with an automatic check — one for every key the engine knows", DEFAULT_TEMPLATES.filter((d) => d.autoCheck).length === 11 && AUTO_CHECK_KEYS.every((k) => DEFAULT_TEMPLATES.some((d) => d.autoCheck === k)));
ok("  three by hand, each with the page it is done on", DEFAULT_TEMPLATES.filter((d) => !d.autoCheck).every((d) => !!d.href && taskHref({ autoCheck: null, title: d.title }) === d.href));

section("The pure checks");
const jun = month("2025-06");
const bank = checkBankReconciled({
  month: jun,
  accounts: [
    { id: "b1", name: "HDFC", reconciliations: [{ statementDate: new Date(Date.UTC(2025, 5, 30)), difference: 0 }], latest: null },
    { id: "b2", name: "ICICI", reconciliations: [{ statementDate: new Date(Date.UTC(2025, 5, 30)), difference: 12.5 }], latest: null },
    { id: "b3", name: "SBI", reconciliations: [], latest: { statementDate: new Date(Date.UTC(2025, 4, 31)), difference: 0 } },
  ],
});
ok("bank: reconciled to the month end with no difference passes; a difference or an earlier date fails", !bank.ok && bank.detail.items.map((i) => i.id).join(",") === "b2,b3", bank.detail.summary);
ok("  and says why", bank.detail.items[0]!.note!.includes("difference") && bank.detail.items[1]!.note === "Last reconciled to 2025-05-31");
ok("  no bank accounts at all passes", checkBankReconciled({ month: jun, accounts: [] }).ok);
ok("invoices: a draft fails, none passes", !checkInvoicesIssued({ month: jun, drafts: [{ id: "d", docNumber: "INV-1", companyName: "Acme", total: 100, currency: "INR" }] }).ok && checkInvoicesIssued({ month: jun, drafts: [] }).ok);
ok("revenue: nothing at all passes trivially", checkRevenueRecognised({ month: jun, unposted: [], milestones: [], pending: [] }).ok);
const rev = checkRevenueRecognised({
  month: jun,
  unposted: [{ scheduleId: "s1", label: "INV-9", month: jun, amount: 10191.78 }, { scheduleId: "s1", label: "INV-9", month: month("2025-05"), amount: 10000 }],
  milestones: [],
  pending: [{ scheduleId: "s2", label: "INV-10", amount: 5000, startDate: new Date(Date.UTC(2025, 5, 1)) }],
});
ok("  an unposted month and a pending approval fail, one row per schedule", !rev.ok && rev.detail.items.length === 2 && rev.detail.numbers.unpostedAmount === 20191.78, rev.detail.summary);
ok("schedules: an unposted month or an unreversed accrual fails", !checkSchedulesPosted({ month: jun, unposted: [], reversals: [{ scheduleId: "a", label: "Audit", month: month("2025-05"), amount: 1 }], reclass: [] }).ok);
const dep = checkDepreciationRun({
  month: jun,
  assets: [
    {
      id: "a1", tag: "FA-1", name: "Laptop", cost: 36000, salvageValue: 0, usefulLifeYears: 3, method: "STRAIGHT_LINE", ratePercent: null,
      purchasedOn: new Date(Date.UTC(2025, 3, 10)), disposedOn: null,
      charges: [{ toDate: new Date(Date.UTC(2025, 3, 30)), amount: 1000 }, { toDate: new Date(Date.UTC(2025, 4, 31)), amount: 1000 }],
    },
    {
      id: "a2", tag: "FA-2", name: "Printer", cost: 12000, salvageValue: 0, usefulLifeYears: 1, method: "STRAIGHT_LINE", ratePercent: null,
      purchasedOn: new Date(Date.UTC(2025, 6, 2)), disposedOn: null, charges: [],
    },
  ],
});
ok("depreciation: an asset due June's ₹1,000 without a charge fails; one bought in July isn't due", !dep.ok && dep.detail.items.length === 1 && dep.detail.items[0]!.amount === 1000);
ok("payroll: not in use passes", checkPayrollPosted({ month: jun, inUse: false, run: null }).ok && checkPayrollPosted({ month: jun, inUse: false, run: null }).detail.summary === "Payroll isn't in use.");
ok("  no run, a draft run, or a locked unposted run fails; locked and posted passes", [
  checkPayrollPosted({ month: jun, inUse: true, run: null }).ok,
  checkPayrollPosted({ month: jun, inUse: true, run: { id: "r", status: "DRAFT", posted: false } }).ok,
  checkPayrollPosted({ month: jun, inUse: true, run: { id: "r", status: "LOCKED", posted: false } }).ok,
  checkPayrollPosted({ month: jun, inUse: true, run: { id: "r", status: "LOCKED", posted: true } }).ok,
].join(",") === "false,false,false,true");
ok("flux: a flagged row without a note fails; with one passes", !checkFluxExplained({ month: jun, rows: [{ accountId: "x", code: "5", name: "Rent", changePrev: 30000, flagged: true, explained: false }] }).ok && checkFluxExplained({ month: jun, rows: [{ accountId: "x", code: "5", name: "Rent", changePrev: 30000, flagged: true, explained: true }] }).ok);

section("The receivables tie-out, by hand");
const docBase = { companyId: "c", companyName: "Acme", posted: 0, hasEntry: true, entryNumbers: ["JV/1"], credited: 0, applied: 0, allocated: 0 };
const inv: TieOutDocument = { ...docBase, id: "i1", docNumber: "INV-1", docType: "INVOICE", currency: "INR", rate: 1, total: 11800, allocated: 5000, credited: 1180, posted: 11800 };
const usd: TieOutDocument = { ...docBase, id: "i2", docNumber: "INV-2", docType: "INVOICE", currency: "USD", rate: 83.47, total: 118.44, allocated: 50, posted: 9886.19 };
const cn: TieOutDocument = { ...docBase, id: "c1", docNumber: "CN-1", docType: "CREDIT_NOTE", currency: "INR", rate: 1, total: 1180, applied: 1180, posted: -1180 };
const payments = [
  { id: "p1", label: "Payment #1", companyId: "c", companyName: "Acme", currency: "INR", rate: 1, amount: 5000, applied: 5000 },
  { id: "p2", label: "Payment #2", companyId: "c", companyName: "Acme", currency: "INR", rate: 1, amount: 2000, applied: 0 },
  { id: "p3", label: "Payment #3", companyId: "c", companyName: "Acme", currency: "USD", rate: 85, amount: 50, applied: 50 },
];
// Ledger: +11,800 +9,886.19 −5,000 −2,000 −4,250 (the $50 at 85) +76.50 (FX: 4,250 − 4,173.50) −1,180 = 9,332.69.
const base = { side: "AR" as const, month: jun, documents: [inv, usd, cn], payments, manualInMonth: [], manualBefore: { count: 0, amount: 0 }, partyless: { count: 0, amount: 0, items: [] }, orphanPayments: { count: 0, amount: 0, items: [] } };
const tied = tieOut({ ...base, ledger: 9332.69 });
ok("INR invoice 5,620 open + USD invoice 5,712.69 open (at 83.47) − 2,000 on account = 9,332.69 = the ledger", tied.ok && tied.detail.ageing === 9332.69 && tied.detail.difference === 0, tied.detail.summary);
ok("  nothing is floored: the credit note fully applied adds 0, the unapplied receipt −2,000", tied.detail.breakdown.creditNotes === 0 && tied.detail.breakdown.unappliedPayments === -2000);
ok("  the unapplied receipt is listed among the causes even when it ties", tied.detail.causes.unappliedPayments.count === 1 && tied.detail.causes.unappliedPayments.items[0]!.id === "p2");
const manual = { id: "e9", entryNumber: "JV/2025-26/0099", date: ist("2025-06-30T17:30:00"), narration: "Write-back", amount: 1000 };
const off = tieOut({ ...base, ledger: 10332.69, manualInMonth: [manual] });
ok("a manual journal of ₹1,000 on AR: ₹1,000 apart, failing, and it is named", !off.ok && off.detail.difference === -1000 && off.detail.items.some((i) => i.id === "e9"), off.detail.summary);
ok("  within ₹1 still ties (₹0.99)", tieOut({ ...base, ledger: 9333.68 }).ok && !tieOut({ ...base, ledger: 9333.70 }).ok);
const wrong = tieOut({ ...base, documents: [inv, { ...usd, posted: 118.44 }, cn], ledger: 9332.69 - 9886.19 + 118.44 });
ok("a USD invoice booked at 1 is a document whose entry disagrees with its total", !wrong.ok && wrong.detail.causes.mismatchedDocuments.items[0]?.id === "i2" && wrong.detail.causes.mismatchedDocuments.amount === -9767.75, wrong.detail.causes.mismatchedDocuments.items[0]?.note);
const overpaid = tieOut({ ...base, documents: [{ ...inv, allocated: 12000, credited: 0 }], payments: [{ ...payments[0]!, amount: 12000, applied: 12000 }], ledger: -200 });
ok("an overpaid invoice counts as −200, not 0", overpaid.ok && overpaid.detail.ageing === -200);

console.log(failures === 0 ? `\nAll ${passes} close-core checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
process.exit(failures === 0 ? 0 : 1);

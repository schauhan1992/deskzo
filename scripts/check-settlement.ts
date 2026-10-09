/**
 * Checks the full-and-final engine against hand-worked cases.
 *
 * Gratuity and bonus are statutory, so a wrong divisor or a missed ceiling is not a rounding
 * difference — it is underpaying somebody what an Act entitles them to, or overpaying by double.
 * Each case below states the figure and where it comes from.
 *
 *   npm run check:settlement
 */
import {
  computeEncashment,
  computeGratuity,
  computeNotice,
  computeSettlement,
  computeStatutoryBonus,
  finalMonthDays,
  serviceYears,
} from "../src/lib/hr/settlement";

let failures = 0;
function eq(label: string, actual: number, expected: number, why: string) {
  const ok = Math.abs(actual - expected) < 0.51;
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}: ${actual}${ok ? "" : ` (expected ${expected})`} — ${why}`);
  if (!ok) failures += 1;
}
function truthy(label: string, ok: boolean, why: string) {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label} — ${why}`);
  if (!ok) failures += 1;
}
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

console.log("\n— Completed years, as the Gratuity Act counts them —");
{
  eq("exactly 5 years", serviceYears(d("2021-04-01"), d("2026-04-01")), 5, "anniversary reached");
  eq("4 years 11 months", serviceYears(d("2021-05-01"), d("2026-04-01")), 5, "11 months rounds up");
  eq("4 years 7 months", serviceYears(d("2021-09-01"), d("2026-04-01")), 5, "over six months rounds up");
  eq("4 years 6 months", serviceYears(d("2021-10-01"), d("2026-04-01")), 4, "exactly six does NOT round up");
  eq("4 years 3 months", serviceYears(d("2022-01-01"), d("2026-04-01")), 4, "under six months is dropped");
  eq("leaving before joining", serviceYears(d("2026-04-01"), d("2025-04-01")), 0, "nonsense input is zero, not negative");
}

console.log("\n— Gratuity —");
{
  const short = computeGratuity(30000, d("2023-01-01"), d("2026-04-01"));
  truthy("3 years is not eligible", !short.eligible, short.note);
  eq("...and pays nothing", short.amount, 0, "the Act requires five");

  // 30,000 basic, 6 completed years: 30000 × 15 × 6 / 26
  const six = computeGratuity(30000, d("2020-04-01"), d("2026-04-01"));
  truthy("6 years is eligible", six.eligible, six.note);
  eq("gratuity on 30,000 basic", six.amount, 103846.15, "30000 × 15 × 6 ÷ 26");

  // The divisor is the thing most often got wrong — 30 instead of 26 understates it.
  const wrongDivisor = (30000 * 15 * 6) / 30;
  truthy("the 26-day divisor is used, not 30", Math.abs(six.amount - wrongDivisor) > 1, `26 gives ${six.amount}, 30 would give ${wrongDivisor}`);

  // And it is on basic, not gross — using a gross of 60,000 would double it.
  const onGross = computeGratuity(60000, d("2020-04-01"), d("2026-04-01"));
  eq("on gross it would be double", onGross.amount, 207692.31, "which is why the input must be basic");

  const capped = computeGratuity(500000, d("2000-04-01"), d("2026-04-01"));
  eq("capped at the statutory ceiling", capped.amount, 2000000, "₹20,00,000 lifetime cap");
  truthy("...and says so", capped.note.includes("capped"), capped.note);
}

console.log("\n— Leave encashment —");
{
  const result = computeEncashment(26000, [
    { code: "EL", name: "Earned leave", days: 12, encashable: true },
    { code: "CL", name: "Casual leave", days: 5, encashable: false },
    { code: "SL", name: "Sick leave", days: 3, encashable: false },
  ]);
  eq("per-day rate", result.perDay, 1000, "26,000 basic ÷ 26");
  eq("days encashed", result.days, 12, "only the earned leave");
  eq("amount", result.amount, 12000, "12 days × 1,000");
  truthy("the excluded types are named", result.excluded.length === 2, result.excluded.join(", "));
  truthy("...so 'why wasn't my SL paid' has an answer", result.excluded.some((e) => e.includes("SL")), "listed explicitly");

  const none = computeEncashment(26000, [{ code: "CL", name: "Casual", days: 9, encashable: false }]);
  eq("nothing encashable pays nothing", none.amount, 0, "casual leave lapses");
}

console.log("\n— Notice period —");
{
  const full = computeNotice(60000, 30, d("2026-03-01"), d("2026-03-31"));
  eq("30 days served against 30 required", full.shortfallDays, 0, "full notice");
  eq("...nothing recovered", full.recovery, 0, full.note);

  const short = computeNotice(60000, 60, d("2026-03-01"), d("2026-03-21"));
  eq("20 served against 60 required", short.shortfallDays, 40, "40 days short");
  eq("recovery at daily gross", short.recovery, 80000, "40 × 60,000 ÷ 30");

  const walked = computeNotice(30000, 30, d("2026-03-20"), d("2026-03-20"));
  eq("left the same day", walked.shortfallDays, 30, "no notice at all");
  eq("...recovers a full month", walked.recovery, 30000, "30 × 30,000 ÷ 30");
}

console.log("\n— Statutory bonus —");
{
  const high = computeStatutoryBonus(30000, 12);
  truthy("above the 21,000 threshold is not eligible", !high.eligible, high.note);

  const low = computeStatutoryBonus(18000, 12);
  truthy("18,000 basic is eligible", low.eligible, low.note);
  eq("calculated on the 7,000 ceiling", low.amount, 6997.2, "8.33% of 7,000 × 12 — NOT of 18,000");

  const wrongBase = 18000 * 0.0833 * 12;
  truthy("the calculation ceiling is applied", Math.abs(low.amount - wrongBase) > 1, `7,000 base gives ${low.amount}, 18,000 would give ${Math.round(wrongBase)}`);

  const partial = computeStatutoryBonus(6000, 5);
  eq("below the ceiling uses actual wage", partial.amount, 2499.0, "8.33% of 6,000 × 5 months");
}

console.log("\n— A whole settlement —");
{
  const result = computeSettlement({
    monthlyBasic: 30000,
    monthlyGross: 60000,
    joinedOn: d("2019-06-01"),
    resignedOn: d("2026-03-01"),
    lastWorkingDay: d("2026-03-31"),
    noticePeriodDays: 30,
    salaryDays: 31,
    daysInFinalMonth: 31,
    balances: [
      { code: "EL", name: "Earned", days: 15, encashable: true },
      { code: "CL", name: "Casual", days: 4, encashable: false },
    ],
    incomeTax: 5000,
  });

  eq("service years", result.serviceYears, 7, "June 2019 to March 2026 is 6y10m, rounds to 7");
  eq("final month salary", result.salaryAmount, 60000, "full month worked");
  eq("leave encashed", result.encashment.amount, 17307.69, "15 days × 30,000 ÷ 26");
  eq("gratuity", result.gratuity.amount, 121153.85, "30000 × 15 × 7 ÷ 26");
  eq("notice recovery", result.notice.recovery, 0, "full notice served");
  eq("gross payable", result.grossPayable, 198461.54, "salary + encashment + gratuity");
  eq("deductions", result.totalDeductions, 5000, "income tax only");
  eq("net payable", result.netPayable, 193461.54, "gross less deductions");
}

console.log("\n— When the employee owes the company —");
{
  const result = computeSettlement({
    monthlyBasic: 20000,
    monthlyGross: 40000,
    joinedOn: d("2024-01-01"),
    resignedOn: d("2026-03-25"),
    lastWorkingDay: d("2026-03-31"),
    noticePeriodDays: 60,
    salaryDays: 31,
    daysInFinalMonth: 31,
    balances: [],
    advanceRecovery: 50000,
  });

  eq("no gratuity under five years", result.gratuity.amount, 0, "2 years of service");
  eq("notice shortfall", result.notice.shortfallDays, 54, "6 of 60 days served");
  eq("gross payable", result.grossPayable, 40000, "one month's salary");
  truthy("net is NEGATIVE", result.netPayable < 0, `₹${result.netPayable} — the employee owes the company`);
  truthy(
    "...and that is called out",
    result.warnings.some((w) => w.includes("owes")),
    result.warnings.find((w) => w.includes("owes")) ?? "",
  );
}

console.log("\n— Warnings —");
{
  const nearMiss = computeSettlement({
    monthlyBasic: 25000,
    monthlyGross: 50000,
    // 4 years 3 months — under six, so it stays at 4 and misses gratuity by one year.
    joinedOn: d("2022-01-01"),
    resignedOn: d("2026-03-01"),
    lastWorkingDay: d("2026-03-31"),
    noticePeriodDays: 30,
    salaryDays: 31,
    daysInFinalMonth: 31,
    balances: [{ code: "SL", name: "Sick", days: 6, encashable: false }],
    incomeTax: 1000,
  });
  truthy(
    "4 years is flagged as just short of gratuity",
    nearMiss.warnings.some((w) => w.includes("just short")),
    "worth checking the joining date before it goes out",
  );
  truthy(
    "non-encashable balances are named",
    nearMiss.warnings.some((w) => w.includes("SL")),
    "so the employee gets an answer, not a silence",
  );
}

console.log("\n— The last month is paid once —");
{
  // Last working day 25 September: 25 days employed in the month.
  const alone = finalMonthDays({ employedDays: 25, lopDays: 0, paidOnPayslip: null });
  eq("no payslip for September: the settlement pays the 25 days", alone.salaryDays, 25, "nothing else has paid them");

  const covered = finalMonthDays({ employedDays: 25, lopDays: 0, paidOnPayslip: 25 });
  eq("September's payslip paid the 25 days", covered.salaryDays, 0, "so the settlement pays none of them again");
  eq("...and says how many it found", covered.onPayslip, 25, "for the note on the statement");

  const withLop = finalMonthDays({ employedDays: 25, lopDays: 2, paidOnPayslip: null });
  eq("2 days' loss of pay, no payslip", withLop.salaryDays, 23, "25 employed, less 2");

  const lockedFull = finalMonthDays({ employedDays: 25, lopDays: 0, paidOnPayslip: 30 });
  eq("September locked at a full month before the exit was recorded", lockedFull.salaryDays, 0, "nothing more is owed");
  eq("...5 days overpaid, reported", lockedFull.overpaidDays, 5, "30 paid, 25 owed — recovering it is a decision");

  const partial = finalMonthDays({ employedDays: 25, lopDays: 0, paidOnPayslip: 20 });
  eq("a payslip that paid 20 of the 25", partial.salaryDays, 5, "the settlement pays the other 5");
  eq("...and nothing overpaid", partial.overpaidDays, 0, "");

  const joinedAndLeft = finalMonthDays({ employedDays: 16, lopDays: 0, paidOnPayslip: null });
  eq("joined the 5th and left the 20th", joinedAndLeft.salaryDays, 16, "not the 20 a count from the 1st would pay");
}

console.log(failures === 0 ? "\nAll settlement checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);

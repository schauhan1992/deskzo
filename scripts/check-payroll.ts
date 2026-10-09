/**
 * Checks the payroll engine against hand-worked Indian cases.
 *
 * Payroll is wrong more often than it is noticed — a PF ceiling ignored, an ESI threshold applied
 * the wrong side of the line, loss of pay docked from the net instead of the gross. Each case below
 * states the expected figure and where it comes from, so a change that breaks one is visible.
 *
 *   npm run check:payroll
 */
import {
  computeEsi,
  computePf,
  computePayslip,
  computeProfessionalTax,
  countLeaveDaysProbe,
  employmentInMonth,
} from "./payroll-cases";

let failures = 0;
function eq(label: string, actual: number, expected: number, why: string) {
  const ok = Math.abs(actual - expected) < 0.01;
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}: ${actual} ${ok ? "" : `(expected ${expected}) `}— ${why}`);
  if (!ok) failures += 1;
}
function truthy(label: string, ok: boolean, why: string) {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label} — ${why}`);
  if (!ok) failures += 1;
}

console.log("\n— Provident fund —");
{
  // June 2026: before the ceiling rose, so ₹15,000.
  const june = { year: 2026, month: 6 };
  const below = computePf(12000, { applicable: true, period: june });
  eq("basic 12,000, employee", below.employee, 1440, "12% of 12,000, under the 15,000 ceiling");
  eq("basic 12,000, EPS", below.eps, 1000, "8.33% of 12,000 = 999.6, rounded");

  const above = computePf(50000, { applicable: true, period: june });
  eq("basic 50,000, employee", above.employee, 1800, "capped at 12% of the 15,000 ceiling");
  eq("basic 50,000, EPS", above.eps, 1250, "8.33% of 15,000, always on the capped wage");
  eq("basic 50,000, EPF share", above.epf, 550, "employer 1,800 less 1,250 to pension");

  const full = computePf(50000, { applicable: true, onFullBasic: true, period: june });
  eq("employer contributing on full basic", full.employee, 6000, "12% of the whole 50,000");
  eq("...with EPS still capped", full.eps, 1250, "pension share never exceeds the ceiling");

  eq("not applicable", computePf(50000, { applicable: false }).employee, 0, "consultant, PF off");
}

console.log("\n— The ₹25,000 ceiling from 17 Sep 2026 (EPFO FAQ, S.O. 5109(E)) —");
{
  const oct = { year: 2026, month: 10 };
  const at20 = computePf(20000, { applicable: true, period: oct });
  eq("October, basic 20,000, employee", at20.employee, 2400, "FAQ Q13: 12% of the whole 20,000, now under the ceiling");
  eq("...EPS", at20.eps, 1666, "FAQ Q13: 8.33% of 20,000");
  eq("...EPF share", at20.epf, 734, "FAQ Q13: 2,400 less 1,666");

  const at25 = computePf(25000, { applicable: true, period: oct });
  eq("October, basic 25,000, employee", at25.employee, 3000, "FAQ Q13: 12% of 25,000");
  eq("...EPS", at25.eps, 2083, "FAQ Q13: 8.33% of 25,000 = 2,082.50, rounded");
  eq("...EPF share", at25.epf, 917, "FAQ Q13: 3,000 less 2,083");

  const at35 = computePf(35000, { applicable: true, period: oct });
  eq("October, basic 35,000, PF wages", at35.wages, 25000, "capped at the new ceiling");
  eq("...employee", at35.employee, 3000, "12% of 25,000, not of 35,000");

  const sep = { year: 2026, month: 9 };
  const split = computePf(20000, { applicable: true, period: sep });
  eq("September, basic 20,000, PF wages", split.wages, 17333.33, "FAQ Q7: 15,000 × 16/30 + 20,000 × 14/30");
  eq("...employee", split.employee, 2080, "12% of 17,333.33 = 2,080.00");
  eq("...EPS", split.eps, 1444, "FAQ Q13 scenario C: 8.33% of 17,333.33 = 1,443.87, rounded");
  eq("September, basic 12,000, PF wages", computePf(12000, { applicable: true, period: sep }).wages, 12000, "under both ceilings, so the split changes nothing");
  const fullSplit = computePf(50000, { applicable: true, onFullBasic: true, period: sep });
  eq("September, full basic 50,000, employee", fullSplit.employee, 6000, "on the full basic, the ceiling doesn't limit PF");
  eq("...EPS on the split ceiling", fullSplit.eps, 1638, "8.33% of 15,000 × 16/30 + 25,000 × 14/30 = 19,666.67");

  const aug = computePf(20000, { applicable: true, period: { year: 2026, month: 8 } });
  eq("August, basic 20,000, employee", aug.employee, 1800, "before the change: capped at 15,000");
  eq("...EPS", aug.eps, 1250, "8.33% of 15,000");
  eq("...EPF share", aug.epf, 550, "1,800 less 1,250");

  eq("undated (planning a structure)", computePf(50000, { applicable: true }).wages, 25000, "the newest ceiling");

  const flags = { pfApplicable: false, esiApplicable: false, ptApplicable: false };
  const comps = (basic: number) => ({ basic, hra: 0, conveyance: 0, medical: 0, specialAllowance: 0, otherAllowance: 0 });
  const slip = (basic: number, month: number) =>
    computePayslip({ components: comps(basic), flags, monthDays: 30, lopDays: 0, state: "Delhi", month, year: 2026, incomeTax: 1 });
  const flagged = (basic: number, month: number) => slip(basic, month).warnings.some((w) => w.includes("PF wage ceiling"));
  truthy("PF off, basic 20,000 in October is flagged", flagged(20000, 10), "newly within the ceiling, so enrolment is compulsory");
  truthy("...and in September", flagged(20000, 9), "the ceiling rose on the 17th");
  truthy("...but not in August", !flagged(20000, 8), "above the ₹15,000 ceiling then");
  truthy("PF off, basic 30,000 in October isn't", !flagged(30000, 10), "above the new ceiling too");
  truthy("PF off, basic 12,000 in October isn't", !flagged(12000, 10), "the rise didn't change their position");
  truthy("PF on, basic 20,000 in October isn't", !computePayslip({ components: comps(20000), flags: { ...flags, pfApplicable: true }, monthDays: 30, lopDays: 0, state: "Delhi", month: 10, year: 2026, incomeTax: 1 }).warnings.some((w) => w.includes("PF wage ceiling")), "already enrolled");
  eq("PF on, basic 20,000 in October, deducted", computePayslip({ components: comps(20000), flags: { ...flags, pfApplicable: true }, monthDays: 30, lopDays: 0, state: "Delhi", month: 10, year: 2026, incomeTax: 1 }).pfEmployee, 2400, "the payslip uses the October ceiling");
}

console.log("\n— Employees' State Insurance —");
{
  const inside = computeEsi(20000, { applicable: true });
  eq("gross 20,000, employee", inside.employee, 150, "0.75%, rounded up");
  eq("gross 20,000, employer", inside.employer, 650, "3.25%, rounded up");

  const atLimit = computeEsi(21000, { applicable: true });
  truthy("gross exactly 21,000 is still covered", atLimit.applied, "the limit is inclusive");

  const outside = computeEsi(21001, { applicable: true });
  truthy("gross 21,001 is not", !outside.applied, "one rupee over the limit");
  eq("...and deducts nothing", outside.employee, 0, "no contribution above the limit");
}

console.log("\n— Professional tax —");
{
  eq("Maharashtra, 30,000, June", computeProfessionalTax(30000, "Maharashtra", 6, { applicable: true }).amount, 200, "top slab");
  eq("Maharashtra, 30,000, February", computeProfessionalTax(30000, "Maharashtra", 2, { applicable: true }).amount, 300, "the February top-up that makes the year 2,500");
  eq("Maharashtra, 8,000", computeProfessionalTax(8000, "Maharashtra", 6, { applicable: true }).amount, 175, "middle slab");
  eq("Maharashtra, 7,000", computeProfessionalTax(7000, "Maharashtra", 6, { applicable: true }).amount, 0, "below the threshold");
  eq("Karnataka, 30,000", computeProfessionalTax(30000, "Karnataka", 6, { applicable: true }).amount, 200, "flat above 25,000");
  eq("Karnataka, 20,000", computeProfessionalTax(20000, "Karnataka", 6, { applicable: true }).amount, 0, "below 25,000");
  eq("Delhi, 100,000", computeProfessionalTax(100000, "Delhi", 6, { applicable: true }).amount, 0, "Delhi levies none");

  const unknown = computeProfessionalTax(50000, "Assam", 6, { applicable: true });
  truthy("an unlisted state is flagged, not guessed", !unknown.known, "returns zero and says it does not know");
}

console.log("\n— A full payslip —");
{
  const slip = computePayslip({
    components: { basic: 40000, hra: 20000, conveyance: 1600, medical: 1250, specialAllowance: 17150, otherAllowance: 0 },
    flags: { pfApplicable: true, esiApplicable: true, ptApplicable: true },
    monthDays: 30,
    lopDays: 0,
    state: "Maharashtra",
    month: 6,
    year: 2026,
    incomeTax: 5000,
  });
  eq("gross", slip.grossEarnings, 80000, "sum of the components");
  eq("PF employee", slip.pfEmployee, 1800, "capped at the ceiling");
  eq("ESI", slip.esiEmployee, 0, "gross is far above the ESI limit");
  eq("professional tax", slip.professionalTax, 200, "Maharashtra top slab");
  eq("total deductions", slip.totalDeductions, 7000, "1,800 PF + 200 PT + 5,000 tax");
  eq("net pay", slip.netPay, 73000, "80,000 less 7,000");
  eq("employer cost", slip.employerCost, 81800, "gross plus the employer's 1,800 PF");
}

console.log("\n— Loss of pay pro-rates the gross, not the net —");
{
  const base = { basic: 30000, hra: 15000, conveyance: 0, medical: 0, specialAllowance: 5000, otherAllowance: 0 };
  const flags = { pfApplicable: true, esiApplicable: true, ptApplicable: true };

  const clean = computePayslip({ components: base, flags, monthDays: 30, lopDays: 0, state: "Karnataka", month: 6, year: 2026 });
  const withLop = computePayslip({ components: base, flags, monthDays: 30, lopDays: 3, state: "Karnataka", month: 6, year: 2026 });

  eq("gross without LOP", clean.grossEarnings, 50000, "full month");
  eq("gross with 3 days LOP", withLop.grossEarnings, 45000, "27/30 of 50,000");
  eq("basic with 3 days LOP", withLop.components.basic, 27000, "27/30 of 30,000");
  eq("PF on the reduced basic", withLop.pfEmployee, 1800, "27,000 is still above the 15,000 ceiling");
  eq("paid days", withLop.paidDays, 27, "30 less 3");

  const lowPaid = computePayslip({
    components: { basic: 12000, hra: 5000, conveyance: 0, medical: 0, specialAllowance: 1000, otherAllowance: 0 },
    flags,
    monthDays: 30,
    lopDays: 6,
    state: "Karnataka",
    month: 6,
    year: 2026,
  });
  eq("low earner, basic after 6 days LOP", lowPaid.components.basic, 9600, "24/30 of 12,000");
  eq("...PF follows the reduced basic", lowPaid.pfEmployee, 1152, "12% of 9,600, below the ceiling");
  eq("...ESI applies to the reduced gross", lowPaid.esiEmployee, 108, "0.75% of the reduced 14,400 gross");
  truthy("...ESI genuinely applied", lowPaid.esiEmployee > 0, "gross fell below the 21,000 limit");
}

console.log("\n— Warnings —");
{
  const slip = computePayslip({
    components: { basic: 10000, hra: 4000, conveyance: 0, medical: 0, specialAllowance: 1000, otherAllowance: 0 },
    flags: { pfApplicable: true, esiApplicable: true, ptApplicable: true },
    monthDays: 31,
    lopDays: 2,
    state: null,
    month: 7,
    year: 2026,
  });
  truthy("missing work state is flagged", slip.warnings.some((w) => w.includes("work state")), "PT could not be computed");
  truthy("no income tax is flagged", slip.warnings.some((w) => w.includes("income tax")), "TDS is entered, not computed");
  truthy("loss of pay is explained", slip.warnings.some((w) => w.includes("loss of pay")), "so the smaller gross is not a surprise");
}

console.log("\n— Incentives on a payslip —");
{
  const base = { basic: 30000, hra: 15000, conveyance: 0, medical: 0, specialAllowance: 5000, otherAllowance: 0 };
  const flags = { pfApplicable: true, esiApplicable: true, ptApplicable: true };

  const withIncentive = computePayslip({
    components: base, flags, monthDays: 30, lopDays: 0, state: "Karnataka", month: 6, year: 2026, incentive: 20000,
  });
  eq("incentive lands on the payslip", withIncentive.incentive, 20000, "the full amount earned");
  eq("...and is part of the gross", withIncentive.grossEarnings, 70000, "50,000 of salary plus 20,000 earned");
  eq("...but PF is untouched", withIncentive.pfEmployee, 1800, "PF is on basic, which an incentive never touches");

  // The rule worth checking: pay for time is pro-rated, pay for result is not.
  const lopped = computePayslip({
    components: base, flags, monthDays: 30, lopDays: 3, state: "Karnataka", month: 6, year: 2026, incentive: 20000,
  });
  eq("3 days LOP cuts the salary", lopped.components.basic, 27000, "27/30 of 30,000");
  eq("...but not the incentive", lopped.incentive, 20000, "earned by result, not by attendance");
  eq("...so the gross is 45,000 plus the full 20,000", lopped.grossEarnings, 65000, "salary pro-rated, incentive not");
  truthy(
    "...and the warning says so",
    lopped.warnings.some((w) => w.includes("earned by result")),
    "otherwise the untouched figure looks like a bug",
  );

  // ESI is on gross, so an incentive can push somebody over the limit — and it should.
  const nearLimit = { basic: 11000, hra: 5000, conveyance: 0, medical: 0, specialAllowance: 4000, otherAllowance: 0 };
  const under = computePayslip({ components: nearLimit, flags, monthDays: 30, lopDays: 0, state: "Karnataka", month: 6, year: 2026 });
  const over = computePayslip({
    components: nearLimit, flags, monthDays: 30, lopDays: 0, state: "Karnataka", month: 6, year: 2026, incentive: 3000,
  });
  truthy("ESI applies below the limit", under.esiEmployee > 0, "gross of 20,000 is under 21,000");
  eq("an incentive pushes the gross over", over.grossEarnings, 23000, "20,000 of salary plus 3,000 earned");
  eq("...so ESI stops applying", over.esiEmployee, 0, "the limit is on gross, and an incentive is part of it");

  const negative = computePayslip({
    components: base, flags, monthDays: 30, lopDays: 0, state: "Karnataka", month: 6, year: 2026, incentive: -5000,
  });
  eq("a negative incentive is refused", negative.incentive, 0, "a clawback is a deduction, not a negative earning");

  const none = computePayslip({ components: base, flags, monthDays: 30, lopDays: 0, state: "Karnataka", month: 6, year: 2026 });
  eq("no incentive is zero, not undefined", none.incentive, 0, "so a payslip always has the field");
  eq("...and the gross is unchanged", none.grossEarnings, 50000, "nothing about the old behaviour moved");
}

console.log("\n— Joining and leaving part-way through a month —");
{
  const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
  const span = (e: ReturnType<typeof employmentInMonth>) => (e ? `${e.firstDay}–${e.lastDay}` : "none");
  // October 2026 has 31 days.
  truthy("here all October", span(employmentInMonth(2026, 10, d("2024-05-01"), null)) === "1–31", "joined long before, still here");
  truthy("no dates at all", span(employmentInMonth(2026, 10, null, null)) === "1–31", "paid the whole month, as before");
  truthy("joined 20 October", span(employmentInMonth(2026, 10, d("2026-10-20"), null)) === "20–31", "the 20th to the end, both in");
  truthy("joined 1 October", span(employmentInMonth(2026, 10, d("2026-10-01"), null)) === "1–31", "a whole month");
  truthy("joins 3 November", span(employmentInMonth(2026, 10, d("2026-11-03"), null)) === "none", "not on October's payroll at all");
  truthy("left 10 October", span(employmentInMonth(2026, 10, d("2024-05-01"), d("2026-10-10"))) === "1–10", "to the last working day");
  truthy("left 30 September", span(employmentInMonth(2026, 10, d("2024-05-01"), d("2026-09-30"))) === "none", "gone before October began");
  truthy("joined 5th, left 20th", span(employmentInMonth(2026, 10, d("2026-10-05"), d("2026-10-20"))) === "5–20", "both ends in one month");
  eq("joined 15 February 2027, days", employmentInMonth(2027, 2, d("2027-02-15"), null)?.days ?? 0, 14, "15th to the 28th");

  // Every component in round figures over a 31-day month: 31,000 + 15,500 + 15,500.
  const base = { basic: 31000, hra: 15500, conveyance: 0, medical: 0, specialAllowance: 15500, otherAllowance: 0 };
  const flags = { pfApplicable: true, esiApplicable: false, ptApplicable: false };
  const october = { components: base, flags, monthDays: 31, lopDays: 0, state: "Delhi", month: 10, year: 2026, incomeTax: 1 };

  const joiner = computePayslip({ ...october, employment: { firstDay: 20, lastDay: 31 } });
  eq("joiner on the 20th, paid days", joiner.paidDays, 12, "the 20th to the 31st");
  eq("...loss of pay", joiner.lopDays, 0, "days before joining aren't absence");
  eq("...basic", joiner.components.basic, 12000, "12/31 of 31,000");
  eq("...gross", joiner.grossEarnings, 24000, "12/31 of 62,000 — not a whole month's 62,000");
  eq("...PF on the basic earned", joiner.pfEmployee, 1440, "12% of 12,000, under the October ceiling");
  truthy("...and says why", joiner.warnings.some((w) => w.startsWith("Joined on") && w.includes("paid for 12 of 31 days")), joiner.warnings.join(" | "));

  const joinerLop = computePayslip({ ...october, lopDays: 2, employment: { firstDay: 20, lastDay: 31 } });
  eq("joiner with 2 days loss of pay, paid days", joinerLop.paidDays, 10, "12 employed, less 2");
  eq("...basic", joinerLop.components.basic, 10000, "10/31 of 31,000");

  const tooMuchLop = computePayslip({ ...october, lopDays: 15, employment: { firstDay: 20, lastDay: 31 } });
  eq("more loss of pay than days employed", tooMuchLop.lopDays, 12, "capped at the 12 days they were here");
  eq("...pays nothing, never less", tooMuchLop.grossEarnings, 0, "not a negative salary");

  const leaver = computePayslip({ ...october, employment: { firstDay: 1, lastDay: 10 } });
  eq("leaver on the 10th, gross", leaver.grossEarnings, 20000, "10/31 of 62,000");
  truthy("...and says why", leaver.warnings.some((w) => w.startsWith("Last working day") && w.includes("paid for 10 of 31 days")), leaver.warnings.join(" | "));

  const both = computePayslip({ ...october, employment: { firstDay: 5, lastDay: 20 } });
  eq("joined the 5th, left the 20th, paid days", both.paidDays, 16, "5th to the 20th");
  truthy("...and says both", both.warnings.some((w) => w.startsWith("Joined on") && w.includes("and left on")), both.warnings.join(" | "));

  const whole = computePayslip({ ...october, employment: { firstDay: 1, lastDay: 31 } });
  const plain = computePayslip(october);
  eq("a whole month given as employment", whole.grossEarnings, plain.grossEarnings, "the same as giving none");
  truthy("...with no joining or leaving note", !whole.warnings.some((w) => w.includes("paid for")), "nothing to explain");
}

console.log("\n— Leave day counting —");
countLeaveDaysProbe(eq, truthy);

console.log(failures === 0 ? "\nAll payroll checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);

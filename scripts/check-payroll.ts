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
  const below = computePf(12000, { applicable: true });
  eq("basic 12,000, employee", below.employee, 1440, "12% of 12,000, under the 15,000 ceiling");
  eq("basic 12,000, EPS", below.eps, 1000, "8.33% of 12,000 = 999.6, rounded");

  const above = computePf(50000, { applicable: true });
  eq("basic 50,000, employee", above.employee, 1800, "capped at 12% of the 15,000 ceiling");
  eq("basic 50,000, EPS", above.eps, 1250, "8.33% of 15,000, always on the capped wage");
  eq("basic 50,000, EPF share", above.epf, 550, "employer 1,800 less 1,250 to pension");

  const full = computePf(50000, { applicable: true, onFullBasic: true });
  eq("employer contributing on full basic", full.employee, 6000, "12% of the whole 50,000");
  eq("...with EPS still capped", full.eps, 1250, "pension share never exceeds the ceiling");

  eq("not applicable", computePf(50000, { applicable: false }).employee, 0, "consultant, PF off");
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

  const clean = computePayslip({ components: base, flags, monthDays: 30, lopDays: 0, state: "Karnataka", month: 6 });
  const withLop = computePayslip({ components: base, flags, monthDays: 30, lopDays: 3, state: "Karnataka", month: 6 });

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
    components: base, flags, monthDays: 30, lopDays: 0, state: "Karnataka", month: 6, incentive: 20000,
  });
  eq("incentive lands on the payslip", withIncentive.incentive, 20000, "the full amount earned");
  eq("...and is part of the gross", withIncentive.grossEarnings, 70000, "50,000 of salary plus 20,000 earned");
  eq("...but PF is untouched", withIncentive.pfEmployee, 1800, "PF is on basic, which an incentive never touches");

  // The rule worth checking: pay for time is pro-rated, pay for result is not.
  const lopped = computePayslip({
    components: base, flags, monthDays: 30, lopDays: 3, state: "Karnataka", month: 6, incentive: 20000,
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
  const under = computePayslip({ components: nearLimit, flags, monthDays: 30, lopDays: 0, state: "Karnataka", month: 6 });
  const over = computePayslip({
    components: nearLimit, flags, monthDays: 30, lopDays: 0, state: "Karnataka", month: 6, incentive: 3000,
  });
  truthy("ESI applies below the limit", under.esiEmployee > 0, "gross of 20,000 is under 21,000");
  eq("an incentive pushes the gross over", over.grossEarnings, 23000, "20,000 of salary plus 3,000 earned");
  eq("...so ESI stops applying", over.esiEmployee, 0, "the limit is on gross, and an incentive is part of it");

  const negative = computePayslip({
    components: base, flags, monthDays: 30, lopDays: 0, state: "Karnataka", month: 6, incentive: -5000,
  });
  eq("a negative incentive is refused", negative.incentive, 0, "a clawback is a deduction, not a negative earning");

  const none = computePayslip({ components: base, flags, monthDays: 30, lopDays: 0, state: "Karnataka", month: 6 });
  eq("no incentive is zero, not undefined", none.incentive, 0, "so a payslip always has the field");
  eq("...and the gross is unchanged", none.grossEarnings, 50000, "nothing about the old behaviour moved");
}


console.log("\n— Leave day counting —");
countLeaveDaysProbe(eq, truthy);

console.log(failures === 0 ? "\nAll payroll checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);

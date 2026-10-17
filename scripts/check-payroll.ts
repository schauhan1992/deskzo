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
  PT_STATES,
  employmentInMonth,
  salaryPartsInMonth,
  seniorCitizenIn,
  ageBandIn,
  annualTax,
  monthlyTds,
  monthsLeftInTaxYear,
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
  // The 2026-27 year unless a case says otherwise: June is an ordinary month, February the top-up's.
  const pt = (state: string, monthGross: number, month: number, more: Partial<Parameters<typeof computeProfessionalTax>[0]> = {}) =>
    computeProfessionalTax({ monthGross, state, month, year: month >= 4 ? 2026 : 2027, applicable: true, ...more });

  eq("Maharashtra, 30,000, June", pt("Maharashtra", 30000, 6).amount, 200, "top slab");
  eq("Maharashtra, 30,000, February", pt("Maharashtra", 30000, 2).amount, 300, "the February amount that makes the year 2,500");
  eq("Maharashtra, 8,000", pt("Maharashtra", 8000, 6).amount, 175, "middle slab");
  eq("Maharashtra, 8,000, February", pt("Maharashtra", 8000, 2).amount, 175, "the ₹300 is the top slab's — the old engine charged 275 here");
  eq("Maharashtra, 7,000", pt("Maharashtra", 7000, 6).amount, 0, "below the threshold");

  eq("Maharashtra, a woman on 20,000", pt("Maharashtra", 20000, 6, { gender: "FEMALE" }).amount, 0, "women up to 25,000 pay nothing, from 1 April 2023");
  eq("...on 30,000", pt("Maharashtra", 30000, 6, { gender: "FEMALE" }).amount, 200, "above 25,000, the same 200");
  eq("...on 30,000, February", pt("Maharashtra", 30000, 2, { gender: "FEMALE" }).amount, 300, "and the same February");
  eq("...on 20,000 in June 2022", computeProfessionalTax({ monthGross: 20000, state: "Maharashtra", month: 6, year: 2022, applicable: true, gender: "FEMALE" }).amount, 200, "before the exemption, the general table");
  const noGender = pt("Maharashtra", 20000, 6);
  eq("a man, or nobody recorded, on 20,000", noGender.amount, 200, "the general table");
  truthy("...and with no gender recorded, the payslip says what a woman would pay", noGender.notes.some((n) => n.includes("No gender")), noGender.notes.join(" | "));
  truthy("...but not where the two tables agree", pt("Maharashtra", 30000, 6).notes.length === 0, "30,000 is 200 either way");

  eq("Karnataka, 30,000, June", pt("Karnataka", 30000, 6).amount, 200, "flat above 25,000");
  eq("Karnataka, 30,000, February 2026", pt("Karnataka", 30000, 2, { year: 2026 }).amount, 300, "₹300 in February from 2025-26, so the year is 2,500");
  eq("Karnataka, 30,000, February 2025", pt("Karnataka", 30000, 2, { year: 2025 }).amount, 200, "before that, 200 like any month");
  eq("Karnataka, 20,000", pt("Karnataka", 20000, 6).amount, 0, "below 25,000");

  // Tamil Nadu: ₹50,000 a month is ₹3,00,000 a half-year — the top band, ₹1,250 a half, ₹2,500 a year.
  eq("Tamil Nadu, 50,000, June", pt("Tamil Nadu", 50000, 6).amount, 0, "half-yearly: nothing until the half is out — the old engine charged 690 every month");
  const september = pt("Tamil Nadu", 50000, 9, { halfYearGrossBefore: 250000 });
  eq("Tamil Nadu, 50,000, September", september.amount, 1250, "the half's 3,00,000 is the top band");
  truthy("...and says on what", september.notes.some((n) => n.includes("half-yearly") && n.includes("April to September")), september.notes.join(" | "));
  eq("Tamil Nadu, 50,000, March", pt("Tamil Nadu", 50000, 3, { halfYearGrossBefore: 250000 }).amount, 1250, "the second half's; the year is 2,500, never 8,280");
  eq("Tamil Nadu, 8,333 a month, September 2024", computeProfessionalTax({ monthGross: 8333, state: "Tamil Nadu", month: 9, year: 2024, applicable: true, halfYearGrossBefore: 41667 }).amount, 690, "50,000 a half, the band before Chennai's revision");
  eq("...March 2025", computeProfessionalTax({ monthGross: 8333, state: "Tamil Nadu", month: 3, year: 2025, applicable: true, halfYearGrossBefore: 41667 }).amount, 930, "the same band after it, from October 2024");
  eq("Tamil Nadu, leaving in July", pt("Tamil Nadu", 20000, 7, { halfYearGrossBefore: 40000, leavingThisMonth: true }).amount, 930, "their last month: the half so far, 60,000, charged now");

  eq("Punjab, income tax on the payslip", pt("Punjab", 80000, 6, { deductsIncomeTax: true }).amount, 200, "the development tax, from anyone whose income is taxable");
  eq("Punjab, no income tax", pt("Punjab", 80000, 6).amount, 0, "nothing where none is deducted");

  const capped = pt("Maharashtra", 30000, 2, { paidThisYear: 2400 });
  eq("the ₹2,500 cap: February after 2,400", capped.amount, 100, "only what the year has left");
  truthy("...and says so", capped.notes.some((n) => n.includes("capped")), capped.notes.join(" | "));
  eq("...nothing once 2,500 is reached", pt("Karnataka", 30000, 3, { paidThisYear: 2500 }).amount, 0, "the year is paid");

  eq("Delhi, 100,000", pt("Delhi", 100000, 6).amount, 0, "Delhi levies none");
  const unknown = pt("Meghalaya", 50000, 6);
  truthy("a state whose law couldn't be confirmed is flagged, not guessed", !unknown.known, "returns zero and says it does not know");
  truthy(
    "every state's table was checked against the law on a day, and every rule names where it comes from",
    Object.values(PT_STATES).every((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.checked.on) && s.rules.every((r) => r.source.length > 20)),
    Object.entries(PT_STATES).filter(([, s]) => !s.checked.on).map(([k]) => k).join(", "),
  );
}

console.log("\n— Professional tax, checked against the law (17 Oct 2026) —");
{
  const at = (state: string, monthGross: number, month: number, year: number, more: Partial<Parameters<typeof computeProfessionalTax>[0]> = {}) =>
    computeProfessionalTax({ monthGross, state, month, year, applicable: true, ...more });

  // West Bengal: a new schedule from 1 Oct 2026 (Finance Act 2026; notification 1607-F.T.).
  eq("West Bengal, 25,000, September 2026", at("West Bengal", 25000, 9, 2026).amount, 130, "the 2016 table: above 15,000 to 25,000");
  eq("...October 2026", at("West Bengal", 25000, 10, 2026).amount, 100, "the 2026 table: above 20,000 to 30,000");
  eq("...20,000 in October", at("West Bengal", 20000, 10, 2026).amount, 0, "not exceeding 20,000 is nil");
  eq("...50,000 in October", at("West Bengal", 50000, 10, 2026).amount, 140, "50,000 is inside 'not exceeding 50,000'");
  eq("...50,001 in October", at("West Bengal", 50001, 10, 2026).amount, 170, "");
  eq("...1,50,000 in October", at("West Bengal", 150000, 10, 2026).amount, 208, "above 1,00,000");
  eq("...9,000 in 2015", at("West Bengal", 9000, 6, 2015).amount, 90, "the 2014 table's 8,500–10,000 slab, nil from August 2016");

  // Gujarat: "if pay exceeds ₹12,000" — 12,000 itself is nil, from 2022.
  eq("Gujarat, 12,000, June 2026", at("Gujarat", 12000, 6, 2026).amount, 0, "exactly 12,000 is nil — the engine charged 200 here");
  eq("...12,001", at("Gujarat", 12001, 6, 2026).amount, 200, "");
  eq("...12,000 in June 2021", at("Gujarat", 12000, 6, 2021).amount, 200, "the 2008 table: 12,000 and above");
  eq("...7,000 in June 2021", at("Gujarat", 7000, 6, 2021).amount, 80, "the 2008 table's 6,000–8,999 slab");

  eq("Karnataka, 20,000 in 2020", at("Karnataka", 20000, 6, 2020).amount, 200, "₹15,000 and above, before April 2023");
  eq("Maharashtra, a woman on 9,000 in 2020", at("Maharashtra", 9000, 6, 2020, { gender: "FEMALE" }).amount, 0, "women up to 10,000 nil from April 2015");
  eq("...in 2014", at("Maharashtra", 9000, 6, 2014, { gender: "FEMALE" }).amount, 175, "no women's table before April 2015");
  eq("Tamil Nadu, 50,000 a half, September 2017", at("Tamil Nadu", 8333, 9, 2017, { halfYearGrossBefore: 41667 }).amount, 510, "Chennai's table before April 2018");
  eq("Tamil Nadu, typed 'tamil-nadu'", at("tamil-nadu", 50000, 9, 2026, { halfYearGrossBefore: 250000 }).amount, 1250, "however the state is written");
  eq("Tamil Nadu, a half already charged", at("Tamil Nadu", 20000, 9, 2026, { halfYearGrossBefore: 100000, paidThisHalf: 1250, leavingThisMonth: true }).amount, 0, "a half is charged once");

  eq("Punjab, a senior citizen with income tax", at("Punjab", 80000, 6, 2026, { deductsIncomeTax: true, seniorCitizen: true }).amount, 0, "senior citizens are exempt (s.4)");
  truthy("...and says why", at("Punjab", 80000, 6, 2026, { deductsIncomeTax: true, seniorCitizen: true }).notes.some((n) => n.includes("senior citizen")), "");
  truthy("a senior citizen: born 1 April 1967 is, for 2026-27 — 60 on 31 March 2027", seniorCitizenIn(new Date(Date.UTC(1967, 3, 1)), 2026), "");
  truthy("...born 2 April 1967 isn't", !seniorCitizenIn(new Date(Date.UTC(1967, 3, 2)), 2026), "");

  // Odisha repealed its Act from 1 Apr 2026.
  eq("Odisha, 50,000 a month, June 2025", at("Odisha", 50000, 6, 2025).amount, 200, "6,00,000 a year, above 3,00,000");
  eq("...March 2026", at("Odisha", 50000, 3, 2026).amount, 300, "the year's last month");
  const odisha = at("Odisha", 50000, 6, 2026);
  truthy("...June 2026: nothing, and known", odisha.amount === 0 && odisha.known, "repealed from 1 April 2026");
  truthy("Chhattisgarh: nothing, and known", at("Chhattisgarh", 50000, 6, 2026).known && at("Chhattisgarh", 50000, 6, 2026).amount === 0, "exempt from the whole Act since 2011");
  truthy("Andaman and Nicobar, however it's written: none", at("Andaman and Nicobar Islands", 50000, 6, 2026).known, "");

  // Madhya Pradesh: the year's salary, ₹208 × 11 + ₹212 at the top.
  eq("Madhya Pradesh, 30,000 a month", at("Madhya Pradesh", 30000, 6, 2026).amount, 166, "3,60,000 a year: the 3–4 lakh slab");
  eq("...March", at("Madhya Pradesh", 30000, 3, 2027).amount, 174, "its last month rounds the year to 2,000");
  eq("...18,000 a month", at("Madhya Pradesh", 18000, 6, 2026).amount, 0, "2,16,000 a year, under 2,25,000");
  eq("...40,000 a month, March", at("Madhya Pradesh", 40000, 3, 2027).amount, 212, "4,80,000 a year: 208 × 11 + 212");
  eq("...loss of pay doesn't move the slab", at("Madhya Pradesh", 20000, 6, 2026, { monthRate: 30000 }).amount, 166, "read on the month's rate");
  eq("Jharkhand, 50,000 a month", at("Jharkhand", 50000, 6, 2026).amount, 150, "6,00,000 a year: the 5–8 lakh slab");

  // Kerala: half-yearly, collected in August and February.
  eq("Kerala, 30,000 a month, July", at("Kerala", 30000, 7, 2026, { halfYearGrossBefore: 90000 }).amount, 0, "not a month it's collected in");
  const august = at("Kerala", 30000, 8, 2026, { halfYearGrossBefore: 120000 });
  eq("...August", august.amount, 1250, "1,20,000 to July + 30,000 + September's 30,000 = 1,80,000: the top band");
  truthy("...and says the rest of the half was taken at this month's rate", august.notes.some((n) => n.includes("rest of the half")), august.notes.join(" | "));
  eq("...leaving in September, the half already charged", at("Kerala", 30000, 9, 2026, { halfYearGrossBefore: 150000, paidThisHalf: 1250, leavingThisMonth: true }).amount, 0, "charged once");
  eq("...7,000 a month, August", at("Kerala", 7000, 8, 2026, { halfYearGrossBefore: 28000 }).amount, 600, "42,000 for the half: the 30,000–44,999 band");

  // Bihar: the year's tax, from September's salary; February for anyone not charged then.
  eq("Bihar, 50,000 a month, June", at("Bihar", 50000, 6, 2026).amount, 0, "not September");
  eq("...September", at("Bihar", 50000, 9, 2026).amount, 2000, "6,00,000 a year: the 5–10 lakh slab, once");
  eq("...February, joined in October", at("Bihar", 50000, 2, 2027).amount, 2000, "not charged in September, so now");
  eq("...February, already charged", at("Bihar", 50000, 2, 2027, { paidThisYear: 2000 }).amount, 0, "");

  eq("Assam, 20,000, June 2026", at("Assam", 20000, 6, 2026).amount, 180, "the 2025 table");
  eq("...15,000", at("Assam", 15000, 6, 2026).amount, 0, "up to 15,000 nil from April 2025");
  eq("...12,000 in 2024", at("Assam", 12000, 6, 2024).amount, 150, "the 2014 table");
  eq("Andhra Pradesh, 20,000", at("Andhra Pradesh", 20000, 6, 2026).amount, 150, "20,000 is in the 15,001–20,000 slab");
  eq("Sikkim, 30,000", at("Sikkim", 30000, 6, 2026).amount, 125, "less than 30,001");
  eq("Tripura, 15,001", at("Tripura", 15001, 6, 2026).amount, 208, "");
  eq("Mizoram, 18,000", at("Mizoram", 18000, 6, 2026).amount, 195, "the 2024 band");
  eq("Nagaland, 12,000", at("Nagaland", 12000, 6, 2026).amount, 208, "12,000 or more");
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

  // September 2026, the month the PF ceiling rose on the 17th: only the days they were employed count.
  const sep = { year: 2026, month: 9 };
  const pfOnly = { pfApplicable: true, esiApplicable: false, ptApplicable: false };
  const sept = { components: { ...base, basic: 50000 }, flags: pfOnly, monthDays: 30, lopDays: 0, state: "Delhi", ...sep, incomeTax: 1 };
  const sepJoiner = computePayslip({ ...sept, employment: { firstDay: 20, lastDay: 30 } });
  eq("joined 20 Sep 2026 on ₹50,000 basic: PF", sepJoiner.pfEmployee, 2200, "12% of the 18,333 earned — every day of it under the ₹25,000 ceiling");
  const sepLeaver = computePayslip({ ...sept, employment: { firstDay: 1, lastDay: 10 } });
  eq("left 10 Sep 2026 on ₹50,000 basic: PF", sepLeaver.pfEmployee, 1800, "16,667 earned, all under the ₹15,000 ceiling, which isn't cut for a short month");
  eq("...the ceiling parts of a joiner's September", computePf(18333.33, { applicable: true, period: sep, employed: { firstDay: 20, lastDay: 30 } }).wages, 18333.33, "one part, 11 days at ₹25,000");

  // ESI: in or out by the month's rate, paid on what was earned.
  const esiOnly = { pfApplicable: false, esiApplicable: true, ptApplicable: false };
  const rate = (gross: number) => ({ basic: gross, hra: 0, conveyance: 0, medical: 0, specialAllowance: 0, otherAllowance: 0 });
  const above = computePayslip({ ...october, flags: esiOnly, components: rate(30000), employment: { firstDay: 20, lastDay: 31 } });
  eq("₹30,000 a month, joined the 20th: ESI", above.esiEmployee, 0, "11,613 earned, but the rate is above ₹21,000 — not covered");
  const below = computePayslip({ ...october, flags: esiOnly, components: rate(18000), employment: { firstDay: 20, lastDay: 31 } });
  eq("₹18,000 a month, joined the 20th: ESI", below.esiEmployee, 53, "covered; 0.75% of the 6,967.74 earned, rounded up");
  const lopAbove = computePayslip({ ...october, flags: esiOnly, components: rate(30000), lopDays: 10 });
  eq("₹30,000 a month with 10 days' loss of pay: ESI", lopAbove.esiEmployee, 0, "20,323 earned, still outside — loss of pay doesn't bring anyone into ESI");

  // A month their full and final settlement pays: an incentive still goes out, on a payslip of no days.
  const settledSlip = computePayslip({ ...october, flags: { pfApplicable: true, esiApplicable: false, ptApplicable: false }, salaryInSettlement: true, incentive: 5000 });
  eq("salary in the settlement, ₹5,000 incentive: paid days", settledSlip.paidDays, 0, "the settlement pays the days");
  eq("...gross", settledSlip.grossEarnings, 5000, "the incentive alone");
  eq("...PF", settledSlip.pfEmployee, 0, "PF is on basic, and there is none");
  truthy("...and says why", settledSlip.warnings.some((w) => w.includes("full and final settlement")), settledSlip.warnings.join(" | "));
}

console.log("\n— Professional tax on a payslip —");
{
  const flags = { pfApplicable: false, esiApplicable: false, ptApplicable: true };
  const comps = { basic: 25000, hra: 12500, conveyance: 0, medical: 0, specialAllowance: 12500, otherAllowance: 0 };
  const slip = (state: string, month: number, more: object = {}) =>
    computePayslip({ components: comps, flags, monthDays: 30, lopDays: 0, state, month, year: 2026, ...more });
  eq("Tamil Nadu payslip in June", slip("Tamil Nadu", 6).professionalTax, 0, "half-yearly: not this month");
  eq("...in September, with the half's history", slip("Tamil Nadu", 9, { ptHistory: { halfYearGrossBefore: 250000, paidThisYear: 0 } }).professionalTax, 1250, "3,00,000 for the half");
  eq("...the net carries it", slip("Tamil Nadu", 9, { ptHistory: { halfYearGrossBefore: 250000, paidThisYear: 0 }, incomeTax: 1 }).netPay, 48749, "50,000 less 1,250 and the 1 of income tax");
  eq("...leaving in July, their last month", slip("Tamil Nadu", 7, { ptHistory: { halfYearGrossBefore: 150000, paidThisYear: 0 }, leavingThisMonth: true }).professionalTax, 1250, "the half so far, charged now");
  eq("Punjab payslip with income tax entered", slip("Punjab", 6, { incomeTax: 5000 }).professionalTax, 200, "the development tax follows income tax");
  eq("...and without", slip("Punjab", 6).professionalTax, 0, "none where none is deducted");
  eq("Maharashtra payslip for a woman on 20,000", computePayslip({ components: { ...comps, basic: 10000, hra: 5000, specialAllowance: 5000 }, flags, monthDays: 30, lopDays: 0, state: "Maharashtra", month: 6, year: 2026, gender: "FEMALE" }).professionalTax, 0, "exempt up to 25,000");
  eq("a payslip after 2,400 this year, in February", slip("Maharashtra", 2, { year: 2027, ptHistory: { halfYearGrossBefore: 0, paidThisYear: 2400 } }).professionalTax, 100, "capped at the year's 2,500");
}

console.log("\n— A salary revised inside the month —");
{
  // October 2026, 31 days: ₹31,000 a month to the 15th, ₹46,500 from the 16th — 15 days and 16.
  const at = (iso: string) => ({ effectiveFrom: new Date(`${iso}T00:00:00Z`) });
  const spans = (list: { firstDay: number; lastDay: number }[]) => list.map((p) => `${p.firstDay}–${p.lastDay}`).join(", ");
  const split = salaryPartsInMonth([at("2026-04-01"), at("2026-10-16")], 2026, 10);
  truthy("a revision on the 16th splits the month 1–15 and 16–31", spans(split) === "1–15, 16–31", spans(split));
  const onFirst = salaryPartsInMonth([at("2026-04-01"), at("2026-10-01")], 2026, 10);
  truthy("...one on the 1st is the whole month at the new rate", spans(onFirst) === "1–31" && onFirst[0]!.structure.effectiveFrom.getUTCMonth() === 9, spans(onFirst));
  truthy("...two revisions, three parts", spans(salaryPartsInMonth([at("2026-04-01"), at("2026-10-10"), at("2026-10-20")], 2026, 10)) === "1–9, 10–19, 20–31", "");
  truthy("...one dated next month changes nothing yet", spans(salaryPartsInMonth([at("2026-04-01"), at("2026-11-01")], 2026, 10)) === "1–31", "");
  const late = salaryPartsInMonth([at("2026-10-10")], 2026, 10);
  truthy("...the first structure dated the 10th covers the days before it, and says so", spans(late) === "1–31" && late[0]!.backdated, "nobody's days go unpaid for a date typed late");
  truthy("...none at all, nothing", salaryPartsInMonth([at("2026-11-01")], 2026, 10).length === 0, "");

  const old = { basic: 15500, hra: 7750, conveyance: 0, medical: 0, specialAllowance: 7750, otherAllowance: 0 };
  const raised = { basic: 23250, hra: 11625, conveyance: 0, medical: 0, specialAllowance: 11625, otherAllowance: 0 };
  const october = { flags: { pfApplicable: false, esiApplicable: false, ptApplicable: false }, monthDays: 31, lopDays: 0, month: 10, year: 2026, incomeTax: 1 };
  const parts = (lopNew = 0) => [
    { components: old, firstDay: 1, lastDay: 15, lopDays: 0 },
    { components: raised, firstDay: 16, lastDay: 31, lopDays: lopNew },
  ];
  const revised = computePayslip({ ...october, components: raised, parts: parts() });
  eq("revised on the 16th: gross", revised.grossEarnings, 39000, "31,000 × 15/31 + 46,500 × 16/31 = 15,000 + 24,000");
  eq("...basic", revised.components.basic, 19500, "15,500 × 15/31 + 23,250 × 16/31 = 7,500 + 12,000");
  eq("...paid days", revised.paidDays, 31, "the whole month");
  truthy("...and the payslip says so", revised.warnings.some((w) => w.startsWith("Salary revised in the month")), revised.warnings.join(" | "));
  const docked = computePayslip({ ...october, components: raised, parts: parts(2), lopDays: 2 });
  eq("two days off after the raise: gross", docked.grossEarnings, 36000, "docked at the new rate: 15,000 + 46,500 × 14/31 = 15,000 + 21,000");
  eq("...loss of pay", docked.lopDays, 2, "");
  const joiner = computePayslip({ ...october, components: raised, parts: parts(), employment: { firstDay: 10, lastDay: 31 } });
  eq("joined on the 10th, raised on the 16th: gross", joiner.grossEarnings, 30000, "31,000 × 6/31 + 46,500 × 16/31 = 6,000 + 24,000");
  eq("no parts: the month at the one rate, as before", computePayslip({ ...october, components: raised }).grossEarnings, 46500, "");
  // ESI coverage is settled at the start of a contribution period: ₹20,000 a month to the 15th, then ₹25,000.
  const flat = (basic: number) => ({ basic, hra: 0, conveyance: 0, medical: 0, specialAllowance: 0, otherAllowance: 0 });
  const esi = computePayslip({
    ...october,
    flags: { pfApplicable: false, esiApplicable: true, ptApplicable: false },
    components: flat(25000),
    parts: [
      { components: flat(20000), firstDay: 1, lastDay: 15, lopDays: 0 },
      { components: flat(25000), firstDay: 16, lastDay: 31, lopDays: 0 },
    ],
  });
  truthy("a raise past the ESI limit inside the month: still covered this month", esi.esiEmployee > 0, `ESI ${esi.esiEmployee} on ${esi.grossEarnings}`);
}

console.log("\n— Income tax for the year (tax year 2026-27, checked 17 Oct 2026) —");
{
  const tax = (income: number, regime: "NEW" | "OLD", band: "BELOW_60" | "60_TO_79" | "80_PLUS" = "BELOW_60") => annualTax(income, regime, band, 2026).total;
  eq("new regime, 12,00,000", tax(1200000, "NEW"), 0, "60,000 of slab tax, all rebated (s.156(2)(a))");
  eq("...12,10,000", tax(1210000, "NEW"), 10400, "61,500 of slab tax, but never more than the 10,000 above 12 lakh; + 4% cess");
  eq("...15,00,000", tax(1500000, "NEW"), 109200, "20,000 + 40,000 + 15% of 3 lakh = 1,05,000; + 4,200 cess");
  eq("...17,25,000", tax(1725000, "NEW"), 150800, "1,20,000 + 20% of 1,25,000 = 1,45,000; + cess");
  eq("...55,00,000", tax(5500000, "NEW"), 1407120, "12,30,000 + 10% surcharge 1,23,000, no relief needed; + cess");
  eq("...50,10,000", tax(5010000, "NEW"), 1133600, "10,83,000; surcharge held to 7,000 by marginal relief (10,80,000 at 50 lakh + the 10,000 above); + cess");
  eq("old regime, under 60, 10,00,000", tax(1000000, "OLD"), 117000, "12,500 + 20% of 5 lakh = 1,12,500; + cess");
  eq("...5,00,000", tax(500000, "OLD"), 0, "12,500, rebated");
  eq("...5,00,010", tax(500010, "OLD"), 13002.08, "the old rebate has no marginal relief: 12,502 + cess");
  eq("...60 to 79, 6,00,000", tax(600000, "OLD", "60_TO_79"), 31200, "5% of 2 lakh + 20% of 1 lakh = 30,000; + cess");
  eq("...80 and over, 6,00,000", tax(600000, "OLD", "80_PLUS"), 20800, "20% of the 1 lakh over 5 lakh; + cess");
  truthy("age bands: born 1 Apr 1967 is 60 in 2026-27, born 2 Apr isn't, born 1 Apr 1947 is 80", ageBandIn(new Date(Date.UTC(1967, 3, 1)), 2026) === "60_TO_79" && ageBandIn(new Date(Date.UTC(1967, 3, 2)), 2026) === "BELOW_60" && ageBandIn(new Date(Date.UTC(1947, 3, 1)), 2026) === "80_PLUS", "");
  truthy("months to come: April 11, October 5, January 2, March 0", [4, 10, 1, 3].map(monthsLeftInTaxYear).join() === "11,5,2,0", [4, 10, 1, 3].map(monthsLeftInTaxYear).join());
}

console.log("\n— This month's TDS, by the average rate —");
{
  const none = { gross: 0, tds: 0, pt: 0, pf: 0 };
  const nothingDeclared = { hraExemption: 0, section80C: 0, section80CCD1B: 0, section80D: 0, homeLoanInterest: 0, otherDeductions: 0 };
  const tds = (month: number, monthly: number, more: Partial<Parameters<typeof monthlyTds>[0]> = {}) =>
    monthlyTds({
      taxYear: 2026,
      regime: "NEW",
      band: "BELOW_60",
      thisMonth: { gross: monthly, pf: 0, pt: 0 },
      toCome: { months: monthsLeftInTaxYear(month), gross: monthly, pf: 0, pt: 0 },
      earlier: none,
      previous: none,
      otherIncome: 0,
      otherTds: 0,
      declared: nothingDeclared,
      ...more,
    });
  eq("1,50,000 a month, April", tds(4, 150000).amount, 12567, "18 lakh − 75,000 = 17,25,000: 1,50,800 for the year ÷ 12");
  eq("...October, six months deducted", tds(10, 150000, { earlier: { gross: 900000, tds: 75402, pt: 0, pf: 0 } }).amount, 12566, "1,50,800 − 75,402 ÷ 6");
  eq("1,00,000 a month all year", tds(4, 100000).amount, 0, "11,25,000 after the standard deduction: under 12 lakh, all rebated");
  eq("raised from 1 to 2 lakh in October", tds(10, 200000, { earlier: { gross: 600000, tds: 0, pt: 0, pf: 0 } }).amount, 25133, "6 lakh + 12 lakh = 18 lakh: 1,50,800 over the 6 months left");
  eq("more already deducted than the year's tax", tds(10, 150000, { earlier: { gross: 900000, tds: 200000, pt: 0, pf: 0 } }).amount, 0, "nothing more this month");
  eq("joined in October from a previous employer (Form 122)", tds(10, 200000, { previous: { gross: 600000, tds: 30000, pt: 0, pf: 0 } }).amount, 20133, "18 lakh with the previous pay: 1,50,800 − their 30,000 ÷ 6");
  eq("leaving in October: whatever is left, now", tds(10, 300000, { earlier: { gross: 1800000, tds: 100000, pt: 0, pf: 0 }, toCome: { months: 0, gross: 300000, pf: 0, pt: 0 } }).amount, 114500, "21 lakh − 75,000: 2,14,500 for the year, 1,00,000 already deducted");
  const old = tds(4, 100000, {
    regime: "OLD",
    thisMonth: { gross: 100000, pf: 1800, pt: 200 },
    toCome: { months: 11, gross: 100000, pf: 1800, pt: 200 },
    declared: { ...nothingDeclared, hraExemption: 120000, section80C: 100000, section80D: 25000 },
  });
  eq("old regime, 1 lakh a month with HRA, 80C and 80D declared", old.amount, 7687, "12L − 50,000 − PT 2,400 − HRA 1,20,000 − 80C 1,21,600 (with PF) − 80D 25,000 = 8,81,000: 92,248 ÷ 12");
  eq("...80C capped at 1,50,000 with their PF", tds(4, 100000, { regime: "OLD", thisMonth: { gross: 100000, pf: 1800, pt: 0 }, toCome: { months: 11, gross: 100000, pf: 1800, pt: 0 }, declared: { ...nothingDeclared, section80C: 150000 } }).taxableIncome, 1000000, "12L − 50,000 − 1,50,000, not − 1,71,600");
  truthy("the working ends with this month's figure", old.lines[old.lines.length - 1]!.amount === old.amount, old.lines.map((l) => `${l.label}: ${l.amount}`).join(" | "));
}

console.log("\n— Leave day counting —");
countLeaveDaysProbe(eq, truthy);

console.log(failures === 0 ? "\nAll payroll checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);

import { formatCalendarDay } from "@/lib/time/zone";
import { computeProfessionalTax } from "@/lib/hr/professional-tax";

/**
 * Indian payroll arithmetic: gross, the statutory deductions, and what actually reaches the bank.
 *
 * Pure functions over plain numbers, so every figure on a payslip can be reproduced and argued
 * about without a database. Money is wrong more often than it is noticed, and the only defence is
 * being able to re-run the sum.
 *
 * Income tax is not worked out here: TDS needs the whole tax year — earlier payslips, the employee's
 * declaration, the months to come — so it is src/lib/hr/income-tax.ts (the arithmetic) and
 * src/lib/hr/tds.ts (gathering it), and arrives here as `incomeTax`, worked out or typed.
 */

export type SalaryComponents = {
  basic: number;
  hra: number;
  conveyance: number;
  medical: number;
  specialAllowance: number;
  otherAllowance: number;
  /**
   * The company's own components besides the six (owner, 21 Oct 2026) — a food allowance, an LTA. Part
   * of gross like the six, so ESI and professional tax count them and PF (on basic) doesn't.
   */
  custom?: SalaryCustomLine[];
};

/** One of the company's own pay components, in a structure or on a payslip: its name and monthly rupees. */
export type SalaryCustomLine = { name: string; amount: number };

export type StatutoryFlags = {
  pfApplicable: boolean;
  esiApplicable: boolean;
  ptApplicable: boolean;
};

/**
 * PF, ESI and TDS typed at the CTC split over Deskzo's own figures (owner, 23 Oct 2026: HR can edit the PF, ESI
 * and TDS amounts) — whole rupees for a full month. A share left out is worked out as it always was. PF and ESI
 * count only while the scheme is on for the person; a payslip pro-rates them by the days it pays, as it does
 * every earning. TDS is the payroll run's (src/actions/payroll.ts): taken whole in a month that pays salary.
 */
export type StatutoryFixed = { pfEmployee?: number; pfEmployer?: number; esiEmployee?: number; esiEmployer?: number; tds?: number };
export const STATUTORY_FIXED_KEYS = ["pfEmployee", "pfEmployer", "esiEmployee", "esiEmployer", "tds"] as const;

export function round2(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Statutory deductions are declared in whole rupees. */
export function roundRupee(value: number) {
  return Math.round(value);
}

export function monthlyGross(c: SalaryComponents) {
  const custom = (c.custom ?? []).reduce((sum, line) => sum + line.amount, 0);
  return round2(c.basic + c.hra + c.conveyance + c.medical + c.specialAllowance + c.otherAllowance + custom);
}

// ─── Provident Fund ───────────────────────────────────────────────────────────

/**
 * The statutory wage ceiling for EPF, EPS and EDLI, by the day it took effect. An employer may
 * contribute on the full basic instead, which is why `pfOnFullBasic` exists rather than being assumed
 * either way.
 *
 * ₹15,000 from 1 Sep 2014; ₹25,000 from **17 Sep 2026** (S.O. 5109(E), EPFO's wage-ceiling circular
 * and FAQs of 28 Sep 2026). A month in which the ceiling changes is one return, with the wages taken
 * proportionately by days either side of the change (FAQ Q7/Q9): September 2026 is 1–16 Sep at
 * ₹15,000 and 17–30 Sep at ₹25,000.
 */
export const PF_WAGE_CEILINGS: readonly { from: { year: number; month: number; day: number }; ceiling: number }[] = [
  { from: { year: 2014, month: 9, day: 1 }, ceiling: 15000 },
  { from: { year: 2026, month: 9, day: 17 }, ceiling: 25000 },
];
/** The ceiling in force on a calendar day (month 1–12). */
export function pfWageCeilingOn(year: number, month: number, day: number): number {
  const key = year * 10000 + month * 100 + day;
  let ceiling = PF_WAGE_CEILINGS[0]!.ceiling;
  for (const c of PF_WAGE_CEILINGS) if (c.from.year * 10000 + c.from.month * 100 + c.from.day <= key) ceiling = c.ceiling;
  return ceiling;
}
/** The newest ceiling — what a salary structure is planned against. */
export const PF_WAGE_CEILING = PF_WAGE_CEILINGS[PF_WAGE_CEILINGS.length - 1]!.ceiling;
/**
 * A month split where the ceiling changes within it: each part's days and ceiling. One part for any
 * month without a change; two for September 2026 (16 days at ₹15,000, 14 at ₹25,000).
 *
 * `employed` narrows it to the days somebody was employed: joining on 20 September 2026 is one part,
 * 11 days at ₹25,000 — none of their wages were earned under the old ceiling.
 */
export function pfCeilingParts(
  year: number,
  month: number,
  employed?: { firstDay: number; lastDay: number },
): { days: number; ceiling: number }[] {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const parts: { days: number; ceiling: number }[] = [];
  for (let day = Math.max(1, employed?.firstDay ?? 1); day <= Math.min(daysInMonth, employed?.lastDay ?? daysInMonth); day++) {
    const ceiling = pfWageCeilingOn(year, month, day);
    const last = parts[parts.length - 1];
    if (last && last.ceiling === ceiling) last.days += 1;
    else parts.push({ days: 1, ceiling });
  }
  return parts;
}
export const PF_EMPLOYEE_RATE = 0.12;
/**
 * The employer's 12% is split: 8.33% to the pension scheme (capped at the ceiling, always) and the
 * rest to PF. The split does not change what the employee receives, but it is what the return has
 * to show, so it is computed rather than lumped together.
 */
export const EPS_RATE = 0.0833;

export type PfResult = { employee: number; employer: number; eps: number; epf: number; wages: number };

/**
 * PF on a month's basic. `period` is the wage month (month 1–12): the ceiling in force that month —
 * and for a month the ceiling changes in, each part's ceiling on its share of the days (EPFO's FAQ Q7:
 * ₹20,000 in September 2026 is ₹15,000 × 16/30 + ₹20,000 × 14/30 = ₹17,333.33). Without a period, the
 * newest ceiling: a salary structure being planned now.
 *
 * In a month somebody joined or left in, the parts are their employed days only, shared out over
 * those days: the ceiling caps the wages they earned, and is not itself cut down for a short month —
 * a leaver on 10 September 2026 with ₹16,667 of basic pays PF on ₹15,000, not on a third of it.
 */
export function computePf(
  basicForPf: number,
  opts: {
    applicable: boolean;
    onFullBasic?: boolean;
    period?: { year: number; month: number };
    employed?: { firstDay: number; lastDay: number };
  },
): PfResult {
  if (!opts.applicable || basicForPf <= 0) {
    return { employee: 0, employer: 0, eps: 0, epf: 0, wages: 0 };
  }
  const parts = opts.period
    ? pfCeilingParts(opts.period.year, opts.period.month, opts.employed)
    : [{ days: 1, ceiling: PF_WAGE_CEILING }];
  const monthDays = parts.reduce((t, p) => t + p.days, 0);
  if (monthDays <= 0) return { employee: 0, employer: 0, eps: 0, epf: 0, wages: 0 };
  // The wage within the ceiling, taken part by part — what EPS is always on, and what PF is on unless
  // the employer contributes on the full basic.
  const capped = round2(parts.reduce((t, p) => t + (Math.min(basicForPf, p.ceiling) * p.days) / monthDays, 0));
  const wages = opts.onFullBasic ? basicForPf : capped;
  const employee = roundRupee(wages * PF_EMPLOYEE_RATE);
  const employer = roundRupee(wages * PF_EMPLOYEE_RATE);
  // EPS is always on the capped wage, even when the employer contributes on more than the ceiling.
  const eps = roundRupee(capped * EPS_RATE);
  return { employee, employer, eps, epf: round2(employer - eps), wages };
}

// ─── Employees' State Insurance ───────────────────────────────────────────────

/**
 * ESI applies only below a gross wage threshold. Crossing it mid-period does not end the liability
 * immediately — contribution continues to the end of the six-month contribution period — but this
 * engine takes the simple monthly view and flags the case rather than silently guessing, because
 * getting it wrong in either direction is a compliance problem.
 */
export const ESI_WAGE_LIMIT = 21000;
export const ESI_EMPLOYEE_RATE = 0.0075;
export const ESI_EMPLOYER_RATE = 0.0325;

export type EsiResult = { employee: number; employer: number; applied: boolean };

/**
 * Coverage is decided on the wage *rate* — a full month's pay — and the contribution is on what was
 * actually earned. Somebody on ₹30,000 a month who joins on the 20th earns ₹11,613 that month, and is
 * still outside ESI; somebody on ₹18,000 who loses ten days to loss of pay is still inside it.
 * `wageRate` is that full month; without it, the gross passed is taken as the rate.
 */
export function computeEsi(gross: number, opts: { applicable: boolean; wageRate?: number }): EsiResult {
  if (!opts.applicable || gross <= 0 || (opts.wageRate ?? gross) > ESI_WAGE_LIMIT) {
    return { employee: 0, employer: 0, applied: false };
  }
  // Rounded up to the rupee, which is what the ESI rules require of the employee's share.
  return {
    employee: Math.ceil(gross * ESI_EMPLOYEE_RATE),
    employer: Math.ceil(gross * ESI_EMPLOYER_RATE),
    applied: true,
  };
}

// ─── Professional tax ─────────────────────────────────────────────────────────

// Dated rules per state, half-yearly Tamil Nadu, Punjab's development tax and the ₹2,500 cap: their own
// module (./professional-tax.ts), re-exported here for the callers that import it from payroll.
export { computeProfessionalTax, normaliseState, PT_ANNUAL_CAP, PT_EXEMPT_STATES, PT_STATES, seniorCitizenIn, type PtResult } from "@/lib/hr/professional-tax";

// ─── Joining and leaving ──────────────────────────────────────────────────────

/** The days of one month somebody was employed for, as days of that month (1–31), both ends in. */
export type Employment = { firstDay: number; lastDay: number; days: number };

/**
 * The part of a month somebody was on the payroll: from their joining day, or the 1st, to their last
 * working day, or the month's end. Null when they were not employed for any of it — joined after it
 * ended, or left before it began.
 *
 * Dates are calendar days as a `@db.Date` holds them, at UTC midnight. A missing joining date means
 * "before this month", which is how a record entered without one has always been paid.
 */
export function employmentInMonth(
  year: number,
  month: number,
  joinedOn: Date | null | undefined,
  exitedOn: Date | null | undefined,
): Employment | null {
  const monthDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const thisMonth = year * 100 + month;
  const monthOf = (d: Date) => d.getUTCFullYear() * 100 + d.getUTCMonth() + 1;
  let firstDay = 1;
  let lastDay = monthDays;
  if (joinedOn) {
    if (monthOf(joinedOn) > thisMonth) return null;
    if (monthOf(joinedOn) === thisMonth) firstDay = joinedOn.getUTCDate();
  }
  if (exitedOn) {
    if (monthOf(exitedOn) < thisMonth) return null;
    if (monthOf(exitedOn) === thisMonth) lastDay = exitedOn.getUTCDate();
  }
  if (lastDay < firstDay) return null;
  return { firstDay, lastDay, days: lastDay - firstDay + 1 };
}

/**
 * A month's salary structures as the days each one covers: the one in force on the 1st until the day
 * before the next takes effect, and so on to the month's end. A revision on the 15th pays the 1st–14th
 * at the old rate and the 15th onwards at the new — taking the structure in force on the month's last
 * day for all of it, as the run used to, paid a raise from the 1st (or a cut).
 *
 * A month whose earliest structure starts after the 1st, with none before it, has the days before it
 * covered by that one: pay was being made at it, and a structure typed in with a later date than the
 * joining day shouldn't leave days unpaid. `backdated` says so, for the payslip's note.
 *
 * `structures` may be anybody's whole history; only those that touch the month are returned.
 */
export function salaryPartsInMonth<T extends { effectiveFrom: Date }>(
  structures: readonly T[],
  year: number,
  month: number,
): { structure: T; firstDay: number; lastDay: number; backdated: boolean }[] {
  const monthDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const first = Date.UTC(year, month - 1, 1);
  const last = Date.UTC(year, month - 1, monthDays);
  const sorted = structures.filter((s) => s.effectiveFrom.getTime() <= last).sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime());
  let start = 0;
  sorted.forEach((s, i) => {
    if (s.effectiveFrom.getTime() <= first) start = i;
  });
  const used = sorted.slice(start);
  return used
    .map((structure, i) => {
      const next = used[i + 1];
      const starts = structure.effectiveFrom.getTime() <= first ? 1 : structure.effectiveFrom.getUTCDate();
      return { structure, firstDay: i === 0 ? 1 : starts, lastDay: next ? next.effectiveFrom.getUTCDate() - 1 : monthDays, backdated: i === 0 && starts > 1 };
    })
    .filter((p) => p.lastDay >= p.firstDay);
}

// ─── The payslip ──────────────────────────────────────────────────────────────

export type PayslipInput = {
  /** The monthly rates — in force at the month's end, when `parts` splits the month. */
  components: SalaryComponents;
  /**
   * The month in parts, when the salary was revised inside it (`salaryPartsInMonth`): each part's
   * monthly rates, the days of the month it covers, and the loss of pay that fell in those days. Each
   * part is paid its days at its own rate. Left out, `components` is the rate for the whole month.
   */
  parts?: { components: SalaryComponents; firstDay: number; lastDay: number; lopDays: number }[];
  flags: StatutoryFlags;
  /** Calendar days in the month, and the days not paid for. */
  monthDays: number;
  lopDays: number;
  /**
   * The days of the month they were employed, when that is not all of it — the month they joined or
   * left in. Days outside it are not paid and are not loss of pay either: nobody was absent from a
   * job they did not yet have.
   */
  employment?: { firstDay: number; lastDay: number };
  /**
   * The month's salary is paid in their full and final settlement, so this payslip pays no days —
   * only what the settlement does not: an approved incentive going out this month.
   */
  salaryInSettlement?: boolean;
  /** Where the employee works, for professional tax. */
  state?: string | null;
  /** For Maharashtra's women's table (./professional-tax.ts). */
  gender?: "FEMALE" | "MALE" | "OTHER" | "UNDISCLOSED" | null;
  /**
   * Professional tax's look back at this financial year's earlier payslips: the gross of this half-year
   * (Tamil Nadu is charged on the half's income), and the tax already taken (the ₹2,500 annual cap).
   */
  ptHistory?: { halfYearGrossBefore: number; paidThisHalf?: number; paidThisYear: number };
  /** 60 or over at some point in this financial year — Punjab's development tax spares them. */
  seniorCitizen?: boolean;
  /**
   * Their last working day is in this month — when a half-yearly professional tax falls due early. Left
   * out, it is read from `employment`, which can't tell a leaver on the month's last day.
   */
  leavingThisMonth?: boolean;
  /** The wage month (1–12) and its year: professional tax's slab and the PF wage ceiling in force. */
  month: number;
  year: number;
  /** PF and ESI fixed on the salary structure in force at the month's end, for a full month. */
  fixed?: StatutoryFixed;
  /** TDS: worked out by src/lib/hr/tds.ts, typed by whoever runs payroll, or fixed on the salary structure. */
  incomeTax?: number;
  /** Worked out, a nil TDS is the answer, not a gap — the payslip says nothing about it. */
  incomeTaxWorkedOut?: boolean;
  otherDeduction?: number;
  pfOnFullBasic?: boolean;
  /**
   * Performance pay going out with this month's salary.
   *
   * Deliberately *not* pro-rated by loss of pay, unlike every salary component. An incentive is
   * earned by result, not by attendance — somebody who was off for three days and still hit their
   * number earned the whole thing, and docking it would be paying them twice for the same absence.
   */
  incentive?: number;
};

export type PayslipResult = {
  monthDays: number;
  paidDays: number;
  lopDays: number;
  components: SalaryComponents;
  incentive: number;
  grossEarnings: number;
  pfEmployee: number;
  pfEmployer: number;
  esiEmployee: number;
  esiEmployer: number;
  professionalTax: number;
  incomeTax: number;
  otherDeduction: number;
  totalDeductions: number;
  netPay: number;
  employerCost: number;
  /** Anything the person running payroll should look at before locking the run. */
  warnings: string[];
};

/**
 * Loss of pay is applied by pro-rating every earning component, not by docking the net.
 *
 * It has to work this way: PF is a percentage of basic, and ESI of gross, so a month with unpaid
 * days genuinely has a smaller basic and a smaller gross. Deducting a day's pay at the end instead
 * would over-contribute PF on wages that were never earned.
 *
 * A month somebody joined or left in is pro-rated the same way, over the calendar days of the whole
 * month: joining on the 20th of a 31-day month is 12/31 of every component.
 */
export function computePayslip(input: PayslipInput): PayslipResult {
  const warnings: string[] = [];
  const monthDays = input.monthDays > 0 ? input.monthDays : 30;
  const firstDay = Math.max(1, input.employment?.firstDay ?? 1);
  const lastDay = Math.min(monthDays, input.employment?.lastDay ?? monthDays);
  const employedDays = input.salaryInSettlement ? 0 : Math.max(0, lastDay - firstDay + 1);

  // Each part of the month at its own rate: the days of it they were employed, less the loss of pay
  // that fell in those days. A month with no revision is one part, at `components`.
  const c = input.components;
  const parts = (input.parts?.length ? input.parts : [{ components: c, firstDay: 1, lastDay: monthDays, lopDays: input.lopDays }]).map((p) => {
    const days = input.salaryInSettlement ? 0 : Math.max(0, Math.min(lastDay, p.lastDay) - Math.max(firstDay, p.firstDay) + 1);
    const lop = Math.max(0, Math.min(p.lopDays, days));
    return { ...p, days, lop, paid: days - lop };
  });
  const lopDays = round2(parts.reduce((sum, p) => sum + p.lop, 0));
  const paidDays = round2(parts.reduce((sum, p) => sum + p.paid, 0));
  type Fixed = Exclude<keyof SalaryComponents, "custom">;
  const earned = (key: Fixed) => round2(parts.reduce((sum, p) => sum + p.components[key] * (p.paid / monthDays), 0));
  // The company's own components, by name, each part at its own rate — pro-rated exactly as the six are.
  const customNames = [...new Set(parts.flatMap((p) => (p.components.custom ?? []).map((line) => line.name)))];
  const custom = customNames
    .map((name) => ({
      name,
      amount: round2(parts.reduce((sum, p) => sum + (p.components.custom?.find((line) => line.name === name)?.amount ?? 0) * (p.paid / monthDays), 0)),
    }))
    .filter((line) => line.amount > 0);
  const components: SalaryComponents = {
    basic: earned("basic"),
    hra: earned("hra"),
    conveyance: earned("conveyance"),
    medical: earned("medical"),
    specialAllowance: earned("specialAllowance"),
    otherAllowance: earned("otherAllowance"),
    ...(custom.length ? { custom } : {}),
  };
  // Added after the loss-of-pay factor, not inside it: the components above are pay for time, and
  // this is pay for result.
  const incentive = round2(Math.max(0, input.incentive ?? 0));
  const grossEarnings = round2(monthlyGross(components) + incentive);

  // PF is on basic, so an incentive never touches it. ESI and professional tax are on gross, so it
  // does — a monthly incentive is remuneration, and treating it otherwise would under-deduct both.
  const period = { year: input.year, month: input.month };
  const pf = computePf(components.basic, {
    applicable: input.flags.pfApplicable,
    onFullBasic: input.pfOnFullBasic,
    period,
    employed: { firstDay, lastDay },
  });
  // ESI's coverage is on the full month's rate, its contribution on what was earned (computeEsi). With
  // a revision inside the month, the rate it began on: coverage is settled at the start of a
  // contribution period, and a raise inside one doesn't end it.
  const wageRate = round2(monthlyGross(parts[0]!.components) + incentive);
  const esi = computeEsi(grossEarnings, { applicable: input.flags.esiApplicable, wageRate });
  // Fixed on the structure (StatutoryFixed): HR's full-month figure stands in for the worked-out share, pro-rated
  // by the days paid — loss of pay, joining or leaving, a payslip of no days. ESI fixed is taken above the wage
  // limit too: a contribution period that began below it still owes it, which is what fixing it is for.
  const fixed = input.fixed ?? {};
  const share = (amount: number) => roundRupee((amount * paidDays) / monthDays);
  const pfFixed = input.flags.pfApplicable ? fixed : {};
  const esiFixed = input.flags.esiApplicable ? fixed : {};
  const pfEmployee = pfFixed.pfEmployee !== undefined ? share(pfFixed.pfEmployee) : pf.employee;
  const pfEmployer = pfFixed.pfEmployer !== undefined ? share(pfFixed.pfEmployer) : pf.employer;
  const esiEmployee = esiFixed.esiEmployee !== undefined ? share(esiFixed.esiEmployee) : esi.employee;
  const esiEmployer = esiFixed.esiEmployer !== undefined ? share(esiFixed.esiEmployer) : esi.employer;
  const pt = computeProfessionalTax({
    monthGross: grossEarnings,
    monthRate: wageRate,
    state: input.state,
    month: input.month,
    year: input.year,
    applicable: input.flags.ptApplicable,
    gender: input.gender,
    halfYearGrossBefore: input.ptHistory?.halfYearGrossBefore,
    paidThisHalf: input.ptHistory?.paidThisHalf,
    paidThisYear: input.ptHistory?.paidThisYear,
    deductsIncomeTax: (input.incomeTax ?? 0) > 0,
    seniorCitizen: input.seniorCitizen,
    leavingThisMonth: input.leavingThisMonth ?? (input.employment !== undefined && input.employment.lastDay < monthDays),
  });
  warnings.push(...pt.notes);

  // The ceiling rise brings people into PF who were outside it: from 17 Sep 2026, basic above ₹15,000
  // and up to ₹25,000 (EPF, EPS and EDLI are all compulsory; FAQ Q28–Q31). Flagged, not switched on —
  // enrolment is the employer's act, with the member's details, and an establishment outside EPF has
  // nothing to do.
  const latest = PF_WAGE_CEILINGS[PF_WAGE_CEILINGS.length - 1]!;
  const previous = PF_WAGE_CEILINGS[PF_WAGE_CEILINGS.length - 2];
  const inForce = input.year * 100 + input.month >= latest.from.year * 100 + latest.from.month;
  if (!input.flags.pfApplicable && previous && inForce && c.basic > previous.ceiling && c.basic <= latest.ceiling) {
    const rupees = (v: number) => `₹${v.toLocaleString("en-IN")}`;
    const { year, month, day } = latest.from;
    // A calendar day, in the app's own words: Intl's en-IN says "Sept" in some ICU versions.
    const since = formatCalendarDay(new Date(Date.UTC(year, month - 1, day)));
    warnings.push(
      `PF isn't on for this employee, but their basic of ${rupees(c.basic)} is within the PF wage ceiling of ${rupees(latest.ceiling)} from ${since} (it was ${rupees(previous.ceiling)}). If your establishment is covered by EPF, they must be enrolled — switch PF on in their salary structure.`,
    );
  }

  if (input.flags.ptApplicable && !pt.known) {
    warnings.push(
      pt.stateLabel
        ? `No professional tax slab on file for ${pt.stateLabel} — nothing was deducted.`
        : "No work state on this employee, so professional tax was not deducted.",
    );
  }
  if (input.flags.esiApplicable && !esi.applied && wageRate > ESI_WAGE_LIMIT && esiFixed.esiEmployee === undefined && esiFixed.esiEmployer === undefined) {
    warnings.push(
      `Gross is above the ₹${ESI_WAGE_LIMIT.toLocaleString("en-IN")} ESI limit, so no ESI was deducted. If they were covered earlier in this contribution period, it may still be due.`,
    );
  }
  if (!input.incomeTax && !input.incomeTaxWorkedOut) {
    warnings.push("No income tax entered. This payslip deducts no TDS.");
  }
  if (input.salaryInSettlement) {
    warnings.push("This month's salary is in their full and final settlement — this payslip pays only their incentive.");
  } else if (employedDays < monthDays) {
    const day = (d: number) => formatCalendarDay(new Date(Date.UTC(input.year, input.month - 1, d)));
    const span =
      firstDay > 1 && lastDay < monthDays
        ? `Joined on ${day(firstDay)} and left on ${day(lastDay)}`
        : firstDay > 1
          ? `Joined on ${day(firstDay)}`
          : `Last working day ${day(lastDay)}`;
    warnings.push(`${span} — paid for ${employedDays} of ${monthDays} days.`);
  }
  const revised = parts.filter((p) => p.days > 0);
  if (revised.length > 1) {
    const day = (d: number) => formatCalendarDay(new Date(Date.UTC(input.year, input.month - 1, d)));
    const rupees = (v: number) => `₹${v.toLocaleString("en-IN")}`;
    warnings.push(
      `Salary revised in the month — ${revised.map((p) => `${p.paid} day(s) from ${day(Math.max(firstDay, p.firstDay))} at ${rupees(monthlyGross(p.components))} a month`).join(", ")}.`,
    );
  }
  if (lopDays > 0) {
    warnings.push(
      `${lopDays} day(s) loss of pay — every salary component is pro-rated to ${paidDays}/${monthDays}.${incentive > 0 ? " The incentive isn't: it was earned by result, not by attendance." : ""}`,
    );
  }

  const incomeTax = round2(input.incomeTax ?? 0);
  const otherDeduction = round2(input.otherDeduction ?? 0);
  const totalDeductions = round2(pfEmployee + esiEmployee + pt.amount + incomeTax + otherDeduction);
  const netPay = round2(grossEarnings - totalDeductions);
  const employerCost = round2(grossEarnings + pfEmployer + esiEmployer);

  return {
    monthDays,
    paidDays,
    lopDays,
    components,
    incentive,
    grossEarnings,
    pfEmployee,
    pfEmployer,
    esiEmployee,
    esiEmployer,
    professionalTax: pt.amount,
    incomeTax,
    otherDeduction,
    totalDeductions,
    netPay,
    employerCost,
    warnings,
  };
}

// A CTC split into a structure, and revisions by a percentage or an amount: src/lib/hr/salary-split.ts.

/** A full month's PF and ESI on a structure, both shares: Deskzo's figures, or those fixed on it (StatutoryFixed). */
export function monthlyStatutory(c: SalaryComponents, flags: Pick<StatutoryFlags, "pfApplicable" | "esiApplicable">, fixed: StatutoryFixed = {}) {
  const pf = computePf(c.basic, { applicable: flags.pfApplicable });
  const esi = computeEsi(monthlyGross(c), { applicable: flags.esiApplicable });
  const pfFixed = flags.pfApplicable ? fixed : {};
  const esiFixed = flags.esiApplicable ? fixed : {};
  return {
    pfEmployee: pfFixed.pfEmployee ?? pf.employee,
    pfEmployer: pfFixed.pfEmployer ?? pf.employer,
    esiEmployee: esiFixed.esiEmployee ?? esi.employee,
    esiEmployer: esiFixed.esiEmployer ?? esi.employer,
  };
}

/** Annual cost to company implied by a monthly structure: gross and the employer's PF and ESI, fixed or worked out. */
export function annualCtcOf(c: SalaryComponents, flags: Pick<StatutoryFlags, "pfApplicable" | "esiApplicable">, fixed: StatutoryFixed = {}) {
  const employer = monthlyStatutory(c, flags, fixed);
  return round2((monthlyGross(c) + employer.pfEmployer + employer.esiEmployer) * 12);
}

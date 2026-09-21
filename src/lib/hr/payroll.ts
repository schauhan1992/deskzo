/**
 * Indian payroll arithmetic: gross, the statutory deductions, and what actually reaches the bank.
 *
 * Pure functions over plain numbers, so every figure on a payslip can be reproduced and argued
 * about without a database. Money is wrong more often than it is noticed, and the only defence is
 * being able to re-run the sum.
 *
 * WHAT THIS DOES NOT DO: income tax. TDS on salary depends on the employee's declared investments,
 * their choice of old or new regime, income from elsewhere, and a projection across the whole year
 * that has to be trued up before March. Guessing at it would put a wrong number on a statutory
 * document and under-deduct tax the employer is liable for. `incomeTax` is therefore an amount
 * somebody enters, from wherever they compute it today — see the roadmap.
 */

export type SalaryComponents = {
  basic: number;
  hra: number;
  conveyance: number;
  medical: number;
  specialAllowance: number;
  otherAllowance: number;
};

export type StatutoryFlags = {
  pfApplicable: boolean;
  esiApplicable: boolean;
  ptApplicable: boolean;
};

export function round2(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Statutory deductions are declared in whole rupees. */
export function roundRupee(value: number) {
  return Math.round(value);
}

export function monthlyGross(c: SalaryComponents) {
  return round2(c.basic + c.hra + c.conveyance + c.medical + c.specialAllowance + c.otherAllowance);
}

// ─── Provident Fund ───────────────────────────────────────────────────────────

/**
 * The wage ceiling above which PF is not compulsory. An employer may contribute on the full basic
 * instead, which is why `pfOnFullBasic` exists rather than being assumed either way.
 */
export const PF_WAGE_CEILING = 15000;
export const PF_EMPLOYEE_RATE = 0.12;
/**
 * The employer's 12% is split: 8.33% to the pension scheme (capped at the ceiling, always) and the
 * rest to PF. The split does not change what the employee receives, but it is what the return has
 * to show, so it is computed rather than lumped together.
 */
export const EPS_RATE = 0.0833;

export type PfResult = { employee: number; employer: number; eps: number; epf: number; wages: number };

export function computePf(basicForPf: number, opts: { applicable: boolean; onFullBasic?: boolean }): PfResult {
  if (!opts.applicable || basicForPf <= 0) {
    return { employee: 0, employer: 0, eps: 0, epf: 0, wages: 0 };
  }
  const wages = opts.onFullBasic ? basicForPf : Math.min(basicForPf, PF_WAGE_CEILING);
  const employee = roundRupee(wages * PF_EMPLOYEE_RATE);
  const employer = roundRupee(wages * PF_EMPLOYEE_RATE);
  // EPS is always on the capped wage, even when the employer contributes on more than the ceiling.
  const eps = roundRupee(Math.min(wages, PF_WAGE_CEILING) * EPS_RATE);
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

export function computeEsi(gross: number, opts: { applicable: boolean }): EsiResult {
  if (!opts.applicable || gross <= 0 || gross > ESI_WAGE_LIMIT) {
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

/**
 * Professional tax is a state levy, so the slab depends on where the employee works — not where the
 * company is registered. Only the states this business actually employs in are listed; anywhere
 * else returns zero and says so, rather than quietly applying Maharashtra's rates to Karnataka.
 */
export type PtSlab = { upTo: number | null; amount: number };

export const PT_SLABS: Record<string, { label: string; slabs: PtSlab[]; februaryTopUp?: number }> = {
  MAHARASHTRA: {
    label: "Maharashtra",
    slabs: [
      { upTo: 7500, amount: 0 },
      { upTo: 10000, amount: 175 },
      { upTo: null, amount: 200 },
    ],
    // Maharashtra charges 300 in February so the year totals 2,500.
    februaryTopUp: 100,
  },
  KARNATAKA: {
    label: "Karnataka",
    slabs: [
      { upTo: 24999, amount: 0 },
      { upTo: null, amount: 200 },
    ],
  },
  WEST_BENGAL: {
    label: "West Bengal",
    slabs: [
      { upTo: 10000, amount: 0 },
      { upTo: 15000, amount: 110 },
      { upTo: 25000, amount: 130 },
      { upTo: 40000, amount: 150 },
      { upTo: null, amount: 200 },
    ],
  },
  TAMIL_NADU: {
    label: "Tamil Nadu",
    slabs: [
      { upTo: 21000, amount: 0 },
      { upTo: 30000, amount: 135 },
      { upTo: 45000, amount: 315 },
      { upTo: 60000, amount: 690 },
      { upTo: 75000, amount: 1025 },
      { upTo: null, amount: 1250 },
    ],
  },
  TELANGANA: {
    label: "Telangana",
    slabs: [
      { upTo: 15000, amount: 0 },
      { upTo: 20000, amount: 150 },
      { upTo: null, amount: 200 },
    ],
  },
  GUJARAT: {
    label: "Gujarat",
    slabs: [
      { upTo: 12000, amount: 0 },
      { upTo: null, amount: 200 },
    ],
  },
};

/** States with no professional tax at all — named so the UI can say so rather than look broken. */
export const PT_EXEMPT_STATES = ["DELHI", "HARYANA", "UTTAR PRADESH", "RAJASTHAN", "PUNJAB", "GOA"];

export function normaliseState(state: string | null | undefined) {
  return (state ?? "").trim().toUpperCase().replace(/\s+/g, "_");
}

export type PtResult = { amount: number; known: boolean; stateLabel: string | null };

export function computeProfessionalTax(
  gross: number,
  state: string | null | undefined,
  month: number,
  opts: { applicable: boolean },
): PtResult {
  if (!opts.applicable) return { amount: 0, known: true, stateLabel: null };

  const key = normaliseState(state);
  if (!key) return { amount: 0, known: false, stateLabel: null };
  if (PT_EXEMPT_STATES.includes(key.replace(/_/g, " "))) {
    return { amount: 0, known: true, stateLabel: key.replace(/_/g, " ") };
  }

  const config = PT_SLABS[key];
  if (!config) return { amount: 0, known: false, stateLabel: key.replace(/_/g, " ") };

  const slab = config.slabs.find((s) => s.upTo === null || gross <= s.upTo);
  let amount = slab?.amount ?? 0;
  if (amount > 0 && month === 2 && config.februaryTopUp) amount += config.februaryTopUp;
  return { amount, known: true, stateLabel: config.label };
}

// ─── The payslip ──────────────────────────────────────────────────────────────

export type PayslipInput = {
  components: SalaryComponents;
  flags: StatutoryFlags;
  /** Calendar days in the month, and the days not paid for. */
  monthDays: number;
  lopDays: number;
  /** Where the employee works, for professional tax. */
  state?: string | null;
  month: number;
  /** Entered by whoever runs payroll — see the note at the top of this file. */
  incomeTax?: number;
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
 */
export function computePayslip(input: PayslipInput): PayslipResult {
  const warnings: string[] = [];
  const monthDays = input.monthDays > 0 ? input.monthDays : 30;
  const lopDays = Math.max(0, Math.min(input.lopDays, monthDays));
  const paidDays = round2(monthDays - lopDays);
  const factor = paidDays / monthDays;

  const c = input.components;
  const components: SalaryComponents = {
    basic: round2(c.basic * factor),
    hra: round2(c.hra * factor),
    conveyance: round2(c.conveyance * factor),
    medical: round2(c.medical * factor),
    specialAllowance: round2(c.specialAllowance * factor),
    otherAllowance: round2(c.otherAllowance * factor),
  };
  // Added after the loss-of-pay factor, not inside it: the components above are pay for time, and
  // this is pay for result.
  const incentive = round2(Math.max(0, input.incentive ?? 0));
  const grossEarnings = round2(monthlyGross(components) + incentive);

  // PF is on basic, so an incentive never touches it. ESI and professional tax are on gross, so it
  // does — a monthly incentive is remuneration, and treating it otherwise would under-deduct both.
  const pf = computePf(components.basic, { applicable: input.flags.pfApplicable, onFullBasic: input.pfOnFullBasic });
  const esi = computeEsi(grossEarnings, { applicable: input.flags.esiApplicable });
  const pt = computeProfessionalTax(grossEarnings, input.state, input.month, { applicable: input.flags.ptApplicable });

  if (input.flags.ptApplicable && !pt.known) {
    warnings.push(
      pt.stateLabel
        ? `No professional tax slab on file for ${pt.stateLabel} — nothing was deducted.`
        : "No work state on this employee, so professional tax was not deducted.",
    );
  }
  if (input.flags.esiApplicable && !esi.applied && grossEarnings > ESI_WAGE_LIMIT) {
    warnings.push(
      `Gross is above the ₹${ESI_WAGE_LIMIT.toLocaleString("en-IN")} ESI limit, so no ESI was deducted. If they were covered earlier in this contribution period, it may still be due.`,
    );
  }
  if (!input.incomeTax) {
    warnings.push("No income tax entered. This payslip deducts no TDS.");
  }
  if (lopDays > 0) {
    warnings.push(
      `${lopDays} day(s) loss of pay — every salary component is pro-rated to ${paidDays}/${monthDays}.${incentive > 0 ? " The incentive isn't: it was earned by result, not by attendance." : ""}`,
    );
  }

  const incomeTax = round2(input.incomeTax ?? 0);
  const otherDeduction = round2(input.otherDeduction ?? 0);
  const totalDeductions = round2(pf.employee + esi.employee + pt.amount + incomeTax + otherDeduction);
  const netPay = round2(grossEarnings - totalDeductions);
  const employerCost = round2(grossEarnings + pf.employer + esi.employer);

  return {
    monthDays,
    paidDays,
    lopDays,
    components,
    incentive,
    grossEarnings,
    pfEmployee: pf.employee,
    pfEmployer: pf.employer,
    esiEmployee: esi.employee,
    esiEmployer: esi.employer,
    professionalTax: pt.amount,
    incomeTax,
    otherDeduction,
    totalDeductions,
    netPay,
    employerCost,
    warnings,
  };
}

/**
 * A CTC split into monthly components, as a starting point for a new structure.
 *
 * A suggestion, not a rule — every company splits differently, and the form lets it be overridden.
 * Basic at 40% of CTC and HRA at half of basic is the common Indian arrangement, and keeps basic
 * high enough that gratuity and PF are not artificially suppressed.
 */
export function suggestStructure(annualCtc: number): SalaryComponents & { employerPf: number } {
  const monthly = annualCtc / 12;
  const basic = round2(monthly * 0.4);
  const hra = round2(basic * 0.5);
  const employerPf = computePf(basic, { applicable: true }).employer;
  const remaining = round2(monthly - basic - hra - employerPf);
  return {
    basic,
    hra,
    conveyance: 0,
    medical: 0,
    specialAllowance: Math.max(remaining, 0),
    otherAllowance: 0,
    employerPf,
  };
}

/** Annual cost to company implied by a monthly structure. */
export function annualCtcOf(c: SalaryComponents, flags: Pick<StatutoryFlags, "pfApplicable" | "esiApplicable">) {
  const gross = monthlyGross(c);
  const pf = computePf(c.basic, { applicable: flags.pfApplicable });
  const esi = computeEsi(gross, { applicable: flags.esiApplicable });
  return round2((gross + pf.employer + esi.employer) * 12);
}

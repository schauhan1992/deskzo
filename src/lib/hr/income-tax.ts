/**
 * Income tax on salary, and the TDS a month's payslip deducts (owner, 17 Oct 2026). Pure, like the
 * payroll engine beside it (src/lib/hr/payroll.ts), so every figure can be re-run by hand.
 *
 * ## The law it follows
 *
 * Salary paid from 1 April 2026 is under the Income-tax Act, 2025: TDS under s.392 (formerly s.192 of
 * the 1961 Act), at the rates of the Finance Act's First Schedule Part III, for the "tax year" — the
 * April-to-March year (s.3). The figures were checked on 17 Oct 2026 against the Act as amended by the
 * Finance Act, 2026, which changed none of them from 2025-26:
 *
 *   · New regime, the default (s.202): ₹4L nil, 5%, 10%, 15%, 20%, 25% in ₹4L steps, 30% above ₹24L;
 *     standard deduction ₹75,000 (s.19); rebate of the whole tax up to ₹60,000 when income is ₹12L or
 *     less, and above ₹12L the tax is never more than the income above ₹12L (s.156(2)); surcharge 10%
 *     over ₹50L, 15% over ₹1Cr, 25% over ₹2Cr, each with marginal relief.
 *   · Old regime, chosen by the employee each year: ₹2.5L nil (₹3L at 60, ₹5L at 80), 5%, 20%, 30%;
 *     standard deduction ₹50,000; rebate ₹12,500 up to ₹5L, with no marginal relief; surcharge up to
 *     37% over ₹5Cr. Professional tax, HRA exemption, home-loan interest (₹2L) and the Chapter VIII
 *     deductions (80C's ₹1.5L, 80CCD(1B)'s ₹50,000, 80D) come off, as the employee has declared and
 *     shown evidence for (Form 124).
 *   · Health and Education Cess: 4% of tax and surcharge.
 *
 * Rebate and the regime's other reliefs are for a resident individual, which an employee is taken to
 * be. Employer NPS (s.124(1)/(2)), perquisites, arrears relief (s.157, Form 39) and a house-property
 * loss beyond home-loan interest are not modelled: the payslip's TDS can be typed over where they apply.
 *
 * ## The month's TDS: the average rate
 *
 * s.392(1) deducts at the average rate of the year's estimated tax, and s.392(5)(c) lets the employer
 * put any excess or shortfall right within the year. So each month: the year's salary is estimated —
 * what this tax year's earlier payslips paid, plus a previous employer's or the company's own before
 * Deskzo (Form 122), plus this month, plus this month's rate for every month still to come — its tax
 * worked out, less the TDS already deducted, and what is left spread evenly over this month and the
 * months to come. A raise, an incentive or a declaration changed in October is corrected in the months
 * after it, and March, or the month somebody leaves, takes whatever is left.
 */

export type TaxRegimeKey = "NEW" | "OLD";
export type AgeBand = "BELOW_60" | "60_TO_79" | "80_PLUS";

/** A band: income up to `upTo` (inclusive) is taxed at `rate` above the band before; the last has no ceiling. */
type Band = { upTo: number | null; rate: number };
type Surcharge = { above: number; rate: number };
type RegimeRates = {
  bands: Record<AgeBand, Band[]>;
  standardDeduction: number;
  rebate: { incomeUpTo: number; max: number; marginalRelief: boolean };
  /** Ascending. */
  surcharge: Surcharge[];
};
type TaxYearRates = { NEW: RegimeRates; OLD: RegimeRates; cess: number; source: string };

const NEW_BANDS: Band[] = [
  { upTo: 400000, rate: 0 },
  { upTo: 800000, rate: 0.05 },
  { upTo: 1200000, rate: 0.1 },
  { upTo: 1600000, rate: 0.15 },
  { upTo: 2000000, rate: 0.2 },
  { upTo: 2400000, rate: 0.25 },
  { upTo: null, rate: 0.3 },
];
const SINCE_2025: TaxYearRates = {
  NEW: {
    // The new regime has no age bands.
    bands: { BELOW_60: NEW_BANDS, "60_TO_79": NEW_BANDS, "80_PLUS": NEW_BANDS },
    standardDeduction: 75000,
    rebate: { incomeUpTo: 1200000, max: 60000, marginalRelief: true },
    surcharge: [
      { above: 5000000, rate: 0.1 },
      { above: 10000000, rate: 0.15 },
      { above: 20000000, rate: 0.25 },
    ],
  },
  OLD: {
    bands: {
      BELOW_60: [{ upTo: 250000, rate: 0 }, { upTo: 500000, rate: 0.05 }, { upTo: 1000000, rate: 0.2 }, { upTo: null, rate: 0.3 }],
      "60_TO_79": [{ upTo: 300000, rate: 0 }, { upTo: 500000, rate: 0.05 }, { upTo: 1000000, rate: 0.2 }, { upTo: null, rate: 0.3 }],
      "80_PLUS": [{ upTo: 500000, rate: 0 }, { upTo: 1000000, rate: 0.2 }, { upTo: null, rate: 0.3 }],
    },
    standardDeduction: 50000,
    rebate: { incomeUpTo: 500000, max: 12500, marginalRelief: false },
    surcharge: [
      { above: 5000000, rate: 0.1 },
      { above: 10000000, rate: 0.15 },
      { above: 20000000, rate: 0.25 },
      { above: 50000000, rate: 0.37 },
    ],
  },
  cess: 0.04,
  source: "Finance Act, 2025, First Schedule; for 2026-27 the Income-tax Act, 2025 ss.19, 156, 202 and 392, with the Finance Act, 2026 (no change in rates)",
};

/** The tax years Deskzo works TDS out for, by the April they start in. Earlier years are typed. */
export const TAX_YEARS: Record<number, TaxYearRates> = { 2025: SINCE_2025, 2026: SINCE_2025 };

/** Chapter VIII's ceilings in the old regime. */
export const OLD_REGIME_LIMITS = { section80C: 150000, section80CCD1B: 50000, homeLoanInterest: 200000 };

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

/** The tax year a wage month falls in: the April it starts in. */
export const taxYearOf = (year: number, month: number) => (month >= 4 ? year : year - 1);

/** The months after this one in its tax year — to March. */
export const monthsLeftInTaxYear = (month: number) => (month >= 4 ? 12 - month + 3 : 3 - month);

/**
 * Their age band for a tax year: 60, or 80, at some point in it. A birthday's age is reached the day
 * before it, so somebody born on 1 April turns 60 on 31 March — inside the year.
 */
export function ageBandIn(dateOfBirth: Date | null | undefined, taxYear: number): AgeBand {
  if (!dateOfBirth) return "BELOW_60";
  if (dateOfBirth.getTime() <= Date.UTC(taxYear - 79, 3, 1)) return "80_PLUS";
  if (dateOfBirth.getTime() <= Date.UTC(taxYear - 59, 3, 1)) return "60_TO_79";
  return "BELOW_60";
}

function bandTax(income: number, bands: Band[]): number {
  let tax = 0;
  let floor = 0;
  for (const band of bands) {
    const ceiling = band.upTo ?? Infinity;
    if (income > floor) tax += (Math.min(income, ceiling) - floor) * band.rate;
    if (income <= ceiling) break;
    floor = ceiling;
  }
  return tax;
}

export type AnnualTax = { income: number; slabTax: number; rebate: number; surcharge: number; cess: number; total: number };

/** The year's tax on a total income, after the rebate, surcharge (with marginal relief) and cess. */
export function annualTax(income: number, regime: TaxRegimeKey, band: AgeBand, taxYear: number): AnnualTax {
  const year = TAX_YEARS[taxYear];
  if (!year) throw new Error(`No income tax rates for the tax year starting April ${taxYear}.`);
  const rates = year[regime];
  const bands = rates.bands[band];
  const slabTax = bandTax(income, bands);

  // The rebate: all of it up to the limit; above it, in the new regime, the tax is never more than the
  // income above the limit.
  let afterRebate = slabTax;
  if (income <= rates.rebate.incomeUpTo) afterRebate = Math.max(0, slabTax - rates.rebate.max);
  else if (rates.rebate.marginalRelief) afterRebate = Math.min(slabTax, income - rates.rebate.incomeUpTo);
  const rebate = slabTax - afterRebate;

  // Surcharge at the band the income is over, but never so much that the tax and surcharge exceed what
  // they'd be at the band's threshold by more than the income above it.
  let surcharge = 0;
  const over = [...rates.surcharge].reverse().find((s) => income > s.above);
  if (over) {
    surcharge = afterRebate * over.rate;
    const lower = [...rates.surcharge].reverse().find((s) => over.above > s.above);
    const atThreshold = bandTax(over.above, bands);
    const atThresholdTotal = atThreshold + atThreshold * (lower?.rate ?? 0);
    surcharge = Math.max(0, Math.min(surcharge, atThresholdTotal + (income - over.above) - afterRebate));
  }
  const cess = (afterRebate + surcharge) * year.cess;
  return { income, slabTax: round2(slabTax), rebate: round2(rebate), surcharge: round2(surcharge), cess: round2(cess), total: round2(afterRebate + surcharge + cess) };
}

export type TaxFigures = { gross: number; tds: number; pt: number; pf: number };
export type OldRegimeDeclared = { hraExemption: number; section80C: number; section80CCD1B: number; section80D: number; homeLoanInterest: number; otherDeductions: number };

export type TdsInput = {
  taxYear: number;
  regime: TaxRegimeKey;
  band: AgeBand;
  /** This month's payslip: what it pays, and the PF and professional tax it takes. */
  thisMonth: { gross: number; pf: number; pt: number };
  /** The months to come, at this month's full rate (no incentive): pay, PF and professional tax a month. */
  toCome: { months: number; gross: number; pf: number; pt: number };
  /** This tax year's earlier payslips in Deskzo. */
  earlier: TaxFigures;
  /** A previous employer's, or the company's own before Deskzo (Form 122). */
  previous: TaxFigures;
  otherIncome: number;
  otherTds: number;
  declared: OldRegimeDeclared;
};

export type TdsLine = { label: string; amount: number };
export type TdsResult = {
  /** This month's TDS, in whole rupees. */
  amount: number;
  regime: TaxRegimeKey;
  estimatedSalary: number;
  taxableIncome: number;
  tax: AnnualTax;
  alreadyDeducted: number;
  monthsLeft: number;
  /** The working, for the payslip. */
  lines: TdsLine[];
};

/** This month's TDS on salary, by the average rate (see the top of this file). */
export function monthlyTds(input: TdsInput): TdsResult {
  const year = TAX_YEARS[input.taxYear];
  if (!year) throw new Error(`No income tax rates for the tax year starting April ${input.taxYear}.`);
  const rates = year[input.regime];
  const lines: TdsLine[] = [];
  const line = (label: string, amount: number) => {
    if (amount !== 0) lines.push({ label, amount: round2(amount) });
  };

  const salary = input.earlier.gross + input.previous.gross + input.thisMonth.gross + input.toCome.gross * input.toCome.months;
  line("Paid this tax year before this month", input.earlier.gross);
  line("From a previous employer, or before Deskzo", input.previous.gross);
  line("This month", input.thisMonth.gross);
  line(`${input.toCome.months} month(s) to come at this month's rate`, input.toCome.gross * input.toCome.months);
  const standard = Math.min(rates.standardDeduction, salary);
  line("Standard deduction", -standard);

  let income = salary - standard + input.otherIncome;
  line("Other income declared", input.otherIncome);
  if (input.regime === "OLD") {
    const d = input.declared;
    const pt = input.earlier.pt + input.previous.pt + input.thisMonth.pt + input.toCome.pt * input.toCome.months;
    const pf = input.earlier.pf + input.previous.pf + input.thisMonth.pf + input.toCome.pf * input.toCome.months;
    const homeLoan = Math.min(OLD_REGIME_LIMITS.homeLoanInterest, d.homeLoanInterest);
    const c80 = Math.min(OLD_REGIME_LIMITS.section80C, pf + d.section80C);
    const ccd1b = Math.min(OLD_REGIME_LIMITS.section80CCD1B, d.section80CCD1B);
    line("Professional tax", -pt);
    line("HRA exemption", -d.hraExemption);
    line("Home-loan interest", -homeLoan);
    line("80C, with their PF", -c80);
    line("80CCD(1B)", -ccd1b);
    line("80D", -d.section80D);
    line("Other deductions", -d.otherDeductions);
    income -= pt + d.hraExemption + homeLoan + c80 + ccd1b + d.section80D + d.otherDeductions;
  }
  // Total income is rounded to the nearest ₹10.
  const taxableIncome = Math.max(0, Math.round(income / 10) * 10);
  const tax = annualTax(taxableIncome, input.regime, input.band, input.taxYear);
  const alreadyDeducted = input.earlier.tds + input.previous.tds + input.otherTds;
  const monthsLeft = input.toCome.months + 1;
  const amount = Math.max(0, Math.round((tax.total - alreadyDeducted) / monthsLeft));

  lines.push({ label: "Taxable income", amount: taxableIncome });
  lines.push({ label: `Tax for the year (${input.regime === "NEW" ? "new" : "old"} regime, with cess)`, amount: tax.total });
  if (alreadyDeducted > 0) lines.push({ label: "TDS already deducted", amount: -round2(alreadyDeducted) });
  lines.push({ label: monthsLeft > 1 ? `This month: what's left ÷ ${monthsLeft} months` : "This month: what's left", amount });

  return { amount, regime: input.regime, estimatedSalary: round2(salary), taxableIncome, tax, alreadyDeducted: round2(alreadyDeducted), monthsLeft, lines };
}

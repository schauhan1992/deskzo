import { db } from "@/lib/db";
import { monthsBefore } from "@/lib/hr/payroll-month";
import { computePayslip, type SalaryComponents, type StatutoryFlags } from "@/lib/hr/payroll";
import { ageBandIn, monthlyTds, monthsLeftInTaxYear, TAX_YEARS, taxYearOf, type TdsResult } from "@/lib/hr/income-tax";

/**
 * The database half of TDS on salary (owner, 17 Oct 2026): everything `monthlyTds`
 * (src/lib/hr/income-tax.ts) needs about one person for one month — this tax year's earlier payslips,
 * their declaration, when they leave, how old they are — gathered here so the payroll run and a payslip
 * worked out again give the same answer. Deliberately NOT in a "use server" module: it reads anybody's
 * pay. The payroll actions check payroll.manage first.
 */

const n = (v: unknown) => Number(v ?? 0);

export type TdsMonth = {
  userId: string;
  year: number;
  month: number;
  /** This month's payslip as computed: what it pays and the PF and professional tax it takes. */
  thisMonth: { gross: number; pf: number; pt: number };
  /** The structure in force at the month's end — the rate for the months still to come. */
  rate: { components: SalaryComponents; flags: StatutoryFlags; state: string | null; gender: "FEMALE" | "MALE" | "OTHER" | "UNDISCLOSED" | null };
  joinedOn: Date | null;
  exitedOn: Date | null;
  dateOfBirth: Date | null;
};

export type TdsWorking = TdsResult & { warnings: string[] };

/** Null when Deskzo has no rates for the month's tax year — TDS is typed for those. */
export async function workOutTds(m: TdsMonth): Promise<TdsWorking | null> {
  const taxYear = taxYearOf(m.year, m.month);
  if (!TAX_YEARS[taxYear]) return null;
  const warnings: string[] = [];

  const earlierMonths = monthsBefore(m.year, m.month);
  const [slips, declaration] = await Promise.all([
    earlierMonths.length
      ? db.payslip.findMany({
          where: { userId: m.userId, run: { OR: earlierMonths } },
          select: { grossEarnings: true, incomeTax: true, professionalTax: true, pfEmployee: true, run: { select: { month: true } } },
        })
      : Promise.resolve([]),
    db.taxDeclaration.findUnique({ where: { userId_taxYear: { userId: m.userId, taxYear } } }),
  ]);
  const earlier = { gross: 0, tds: 0, pt: 0, pf: 0 };
  for (const s of slips) {
    earlier.gross += n(s.grossEarnings);
    earlier.tds += n(s.incomeTax);
    earlier.pt += n(s.professionalTax);
    earlier.pf += n(s.pfEmployee);
  }
  const previous = { gross: n(declaration?.previousGross), tds: n(declaration?.previousTds), pt: n(declaration?.previousPt), pf: n(declaration?.previousPf) };

  // Months still to come: to March, or to the month they leave in if that's known and sooner.
  let months = monthsLeftInTaxYear(m.month);
  if (m.exitedOn) {
    const exitIndex = m.exitedOn.getUTCFullYear() * 12 + m.exitedOn.getUTCMonth();
    const thisIndex = m.year * 12 + (m.month - 1);
    months = Math.max(0, Math.min(months, exitIndex - thisIndex));
  }

  // A full month at the rate in force, for what each month to come pays and takes. June stands for an
  // ordinary month: no February top-up, no half-yearly collection.
  const typical = computePayslip({
    components: m.rate.components,
    flags: m.rate.flags,
    monthDays: 30,
    lopDays: 0,
    state: m.rate.state,
    gender: m.rate.gender,
    month: 6,
    year: taxYear,
    incomeTax: 1,
  });

  // Paid before this month in the tax year, but not through Deskzo and not typed on their declaration:
  // the estimate would leave that pay out.
  const started = m.joinedOn && m.joinedOn > new Date(Date.UTC(taxYear, 3, 1)) ? m.joinedOn : new Date(Date.UTC(taxYear, 3, 1));
  const expected = earlierMonths.filter((x) => Date.UTC(x.year, x.month, 0) >= started.getTime()).length;
  const paidMonths = new Set(slips.map((s) => s.run.month)).size;
  if (paidMonths < expected && previous.gross === 0) {
    warnings.push(
      `${expected - paidMonths} earlier month(s) of this tax year have no payslip in Deskzo. If they were paid outside it, enter that pay on their tax declaration — until then this TDS is worked out without it.`,
    );
  }

  const result = monthlyTds({
    taxYear,
    regime: declaration?.regime ?? "NEW",
    band: ageBandIn(m.dateOfBirth, taxYear),
    thisMonth: m.thisMonth,
    toCome: { months, gross: typical.grossEarnings, pf: typical.pfEmployee, pt: typical.professionalTax },
    earlier,
    previous,
    otherIncome: n(declaration?.otherIncome),
    otherTds: n(declaration?.otherTds),
    declared: {
      hraExemption: n(declaration?.hraExemption),
      section80C: n(declaration?.section80C),
      section80CCD1B: n(declaration?.section80CCD1B),
      section80D: n(declaration?.section80D),
      homeLoanInterest: n(declaration?.homeLoanInterest),
      otherDeductions: n(declaration?.otherDeductions),
    },
  });
  if (result.alreadyDeducted > result.tax.total + 1) {
    warnings.push(`More TDS has been deducted this tax year than the year's estimated tax — ₹${Math.round(result.alreadyDeducted - result.tax.total).toLocaleString("en-IN")} too much so far. Nothing is deducted this month; whatever is still over in March, the employee claims back in their return.`);
  }
  return { ...result, warnings };
}

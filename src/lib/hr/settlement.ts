import { round2 } from "@/lib/hr/payroll";

/**
 * Full and final settlement: gratuity, leave encashment, notice recovery.
 *
 * Pure arithmetic over plain numbers, like the payroll engine beside it and for the same reason —
 * this is the single most disputed calculation in Indian HR, and the only defence against "that
 * figure is wrong" is being able to re-run the sum in front of somebody.
 *
 * Where the rules come from is stated at each function, because they are statutory rather than
 * chosen: getting the gratuity divisor or the eligibility threshold wrong is not a preference, it
 * is underpaying somebody what the Payment of Gratuity Act entitles them to.
 */

// ─── Gratuity ─────────────────────────────────────────────────────────────────

/** The Payment of Gratuity Act qualifying period. */
export const GRATUITY_MIN_YEARS = 5;
/** Lifetime exemption cap under the Act. */
export const GRATUITY_CEILING = 2_000_000;
/**
 * Fifteen days' wages per completed year, on a 26-day month — the Act's formula for an
 * establishment working six days a week, which is what this business does.
 */
export const GRATUITY_DAYS_PER_YEAR = 15;
export const GRATUITY_MONTH_DAYS = 26;

/**
 * Completed years of service, counted the way the Act counts them.
 *
 * A part-year over six months rounds up to a full year; six months or less is dropped. That single
 * rule is worth about a month's basic to somebody who resigns in the wrong week, so it is computed
 * rather than approximated.
 */
export function serviceYears(joinedOn: Date, lastWorkingDay: Date): number {
  if (lastWorkingDay < joinedOn) return 0;
  let years = lastWorkingDay.getUTCFullYear() - joinedOn.getUTCFullYear();
  const monthDelta = lastWorkingDay.getUTCMonth() - joinedOn.getUTCMonth();
  const dayDelta = lastWorkingDay.getUTCDate() - joinedOn.getUTCDate();
  let months = monthDelta + (dayDelta >= 0 ? 0 : -1);
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  // Over six months rounds up. Exactly six does not.
  return months > 6 ? years + 1 : years;
}

/** Exact tenure in years, for display — distinct from the rounded figure gratuity uses. */
export function exactTenureYears(joinedOn: Date, lastWorkingDay: Date): number {
  return round2(Math.max(0, (lastWorkingDay.getTime() - joinedOn.getTime()) / (365.25 * 86400000)));
}

export type GratuityResult = { amount: number; years: number; eligible: boolean; note: string };

/**
 * Gratuity on the last drawn basic.
 *
 * "Wages" under the Act means basic plus dearness allowance — not gross. Using gross would
 * overstate it by roughly double, which is the most common way this gets computed wrong.
 */
export function computeGratuity(lastBasic: number, joinedOn: Date, lastWorkingDay: Date): GratuityResult {
  const years = serviceYears(joinedOn, lastWorkingDay);

  if (years < GRATUITY_MIN_YEARS) {
    return {
      amount: 0,
      years,
      eligible: false,
      note: `Not payable — ${years} completed year(s) of service, and the Act requires ${GRATUITY_MIN_YEARS}.`,
    };
  }

  const raw = (lastBasic * GRATUITY_DAYS_PER_YEAR * years) / GRATUITY_MONTH_DAYS;
  const amount = Math.min(round2(raw), GRATUITY_CEILING);
  return {
    amount,
    years,
    eligible: true,
    note:
      raw > GRATUITY_CEILING
        ? `${years} year(s) × 15/26 of ₹${Math.round(lastBasic).toLocaleString("en-IN")} basic, capped at the statutory ₹20,00,000.`
        : `${years} completed year(s) × 15 days' basic on a 26-day month.`,
  };
}

// ─── Leave encashment ─────────────────────────────────────────────────────────

export type EncashableBalance = { code: string; name: string; days: number; encashable: boolean };

export type EncashmentResult = { days: number; amount: number; perDay: number; included: string[]; excluded: string[] };

/**
 * Unused leave paid out at the end.
 *
 * Only balances marked encashable count — earned leave typically, casual and sick leave typically
 * not. The excluded ones are returned by name rather than silently dropped, because "why was my
 * sick leave not paid" is the question this produces and the answer should be on the statement.
 *
 * The daily rate is basic on a 26-day month, matching the gratuity convention rather than the
 * payroll one: encashment is a wage payment, not a month of salary being pro-rated.
 */
export function computeEncashment(lastBasic: number, balances: EncashableBalance[]): EncashmentResult {
  const perDay = round2(lastBasic / GRATUITY_MONTH_DAYS);
  const included: string[] = [];
  const excluded: string[] = [];
  let days = 0;

  for (const b of balances) {
    if (b.days <= 0) continue;
    if (b.encashable) {
      days += b.days;
      included.push(`${b.days} ${b.code}`);
    } else {
      excluded.push(`${b.days} ${b.code}`);
    }
  }

  return { days: round2(days), amount: round2(days * perDay), perDay, included, excluded };
}

// ─── Notice period ────────────────────────────────────────────────────────────

export type NoticeResult = { servedDays: number; shortfallDays: number; recovery: number; note: string };

/**
 * What an unserved notice period costs.
 *
 * Recovered at the daily *gross*, not basic: the employee is being asked to compensate for time
 * they were contracted to work and did not, and the cost of that time is what they would have been
 * paid for it. A 30-day month is used as the divisor, which is the common contractual convention
 * and differs deliberately from the 26 used for statutory wage calculations above.
 */
export function computeNotice(
  monthlyGross: number,
  requiredDays: number,
  resignedOn: Date,
  lastWorkingDay: Date,
): NoticeResult {
  const servedDays = Math.max(0, Math.round((lastWorkingDay.getTime() - resignedOn.getTime()) / 86400000));
  const shortfallDays = Math.max(0, requiredDays - servedDays);
  const perDay = monthlyGross / 30;

  return {
    servedDays,
    shortfallDays,
    recovery: round2(shortfallDays * perDay),
    note:
      shortfallDays === 0
        ? `Full notice served — ${servedDays} of ${requiredDays} day(s).`
        : `${servedDays} of ${requiredDays} day(s) served; ${shortfallDays} day(s) short at ${Math.round(perDay).toLocaleString("en-IN")} a day.`,
  };
}

// ─── Statutory bonus ──────────────────────────────────────────────────────────

/** Payment of Bonus Act: the wage ceiling for eligibility, and the calculation ceiling. */
export const BONUS_ELIGIBILITY_WAGE = 21000;
export const BONUS_CALC_WAGE = 7000;
export const BONUS_MIN_RATE = 0.0833;

export type BonusResult = { amount: number; eligible: boolean; note: string };

/**
 * The statutory minimum bonus.
 *
 * Payable to anybody earning up to ₹21,000 a month, calculated on the lower of their actual wage
 * and ₹7,000 — so a person on ₹18,000 is paid 8.33% of ₹7,000, not of ₹18,000. That second ceiling
 * is the part most often missed, and missing it overpays by more than twice.
 */
export function computeStatutoryBonus(monthlyBasic: number, monthsWorked: number): BonusResult {
  if (monthlyBasic > BONUS_ELIGIBILITY_WAGE) {
    return {
      amount: 0,
      eligible: false,
      note: `Not eligible — basic above the ₹${BONUS_ELIGIBILITY_WAGE.toLocaleString("en-IN")} threshold under the Act.`,
    };
  }
  const base = Math.min(monthlyBasic, BONUS_CALC_WAGE);
  const amount = round2(base * BONUS_MIN_RATE * Math.min(monthsWorked, 12));
  return {
    amount,
    eligible: true,
    note: `8.33% of ₹${base.toLocaleString("en-IN")} for ${Math.min(monthsWorked, 12)} month(s).`,
  };
}

// ─── The settlement ───────────────────────────────────────────────────────────

export type SettlementInput = {
  monthlyBasic: number;
  monthlyGross: number;
  joinedOn: Date;
  resignedOn: Date;
  lastWorkingDay: Date;
  noticePeriodDays: number;
  /** Days of the final month actually worked and not already paid. */
  salaryDays: number;
  daysInFinalMonth: number;
  balances: EncashableBalance[];
  /** Entered by whoever prepares it. */
  bonusAmount?: number;
  otherEarnings?: number;
  advanceRecovery?: number;
  assetRecovery?: number;
  otherDeduction?: number;
  incomeTax?: number;
  professionalTax?: number;
  pfDeduction?: number;
};

export type SettlementResult = {
  serviceYears: number;
  salaryAmount: number;
  encashment: EncashmentResult;
  gratuity: GratuityResult;
  notice: NoticeResult;
  bonusAmount: number;
  otherEarnings: number;
  grossPayable: number;
  totalDeductions: number;
  netPayable: number;
  warnings: string[];
};

export function computeSettlement(input: SettlementInput): SettlementResult {
  const warnings: string[] = [];

  const salaryAmount = round2((input.monthlyGross / input.daysInFinalMonth) * input.salaryDays);
  const encashment = computeEncashment(input.monthlyBasic, input.balances);
  const gratuity = computeGratuity(input.monthlyBasic, input.joinedOn, input.lastWorkingDay);
  const notice = computeNotice(input.monthlyGross, input.noticePeriodDays, input.resignedOn, input.lastWorkingDay);

  const bonusAmount = round2(input.bonusAmount ?? 0);
  const otherEarnings = round2(input.otherEarnings ?? 0);

  const grossPayable = round2(salaryAmount + encashment.amount + gratuity.amount + bonusAmount + otherEarnings);
  const totalDeductions = round2(
    notice.recovery +
      (input.pfDeduction ?? 0) +
      (input.professionalTax ?? 0) +
      (input.incomeTax ?? 0) +
      (input.advanceRecovery ?? 0) +
      (input.assetRecovery ?? 0) +
      (input.otherDeduction ?? 0),
  );
  const netPayable = round2(grossPayable - totalDeductions);

  if (!gratuity.eligible && gratuity.years >= 4) {
    warnings.push(
      `${gratuity.years} years of service — just short of the 5 the Act requires. Worth checking the joining date before this goes out.`,
    );
  }
  if (encashment.excluded.length > 0) {
    warnings.push(`Not encashed: ${encashment.excluded.join(", ")} — those types are not marked encashable.`);
  }
  if (notice.shortfallDays > 0) {
    warnings.push(notice.note);
  }
  if (netPayable < 0) {
    warnings.push(
      `The employee owes ₹${Math.abs(netPayable).toLocaleString("en-IN")}. Nothing is paid out — this has to be recovered.`,
    );
  }
  if (!input.incomeTax) {
    warnings.push("No income tax entered. Gratuity above the exempt limit and leave encashment are taxable.");
  }

  return {
    serviceYears: gratuity.years,
    salaryAmount,
    encashment,
    gratuity,
    notice,
    bonusAmount,
    otherEarnings,
    grossPayable,
    totalDeductions,
    netPayable,
    warnings,
  };
}

import { db } from "@/lib/db";
import { daysInMonth, monthLabel, monthRange, toKey } from "@/lib/hr/calendar";
import { lossOfPayDays } from "@/lib/hr/loss-of-pay";
import { employmentInMonth, type Employment } from "@/lib/hr/payroll";
import { finalMonthDays, type FinalMonthDays } from "@/lib/hr/settlement";
import { formatCalendarDay } from "@/lib/time/zone";

/**
 * Deliberately NOT in a "use server" module, like loss-of-pay.ts beside it: it lists everybody's
 * joining and leaving dates for any month asked. The payroll and settlement actions check
 * payroll.manage first.
 *
 * The month somebody leaves in is paid once, and the rules that make it so are all here:
 *   · a settlement pays only the days no locked payslip has (`finalMonthFor`);
 *   · the payroll pays no days of a month a current settlement pays (`payrollMonth`), and a run that
 *     still does — calculated before the settlement was made — can't be locked (`alsoPaidBySettlement`);
 *   · a run whose payslip an approved settlement counted can't be unlocked (`settlementsRelyingOn`);
 *   · a settlement that no longer matches the record can't be approved (src/actions/settlement.ts).
 */

export type PayrollPerson = {
  id: string;
  name: string;
  branchId: string | null;
  state: string | null;
  employment: Employment;
  /** Their full and final settlement pays this month's days; a payslip may carry only an incentive. */
  salaryInSettlement: boolean;
};

/**
 * Who a month's payroll pays, and for which days of it.
 *
 * Everybody employed for at least one day of the month: joined on or before its last day, and either
 * still here or leaving inside it. Somebody who left in an earlier month is not on it even with their
 * login kept on — an exit can be recorded without deactivating the login, for a handover, and that
 * used to put them on every payroll after they had gone, at a full month's pay.
 *
 * Somebody joining after the month is named in `skipped` rather than dropped without a word: a
 * structure saved ahead of the joining day is not pay.
 *
 * Somebody whose settlement pays this month is returned with `salaryInSettlement` — no days here, and
 * runPayroll leaves them off unless an approved incentive is going out. Only a settlement for the last
 * working day on their record counts: one made before the exit date was changed is out of date, and
 * leaving them off on its say-so could pay the days in between to nobody. A run that pays them while
 * it stands is refused the lock, which is what gets it recalculated.
 */
export async function payrollMonth(year: number, month: number): Promise<{ people: PayrollPerson[]; skipped: string[] }> {
  const { from, to } = monthRange(year, month);
  // Spelled out as three cases rather than "active, and NOT left before the month": SQL's NOT over a
  // null exit date is null, not true, so that version dropped everybody who had never left.
  const candidates = await db.user.findMany({
    where: {
      OR: [
        { active: true, employeeProfile: { is: null } },
        { active: true, employeeProfile: { exitedOn: null } },
        { employeeProfile: { exitedOn: { gte: from } } },
      ],
    },
    select: {
      id: true,
      name: true,
      branchId: true,
      employeeProfile: { select: { state: true, joinedOn: true, exitedOn: true } },
    },
    orderBy: { name: "asc" },
  });

  // Whatever its status — a draft settlement is still the plan, and paying its days here as well is
  // the double payment this prevents.
  const settledOn = new Map(
    (
      await db.finalSettlement.findMany({
        where: {
          userId: { in: candidates.map((c) => c.id) },
          lastWorkingDay: { gte: from, lte: to },
          salaryDays: { gt: 0 },
        },
        select: { userId: true, lastWorkingDay: true },
      })
    ).map((s) => [s.userId, toKey(s.lastWorkingDay)]),
  );

  const people: PayrollPerson[] = [];
  const skipped: string[] = [];
  for (const c of candidates) {
    const profile = c.employeeProfile;
    const employment = employmentInMonth(year, month, profile?.joinedOn, profile?.exitedOn);
    if (!employment) {
      if (profile?.joinedOn && profile.joinedOn > to) {
        skipped.push(`${c.name} — joins on ${formatCalendarDay(profile.joinedOn)}`);
      }
      continue;
    }
    const settlementDay = settledOn.get(c.id);
    const salaryInSettlement = !!settlementDay && !!profile?.exitedOn && settlementDay === toKey(profile.exitedOn);
    people.push({ id: c.id, name: c.name, branchId: c.branchId, state: profile?.state ?? null, employment, salaryInSettlement });
  }
  return { people, skipped };
}

/**
 * Who a run pays days of a month their full and final settlement pays as well — the run was
 * calculated before the settlement was made, or before it was brought up to date. Names, for the
 * refusal to lock it. A payslip of no days (an incentive alongside the settlement) is no clash.
 */
export async function alsoPaidBySettlement(runId: string, year: number, month: number): Promise<string[]> {
  const { from, to } = monthRange(year, month);
  const slips = await db.payslip.findMany({
    where: {
      runId,
      paidDays: { gt: 0 },
      user: { settlement: { is: { lastWorkingDay: { gte: from, lte: to }, salaryDays: { gt: 0 } } } },
    },
    select: { user: { select: { name: true } } },
    orderBy: { user: { name: "asc" } },
  });
  return slips.map((s) => s.user.name);
}

/**
 * Whose approved or paid settlement pays part of the month they left in and left the rest to this
 * run's payslip. Unlocking the run and recalculating it would leave them off — their settlement pays
 * days of the month — and the days it left to this payslip would be paid by nobody. A settlement that
 * left the whole month to the payslip is no reason to refuse: the recalculation pays them again.
 * Names, for the refusal.
 */
export async function settlementsRelyingOn(runId: string, year: number, month: number): Promise<string[]> {
  const { from, to } = monthRange(year, month);
  const slips = await db.payslip.findMany({
    where: {
      runId,
      paidDays: { gt: 0 },
      user: {
        settlement: {
          is: { lastWorkingDay: { gte: from, lte: to }, salaryDays: { gt: 0 }, status: { in: ["APPROVED", "PAID"] } },
        },
      },
    },
    select: { user: { select: { name: true } } },
    orderBy: { user: { name: "asc" } },
  });
  return slips.map((s) => s.user.name);
}

export type FinalMonth = { month: number; year: number; monthDays: number; days: FinalMonthDays };

/**
 * The month somebody leaves in, as their settlement sees it: the days employed in it up to the last
 * working day, less loss of pay, less what a locked payslip for it already paid. A draft payslip is
 * not counted — it is a calculation that will be redone, and the run will leave them off when it is.
 */
export async function finalMonthFor(userId: string, joinedOn: Date | null, lastWorkingDay: Date): Promise<FinalMonth> {
  const month = lastWorkingDay.getUTCMonth() + 1;
  const year = lastWorkingDay.getUTCFullYear();
  const employed = employmentInMonth(year, month, joinedOn, lastWorkingDay);
  const lop = employed ? await lossOfPayDays(userId, year, month, employed) : 0;
  const payslip = await db.payslip.findFirst({
    where: { userId, run: { month, year, status: { in: ["LOCKED", "PAID"] } } },
    select: { paidDays: true },
  });
  return {
    month,
    year,
    monthDays: daysInMonth(year, month),
    days: finalMonthDays({
      employedDays: employed?.days ?? 0,
      lopDays: lop,
      paidOnPayslip: payslip ? Number(payslip.paidDays) : null,
    }),
  };
}

/**
 * Locked payslips that paid days after somebody's last working day — an exit recorded after the
 * months that followed it were already locked. Reported on the settlement, not taken back by it.
 */
export async function paidAfterLeaving(userId: string, lastWorkingDay: Date): Promise<{ label: string; days: number; gross: number }[]> {
  const month = lastWorkingDay.getUTCMonth() + 1;
  const year = lastWorkingDay.getUTCFullYear();
  const slips = await db.payslip.findMany({
    where: {
      userId,
      paidDays: { gt: 0 },
      run: {
        status: { in: ["LOCKED", "PAID"] },
        OR: [{ year: { gt: year } }, { year, month: { gt: month } }],
      },
    },
    select: { paidDays: true, grossEarnings: true, incentive: true, run: { select: { month: true, year: true } } },
    orderBy: [{ run: { year: "asc" } }, { run: { month: "asc" } }],
  });
  return slips.map((s) => ({
    label: monthLabel(s.run.month, s.run.year),
    days: Number(s.paidDays),
    // The salary part only: an incentive on the same payslip was earned before they left.
    gross: Math.round(Number(s.grossEarnings) - Number(s.incentive)),
  }));
}

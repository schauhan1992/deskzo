import { db } from "@/lib/db";
import { monthRange } from "@/lib/hr/calendar";
import { employmentInMonth, type Employment } from "@/lib/hr/payroll";
import { formatCalendarDay } from "@/lib/time/zone";

/**
 * Deliberately NOT in a "use server" module, like loss-of-pay.ts beside it: it lists everybody's
 * joining and leaving dates for any month asked. runPayroll checks payroll.manage first.
 */

export type PayrollPerson = {
  id: string;
  name: string;
  branchId: string | null;
  state: string | null;
  employment: Employment;
};

/**
 * Who a month's payroll pays, and for which days of it.
 *
 * Everybody employed for at least one day of the month: joined on or before its last day, and either
 * still here or leaving inside it. Somebody who left in an earlier month is not on it even with their
 * login kept on — an exit can be recorded without deactivating the login, for a handover, and that
 * used to put them on every payroll after they had gone, at a full month's pay.
 *
 * Two kinds are named in `skipped` rather than dropped without a word:
 *   · somebody joining after the month — a structure saved ahead of the joining day is not pay;
 *   · somebody whose full and final settlement already pays this month's days. The month somebody
 *     leaves in is paid once: the settlement pays only the days no locked payslip has
 *     (src/actions/settlement.ts), the payroll skips a month a settlement pays, and a run that still
 *     pays such a person — calculated before the settlement was made — can't be locked until it is
 *     calculated again (setPayrollStatus).
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

  // A settlement that pays salary for a last working day inside this month, whatever its status — a
  // draft one is still the plan, and paying the days here as well is the double payment this prevents.
  const settled = new Set(
    (
      await db.finalSettlement.findMany({
        where: {
          userId: { in: candidates.map((c) => c.id) },
          lastWorkingDay: { gte: from, lte: to },
          salaryDays: { gt: 0 },
        },
        select: { userId: true },
      })
    ).map((s) => s.userId),
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
    if (settled.has(c.id)) {
      skipped.push(`${c.name} — this month's salary is in their full and final settlement`);
      continue;
    }
    people.push({ id: c.id, name: c.name, branchId: c.branchId, state: profile?.state ?? null, employment });
  }
  return { people, skipped };
}

/**
 * Who a run pays for a month their full and final settlement pays as well — the run was calculated
 * before the settlement was made. Names, for the refusal to lock it.
 */
export async function alsoPaidBySettlement(runId: string, year: number, month: number): Promise<string[]> {
  const { from, to } = monthRange(year, month);
  const slips = await db.payslip.findMany({
    where: { runId, user: { settlement: { is: { lastWorkingDay: { gte: from, lte: to }, salaryDays: { gt: 0 } } } } },
    select: { user: { select: { name: true } } },
    orderBy: { user: { name: "asc" } },
  });
  return slips.map((s) => s.user.name);
}

import { db } from "@/lib/db";
import { monthRange } from "@/lib/hr/calendar";

/**
 * Deliberately NOT in a "use server" module.
 *
 * Every export from one becomes a client-callable endpoint, and this answers "was this person
 * absent, and how often" for any user id you care to pass. It is called from the payroll actions,
 * which do their own permission check first.
 */

export /**
 * Unpaid days in a month, for payroll.
 *
 * Counts what was actually recorded as unpaid: an ABSENT day, and a day of leave whose type is not
 * paid. Days nobody recorded are NOT counted as loss of pay — docking somebody's salary because HR
 * forgot to mark a day would be the worst possible default.
 *
 * `employed` narrows it to the days of the month they were employed (src/lib/hr/payroll.ts
 * `employmentInMonth`): a day before joining or after leaving is already unpaid, and counting an
 * absence recorded on it would take it off twice.
 */
async function lossOfPayDays(userId: string, year: number, month: number, employed?: { firstDay: number; lastDay: number }) {
  const whole = monthRange(year, month);
  const from = employed ? new Date(Date.UTC(year, month - 1, employed.firstDay)) : whole.from;
  const to = employed ? new Date(Date.UTC(year, month - 1, employed.lastDay)) : whole.to;
  const rows = await db.attendanceDay.findMany({
    where: { userId, date: { gte: from, lte: to } },
    select: { status: true, leaveRequestId: true },
  });

  const unpaidLeaveIds = new Set(
    (
      await db.leaveRequest.findMany({
        where: {
          id: { in: rows.map((r) => r.leaveRequestId).filter((v): v is string => !!v) },
          type: { paid: false },
        },
        select: { id: true },
      })
    ).map((r) => r.id),
  );

  let lop = 0;
  for (const row of rows) {
    if (row.status === "ABSENT") lop += 1;
    else if (row.leaveRequestId && unpaidLeaveIds.has(row.leaveRequestId)) {
      lop += row.status === "HALF_DAY" ? 0.5 : 1;
    }
  }
  return lop;
}

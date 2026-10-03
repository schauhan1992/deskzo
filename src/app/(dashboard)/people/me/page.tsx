import Link from "next/link";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { hrCapabilities, listHolidays } from "@/actions/hr";
import { leaveBalances, myLeaveRequests } from "@/actions/leave";
import { myRegularisations, regularisationQueue } from "@/actions/regularisation";
import { myToday } from "@/actions/attendance";
import { myPayslips } from "@/actions/payroll";
import { MyHr } from "@/components/hr/my-hr";
import { MyHandover } from "@/components/hr/my-handover";
import { handoverHistory } from "@/actions/handover";
import { db } from "@/lib/db";
import { dateOnly } from "@/lib/hr/calendar";
import { isModuleEntitled } from "@/lib/modules-access";
import { workspaceClock } from "@/lib/time/workspace";
import { personPath } from "@/lib/record-links";

export default async function MyHrPage() {
  const enabled = await isModuleEnabled("hr");
  if (!enabled) return <ModuleDisabledNotice moduleKey="hr" />;

  const caps = await hrCapabilities();
  // The workspace's year and today; UTC's lagged a day behind India until 05:30.
  const clock = await workspaceClock();
  const now = new Date();
  const year = clock.parts(now).year;

  const [today, balances, leave, regularisations, queue, payslips, holidays, handovers, me] = await Promise.all([
    myToday(),
    leaveBalances(caps.userId),
    myLeaveRequests(),
    myRegularisations(),
    regularisationQueue(),
    isModuleEntitled("payroll").then((has) => (has ? myPayslips() : [])),
    // This year and next, so late December still finds a "next holiday" rather than going blank.
    listHolidays(year).then(async (rows) => [...rows, ...(await listHolidays(year + 1))]),
    /**
     * Their own handovers, in both directions.
     *
     * Read through the same action the full record uses rather than a query of its own — it is
     * the thing that filters a shared split down to this person's share, and a second query here
     * would be a second chance to get that wrong.
     */
    handoverHistory(caps.userId),
    db.user.findUnique({
      where: { id: caps.userId },
      select: { name: true, userSeq: true, employeeProfile: { select: { exitedOn: true } } },
    }),
  ]);

  const todayDate = clock.calendarDate(now);
  const nextHoliday = holidays.find((h) => !h.optional && dateOnly(h.date) >= todayDate) ?? null;

  return (
    <div className="animate-fade-rise">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">My HR</h1>
          <p className="mt-1 text-sm text-muted">
            Your attendance, leave and payslips — and anything waiting on you to decide.
          </p>
        </div>
        {me && (
          <Link href={personPath(me.userSeq)} className="text-sm text-brand hover:underline">
            My full record →
          </Link>
        )}
      </div>

      {/*
        Above the clock and the leave balances, because on the one month of somebody's employment
        when this card exists it is the most important thing on the page.
      */}
      <div className="mt-5">
        <MyHandover
          entries={handovers}
          userId={caps.userId}
          name={me?.name ?? "you"}
          exitedOn={me?.employeeProfile?.exitedOn ?? null}
        />
      </div>

      <div className="mt-5">
        <MyHr
          today={today}
          balances={balances}
          leave={leave}
          regularisations={regularisations}
          queue={queue}
          payslips={payslips}
          nextHoliday={nextHoliday}
        />
      </div>
    </div>
  );
}

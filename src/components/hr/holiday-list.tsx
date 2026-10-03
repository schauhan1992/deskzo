import type { listHolidays, listLeaveTypes } from "@/actions/hr";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { dateOnly } from "@/lib/hr/calendar";
import { workspaceClock } from "@/lib/time/workspace";
import { formatCalendarDay } from "@/lib/time/zone";

type Holiday = Awaited<ReturnType<typeof listHolidays>>[number];
type LeaveType = Awaited<ReturnType<typeof listLeaveTypes>>[number];

/**
 * The holiday calendar as an employee sees it: read-only, and answering the two questions they
 * actually have — when is the next one, and how much leave am I entitled to.
 */
export async function HolidayList({
  holidays,
  leaveTypes,
  year,
}: {
  holidays: Holiday[];
  leaveTypes: LeaveType[];
  year: number;
}) {
  // The workspace's today. UTC's (`dateOnly(new Date())`) kept yesterday's holiday as the next one
  // until 05:30 in India.
  const today = (await workspaceClock()).calendarDate(new Date());
  const upcoming = holidays.filter((h) => dateOnly(h.date) >= today && !h.optional);
  const next = upcoming[0];

  return (
    <div className="space-y-5">
      {next && (
        <Card className="border-brand/40 bg-brand-subtle/40 px-4 py-3 text-sm">
          <span className="text-text">
            Next holiday: <span className="font-medium">{next.name}</span> on {formatCalendarDay(next.date)}
          </span>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader className="text-sm font-medium text-text">Holidays in {year}</CardHeader>
          <CardContent className="space-y-1.5">
            {holidays.length === 0 && (
              <p className="text-sm text-subtle">Nothing on the calendar for {year} yet.</p>
            )}
            {holidays.map((h) => {
              const past = dateOnly(h.date) < today;
              return (
                <div
                  key={h.id}
                  className={`flex flex-wrap items-baseline justify-between gap-x-3 text-sm ${past ? "opacity-50" : ""}`}
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-text">{h.name}</span>
                    {h.optional && <Badge tone="amber">Restricted</Badge>}
                  </span>
                  <span className="text-xs text-muted">{formatCalendarDay(h.date)}</span>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="text-sm font-medium text-text">Leave you can take</CardHeader>
          <CardContent className="space-y-1.5">
            {leaveTypes.filter((t) => t.active).length === 0 && (
              <p className="text-sm text-subtle">No leave types are set up yet.</p>
            )}
            {leaveTypes
              .filter((t) => t.active)
              .map((t) => (
                <div key={t.id} className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                  <span className="flex items-center gap-2">
                    <Badge tone="default">{t.code}</Badge>
                    <span className="text-text">{t.name}</span>
                    {!t.paid && <Badge tone="amber">Unpaid</Badge>}
                  </span>
                  <span className="text-xs text-muted">
                    {Number(t.annualQuota)} days a year
                    {t.accrual === "MONTHLY" && ", credited monthly"}
                  </span>
                </div>
              ))}
            <p className="border-t border-line pt-2 text-xs text-subtle">
              Your own balances are on the Leave page — this is the entitlement everybody gets.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

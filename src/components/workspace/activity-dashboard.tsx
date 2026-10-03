import Link from "next/link";
import { PhoneCall } from "lucide-react";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { workspaceClock } from "@/lib/time/workspace";
import { formatCalendarDay } from "@/lib/time/zone";
import { allocationMethodLabels, formatSpan } from "@/lib/workspace/allocation";
import type { activityReport } from "@/actions/calling-activity";

type Report = NonNullable<Awaited<ReturnType<typeof activityReport>>>;

/**
 * Where a calling activity stands.
 *
 * Handle time and gap are shown separately on purpose: a slow day is either long calls or long
 * silences between them, and those are different problems with different answers. A single
 * "average time per record" would hide which one you have.
 *
 * A deadline is a day as typed, held as midnight UTC, and a row under "By day" is the workspace's
 * day — both shown as the day they are; when somebody last worked is a moment, on the workspace's clock.
 */
export async function ActivityDashboard({ report, currentUserId }: { report: Report; currentUserId?: string }) {
  const clock = await workspaceClock();
  const { totals, callers, days, workbook } = report;
  const percent = totals.records > 0 ? Math.round((totals.worked / totals.records) * 100) : 0;
  const mine = callers.find((c) => c.id === currentUserId);

  return (
    <div className="@container space-y-4">
      {mine && mine.remaining > 0 && (
        <Card className="border-brand/40 bg-brand-subtle/40">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
            <span className="text-sm text-text">
              <span className="font-medium">{mine.remaining}</span> of your {mine.total} still to call
              {mine.dueAt && ` · due ${formatCalendarDay(mine.dueAt)}`}
            </span>
            <Link href={`/workspace/${workbook.id}/call`}>
              <Button size="sm">
                <PhoneCall className="mr-1.5 h-3.5 w-3.5" />
                Carry on calling
              </Button>
            </Link>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-4">
        <Stat label="Worked" value={`${totals.worked} / ${totals.records}`} hint={`${percent}% through`} />
        <Stat label="Still to call" value={String(totals.remaining)} hint={workbook.dueAt ? `due ${formatCalendarDay(workbook.dueAt)}` : "no deadline set"} />
        <Stat label="Time on records" value={formatSpan(totals.talkSeconds)} hint={`avg ${formatSpan(totals.averageHandleSeconds)} each`} />
        <Stat label="Time between" value={formatSpan(totals.idleSeconds)} hint={`avg ${formatSpan(totals.averageGapSeconds)} gap`} />
      </div>

      <Card className="overflow-x-auto p-0">
        <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
          <span>By caller</span>
          <span className="text-xs font-normal text-subtle">
            Shared out {allocationMethodLabels[workbook.allocationMethod].toLowerCase()}
            {workbook.startedAt && ` · started ${clock.date(workbook.startedAt)}`}
          </span>
        </CardHeader>
        <table className="w-full text-sm">
          <thead className="border-y border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">Caller</th>
              <th className="px-4 py-2.5">Progress</th>
              <th className="px-4 py-2.5 text-right">Done</th>
              <th className="px-4 py-2.5 text-right">Skipped</th>
              <th className="px-4 py-2.5 text-right">Avg call</th>
              <th className="px-4 py-2.5 text-right">Avg gap</th>
              <th className="px-4 py-2.5">Last worked</th>
              <th className="px-4 py-2.5">Task</th>
            </tr>
          </thead>
          <tbody>
            {callers.map((c) => {
              const share = c.total > 0 ? Math.round((c.worked / c.total) * 100) : 0;
              // Overdue once its day has passed on the workspace's calendar — the deadline is a typed day.
              const overdue = c.dueAt && !c.finishedAt && new Date(c.dueAt).toISOString().slice(0, 10) < clock.today();
              return (
                <tr key={c.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-2.5 font-medium text-text">{c.name}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-sunken">
                        <div className="h-full rounded-full bg-brand" style={{ width: `${share}%` }} />
                      </div>
                      <span className="text-xs text-subtle">
                        {c.worked}/{c.total}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-text">{c.done}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted">{c.skipped || "—"}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted">{formatSpan(c.averageHandleSeconds)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted">{formatSpan(c.averageGapSeconds)}</td>
                  <td className="px-4 py-2.5 text-xs text-subtle">
                    {c.lastActivityAt ? clock.dateTimeShort(c.lastActivityAt) : "Not started"}
                  </td>
                  <td className="px-4 py-2.5">
                    {c.finishedAt ? (
                      <Badge tone="green">Finished</Badge>
                    ) : overdue ? (
                      <Badge tone="red">Overdue</Badge>
                    ) : c.dueAt ? (
                      <Badge tone="amber">Due {formatCalendarDay(c.dueAt)}</Badge>
                    ) : (
                      <Badge tone="default">In progress</Badge>
                    )}
                  </td>
                </tr>
              );
            })}
            {callers.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-subtle">
                  Nobody is on this activity yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {days.length > 0 && (
        <Card className="overflow-x-auto p-0">
          <CardHeader className="text-sm font-medium text-text">By day</CardHeader>
          <table className="w-full text-sm">
            <thead className="border-y border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2.5">Date</th>
                <th className="px-4 py-2.5 text-right">Records worked</th>
                <th className="px-4 py-2.5 text-right">Time on them</th>
                <th className="px-4 py-2.5 text-right">Avg each</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.date} className="border-b border-line last:border-0">
                  <td className="px-4 py-2 text-text">{formatCalendarDay(d.date)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-text">{d.worked}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-muted">{formatSpan(d.talkSeconds)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-muted">
                    {formatSpan(d.worked > 0 ? Math.round(d.talkSeconds / d.worked) : 0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
      <div className="mt-1 text-lg font-semibold text-text">{value}</div>
      <div className="mt-0.5 text-xs text-muted">{hint}</div>
    </Card>
  );
}

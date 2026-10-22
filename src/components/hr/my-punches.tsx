"use client";

import { Clock } from "lucide-react";
import type { MyPunchDay } from "@/actions/attendance";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { useClock } from "@/components/time/clock-provider";
import { monthLabel } from "@/lib/hr/calendar";

const STATUS: Record<string, { label: string; tone: "green" | "blue" | "red" | "amber" | "default" }> = {
  PRESENT: { label: "Present", tone: "green" },
  WORK_FROM_HOME: { label: "Work from home", tone: "blue" },
  HALF_DAY: { label: "Half day", tone: "amber" },
  ON_LEAVE: { label: "On leave", tone: "red" },
  ABSENT: { label: "Absent", tone: "red" },
  HOLIDAY: { label: "Holiday", tone: "amber" },
  WEEK_OFF: { label: "Week off", tone: "default" },
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Wed, 22 Oct" from a yyyy-mm-dd — the day itself, whatever zone the browser is in. */
function dayWords(key: string) {
  const [y, m, d] = key.split("-").map(Number);
  const weekday = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  return `${WEEKDAYS[weekday]}, ${d} ${MONTHS[m! - 1]}`;
}

function hoursWords(minutes: number | null) {
  if (minutes == null) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

/**
 * The person's own days: when they came in, when they left, and the hours between (src/actions/attendance.ts
 * myPunches). Only ever their own — the action takes no person. The punches themselves aren't listed (owner,
 * 22 Oct 2026): In is the first, Out the last. Times on the workspace's clock, as everywhere else.
 */
export function MyPunches({ days, year, month }: { days: MyPunchDay[]; year: number; month: number }) {
  const clock = useClock();
  const time = (at: string | null) => (at ? clock.time(at) : "—");

  return (
    <Card>
      <CardHeader className="flex items-center gap-2 text-sm font-medium text-text">
        <Clock className="h-4 w-4" aria-hidden />
        My in &amp; out · {monthLabel(month, year)}
      </CardHeader>
      {days.length === 0 ? (
        <CardContent>
          <p className="text-sm text-subtle">Nothing recorded for you this month yet.</p>
        </CardContent>
      ) : (
        <>
          {/* A phone: one block a day — the table's columns don't fit. */}
          <ul className="divide-y divide-line sm:hidden">
            {days.map((d) => {
              const status = d.status ? STATUS[d.status] : null;
              return (
                <li key={d.date} className="space-y-1.5 px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-text">{dayWords(d.date)}</span>
                    {status && <Badge tone={status.tone}>{status.label}</Badge>}
                  </div>
                  <p className="text-sm text-muted tabular-nums">
                    In <span className="font-medium text-text">{time(d.checkInAt)}</span>
                    {" · "}Out{" "}
                    <span className="font-medium text-text">
                      {d.checkOutAt ? time(d.checkOutAt) : d.checkInAt ? "not yet" : "—"}
                    </span>
                    {d.workedMinutes != null && (
                      <>
                        {" · "}Total <span className="font-medium text-text">{hoursWords(d.workedMinutes)}</span>
                      </>
                    )}
                    {d.regularised && <span className="text-subtle"> · corrected</span>}
                  </p>
                </li>
              );
            })}
          </ul>
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-surface-sunken text-left text-[11px] font-semibold tracking-wide text-subtle uppercase">
                  <th className="px-4 py-2">Day</th>
                  <th className="px-4 py-2">In</th>
                  <th className="px-4 py-2">Out</th>
                  <th className="px-4 py-2">Total hours</th>
                  <th className="px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {days.map((d) => {
                  const status = d.status ? STATUS[d.status] : null;
                  return (
                    <tr key={d.date} className="border-b border-line align-top last:border-0">
                      <td className="px-4 py-2.5 whitespace-nowrap text-text">{dayWords(d.date)}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap font-medium text-text tabular-nums">
                        {time(d.checkInAt)}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap font-medium text-text tabular-nums">
                        {d.checkOutAt ? (
                          time(d.checkOutAt)
                        ) : d.checkInAt ? (
                          <span className="font-normal text-subtle">not yet</span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-muted tabular-nums">
                        {hoursWords(d.workedMinutes)}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        {status ? (
                          <Badge tone={status.tone}>{status.label}</Badge>
                        ) : (
                          <span className="text-subtle">—</span>
                        )}
                        {d.regularised && <span className="ml-1.5 text-xs text-subtle">corrected</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      <p className="border-t border-line px-4 py-2.5 text-xs text-subtle">
        In is your first punch of the day, Out your last. A time looks wrong? Ask for a correction from My HR.
      </p>
    </Card>
  );
}

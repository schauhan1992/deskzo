"use client";

import { useState, useTransition } from "react";
import { ChevronLeft, ChevronRight, Clock } from "lucide-react";
import { myDays, type MyDay } from "@/actions/attendance";
import { Badge, Card, CardHeader } from "@/components/ui/card";
import { useClock } from "@/components/time/clock-provider";
import { periodLabel, periodOf, stepPeriod, type Period, type PeriodView } from "@/lib/hr/period";
import { cn } from "@/lib/utils";

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

/** What a period adds up to: days present, days on leave, hours worked and the average a worked day. */
function summary(days: MyDay[]) {
  let present = 0;
  let leave = 0;
  let minutes = 0;
  let worked = 0;
  for (const d of days) {
    if (d.status === "PRESENT" || d.status === "WORK_FROM_HOME") present += 1;
    else if (d.status === "HALF_DAY") {
      present += 0.5;
      leave += 0.5;
    } else if (d.status === "ON_LEAVE") leave += 1;
    if (d.workedMinutes != null) {
      minutes += d.workedMinutes;
      worked += 1;
    }
  }
  return { present, leave, minutes, average: worked ? Math.round(minutes / worked) : null };
}

/**
 * The person's own attendance by week or by month: when they came in, when they left and the hours between, with
 * what the period adds up to (src/actions/attendance.ts myDays). Only ever their own — the action takes no
 * person. In is the first punch of a day and Out the last; the punches themselves aren't listed (owner, 22 Oct
 * 2026). Times on the workspace's clock, as everywhere else.
 */
export function MyInOut({ initial, today }: { initial: { period: Period; days: MyDay[] }; today: string }) {
  const clock = useClock();
  const time = (at: string | null) => (at ? clock.time(at) : "—");
  const [period, setPeriod] = useState(initial.period);
  const [days, setDays] = useState(initial.days);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function show(next: Period) {
    setPeriod(next);
    setProblem(null);
    startTransition(async () => {
      try {
        setDays(await myDays({ from: next.from, to: next.to }));
      } catch {
        setProblem("Couldn't load these days. Try again.");
      }
    });
  }

  const atLatest = period.to >= today;
  const totals = summary(days);
  const views: { value: PeriodView; label: string }[] = [
    { value: "week", label: "Week" },
    { value: "month", label: "Month" },
  ];

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-medium text-text">
          <Clock className="h-4 w-4" aria-hidden />
          My in &amp; out
        </span>
        <div className="flex items-center gap-2">
          <div role="radiogroup" aria-label="Show" className="flex rounded-base border border-line p-0.5">
            {views.map((v) => (
              <button
                key={v.value}
                type="button"
                role="radio"
                aria-checked={period.view === v.value}
                onClick={() =>
                  period.view !== v.value && show(periodOf(v.value, period.to < today ? period.to : today))
                }
                className={cn(
                  "rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors",
                  period.view === v.value ? "bg-brand-subtle text-brand" : "text-muted hover:text-text",
                )}
              >
                {v.label}
              </button>
            ))}
          </div>
          <div className="flex items-center">
            <button
              type="button"
              aria-label={`Previous ${period.view}`}
              onClick={() => show(stepPeriod(period, -1))}
              className="rounded-base p-1 text-muted transition-colors hover:bg-surface-sunken hover:text-text"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
            </button>
            <span className="min-w-[8.5rem] text-center text-xs font-medium text-text tabular-nums" aria-live="polite">
              {periodLabel(period)}
            </span>
            <button
              type="button"
              aria-label={`Next ${period.view}`}
              disabled={atLatest}
              onClick={() => show(stepPeriod(period, 1))}
              className="rounded-base p-1 text-muted transition-colors hover:bg-surface-sunken hover:text-text disabled:pointer-events-none disabled:opacity-30"
            >
              <ChevronRight className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </div>
      </CardHeader>

      <div className={cn("transition-opacity", pending && "opacity-50")} aria-busy={pending}>
        {/* What the week or month adds up to. */}
        <dl className="grid grid-cols-2 gap-px border-b border-line bg-line sm:grid-cols-4">
          {[
            { label: "Days present", value: String(totals.present) },
            { label: "Total hours", value: hoursWords(totals.minutes || (totals.present ? 0 : null)) },
            { label: "Average a day", value: hoursWords(totals.average) },
            { label: "Leave", value: String(totals.leave) },
          ].map((t) => (
            <div key={t.label} className="bg-surface px-4 py-3">
              <dt className="text-[11px] font-semibold tracking-wide text-subtle uppercase">{t.label}</dt>
              <dd className="mt-0.5 text-base font-semibold text-text tabular-nums">{t.value}</dd>
            </div>
          ))}
        </dl>

        {problem && <p className="border-b border-line px-4 py-2.5 text-sm text-danger">{problem}</p>}

        {days.length === 0 ? (
          <p className="px-4 py-6 text-sm text-subtle">Nothing to show for these days yet.</p>
        ) : (
          <>
            {/* A phone: one block a day — the table's columns don't fit. */}
            <ul className="divide-y divide-line sm:hidden">
              {days.map((d) => (
                <li key={d.date} className="space-y-1 px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-text">{dayWords(d.date)}</span>
                    <DayStatus day={d} />
                  </div>
                  {(d.checkInAt || d.checkOutAt) && (
                    <p className="text-sm text-muted tabular-nums">
                      In <span className="font-medium text-text">{time(d.checkInAt)}</span>
                      {" · "}Out{" "}
                      <span className="font-medium text-text">
                        {d.checkOutAt ? time(d.checkOutAt) : d.date === today ? "not yet" : "—"}
                      </span>
                      {d.workedMinutes != null && (
                        <>
                          {" · "}Total <span className="font-medium text-text">{hoursWords(d.workedMinutes)}</span>
                        </>
                      )}
                    </p>
                  )}
                </li>
              ))}
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
                  {days.map((d) => (
                    <tr
                      key={d.date}
                      className={cn(
                        "border-b border-line last:border-0",
                        d.offDay && !d.status && "bg-surface-sunken/50",
                      )}
                    >
                      <td className="px-4 py-2.5 whitespace-nowrap text-text">{dayWords(d.date)}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap font-medium text-text tabular-nums">
                        {time(d.checkInAt)}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap font-medium text-text tabular-nums">
                        {d.checkOutAt ? (
                          time(d.checkOutAt)
                        ) : d.checkInAt && d.date === today ? (
                          <span className="font-normal text-subtle">not yet</span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-muted tabular-nums">
                        {hoursWords(d.workedMinutes)}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        <DayStatus day={d} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      <p className="border-t border-line px-4 py-2.5 text-xs text-subtle">
        In is your first punch of the day, Out your last. A time looks wrong? Ask for a correction from My HR.
      </p>
    </Card>
  );
}

/** The day's status — or, with nothing recorded, a week off, a holiday, or a plain "not recorded" (not an absence). */
function DayStatus({ day }: { day: MyDay }) {
  const status = day.status ? STATUS[day.status] : null;
  if (status) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Badge tone={status.tone}>{status.label}</Badge>
        {day.regularised && <span className="text-xs text-subtle">corrected</span>}
      </span>
    );
  }
  return (
    <span className="text-xs text-subtle">
      {day.offDay === "week off" ? "Week off" : day.offDay === "holiday" ? "Holiday" : "Not recorded"}
    </span>
  );
}

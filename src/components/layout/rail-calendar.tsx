"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, MapPin, Video } from "lucide-react";
import { getMyCalendar, listMyDays } from "@/actions/calendar";
import { useClock } from "@/components/time/clock-provider";
import { OutboundLink } from "@/components/ui/outbound-link";
import { addDays, dayLabel, mondayOf } from "@/lib/calendar/days";
import { ITEM_KIND_LABELS, type CalendarItem } from "@/lib/calendar/items";
import { cn } from "@/lib/utils";

/**
 * My calendar beside the page (owner, 23 Oct 2026): a month to pick a day from, a dot on every day with
 * something on, and the chosen day's meetings with the tasks due, visits, leave, holidays and bookings the
 * Calendar page shows beside them. For a glance while doing something else — scheduling and moving meetings
 * stays on the Calendar page, a click away, which this opens at the chosen day's week.
 *
 * Fetched when the panel opens and when the month changes, never shipped with every page. Days are the
 * workspace's (its clock), as on the Calendar page.
 */

const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"] as const;
const MONTH = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });

/** "2026-10" moved by whole months. */
function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7);
}

export function RailCalendar() {
  const clock = useClock();
  const today = clock.today();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [day, setDay] = useState(today);
  const [viewingAs, setViewingAs] = useState(false);
  const [loaded, setLoaded] = useState<{ range: string; items: CalendarItem[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Six whole weeks from the Monday on or before the 1st, so the grid never changes height.
  const gridStart = mondayOf(`${month}-01`);
  const keys = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const range = `${keys[0]}/${keys[41]}`;
  const items = loaded?.range === range ? loaded.items : null;

  useEffect(() => {
    let live = true;
    getMyCalendar()
      .then((summary) => live && setViewingAs(summary.state === "viewing-as"))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    const [from, to] = range.split("/");
    listMyDays({ from, to })
      .then((rows) => {
        if (!live) return;
        setError(null);
        setLoaded({ range, items: rows });
      })
      .catch(() => live && setError("Could not load your calendar."));
    return () => {
      live = false;
    };
  }, [range]);

  // The Calendar page's rule: an all-day item covers its days; a timed one, every day it touches.
  const onDay = (key: string) =>
    (items ?? []).filter((e) =>
      e.allDay ? e.startsAt.slice(0, 10) <= key && key < e.endsAt.slice(0, 10) : clock.dateKey(new Date(e.startsAt)) <= key && key <= clock.dateKey(new Date(new Date(e.endsAt).getTime() - 1)),
    );
  const busy = (key: string) => onDay(key).some((e) => e.status !== "CANCELLED");
  const chosen = onDay(day).sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startsAt.localeCompare(b.startsAt));
  const [y, m] = month.split("-").map(Number);

  function pick(key: string) {
    setDay(key);
    if (key.slice(0, 7) !== month) setMonth(key.slice(0, 7));
  }

  if (viewingAs) return <p className="text-sm text-muted">Your calendar isn&apos;t shown while you&apos;re viewing as somebody else.</p>;

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <button type="button" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month" className="rounded-base p-1 text-muted hover:bg-surface-sunken hover:text-text">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-sm font-medium text-text" aria-live="polite">
            {MONTH.format(Date.UTC(y, m - 1, 1))}
          </span>
          <button type="button" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month" className="rounded-base p-1 text-muted hover:bg-surface-sunken hover:text-text">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        <div className="grid grid-cols-7 gap-0.5 text-center" role="group" aria-label="Choose a day">
          {WEEKDAYS.map((w, i) => (
            <span key={i} aria-hidden="true" className="pb-1 text-[10px] font-medium uppercase text-subtle">
              {w}
            </span>
          ))}
          {keys.map((key) => {
            const inMonth = key.slice(0, 7) === month;
            const isToday = key === today;
            const isChosen = key === day;
            const has = items !== null && busy(key);
            return (
              <button
                key={key}
                type="button"
                onClick={() => pick(key)}
                aria-pressed={isChosen}
                aria-label={`${dayLabel(key, true)}${isToday ? ", today" : ""}${has ? ", has something on" : ""}`}
                className={cn(
                  "relative mx-auto grid h-8 w-8 place-items-center rounded-full text-xs transition-colors",
                  isChosen ? "bg-brand font-semibold text-white" : isToday ? "font-semibold text-brand ring-1 ring-brand/50" : inMonth ? "text-text hover:bg-surface-sunken" : "text-subtle hover:bg-surface-sunken",
                )}
              >
                {Number(key.slice(8, 10))}
                {has && <span aria-hidden="true" className={cn("absolute bottom-0.5 h-1 w-1 rounded-full", isChosen ? "bg-white" : "bg-brand")} />}
              </button>
            );
          })}
        </div>
        {day !== today && (
          <button type="button" onClick={() => pick(today)} className="mt-1 text-xs font-medium text-brand hover:underline">
            Back to today
          </button>
        )}
      </div>

      <section aria-label={`On ${dayLabel(day, true)}`} className="border-t border-line pt-3">
        <h3 className={cn("mb-2 text-xs font-semibold uppercase tracking-wide", day === today ? "text-brand" : "text-subtle")}>
          {day === today ? "Today · " : ""}
          {dayLabel(day, true)}
        </h3>
        {error ? (
          <p className="text-sm text-danger">{error}</p>
        ) : items === null ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : chosen.length === 0 ? (
          <p className="text-sm text-muted">Nothing on this day.</p>
        ) : (
          <ul className="space-y-2">
            {chosen.map((e) => (
              <li
                key={e.id}
                className={cn(
                  "rounded-base border px-2.5 py-2",
                  e.status === "CANCELLED" ? "border-line bg-surface-sunken" : e.kind !== "meeting" ? "border-dashed border-line-strong" : e.record || e.native ? "border-brand/40 bg-brand-subtle" : "border-line-strong",
                )}
              >
                <p className="text-[11px] text-muted">
                  {e.allDay ? "All day" : e.endsAt === e.startsAt ? clock.time(e.startsAt) : `${clock.time(e.startsAt)} – ${clock.time(e.endsAt)}`}
                  {e.kind !== "meeting" ? ` · ${ITEM_KIND_LABELS[e.kind]}` : ""}
                  {e.status === "CANCELLED" ? " · Cancelled" : ""}
                </p>
                <p className={cn("text-sm text-text", e.status === "CANCELLED" && "text-subtle line-through")}>{e.title}</p>
                {e.location && e.status !== "CANCELLED" && (
                  <p className="mt-0.5 flex items-center gap-1 text-xs text-muted">
                    <MapPin aria-hidden="true" className="h-3 w-3 shrink-0" />
                    <span className="truncate">{e.location}</span>
                  </p>
                )}
                {(e.record || (e.joinUrl && e.status !== "CANCELLED")) && (
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    {e.record && (
                      <Link href={e.record.href} className="text-brand hover:underline">
                        {e.record.label}
                      </Link>
                    )}
                    {e.joinUrl && e.status !== "CANCELLED" && (
                      <OutboundLink href={e.joinUrl} className="inline-flex items-center gap-1 font-medium text-brand hover:underline">
                        <Video aria-hidden="true" className="h-3.5 w-3.5" />
                        Join
                      </OutboundLink>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Link href={`/calendar?week=${day}`} className="block text-center text-xs font-medium text-brand hover:underline">
        Open calendar
      </Link>
    </div>
  );
}

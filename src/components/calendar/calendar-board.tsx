"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, RefreshCw, Video } from "lucide-react";
import { syncMyCalendar, type CalendarSummary, type MyEvent } from "@/actions/calendar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { OutboundLink } from "@/components/ui/outbound-link";
import { useClock } from "@/components/time/clock-provider";
import { CalendarNotice } from "@/components/calendar/calendar-notice";
import { ScheduleMeetingButton } from "@/components/calendar/schedule-meeting-button";
import { MeetingActions } from "@/components/calendar/meeting-actions";
import { addDays, dayLabel, spanLabel } from "@/lib/calendar/days";
import { formatCalendarDay } from "@/lib/time/zone";
import { cn } from "@/lib/utils";

const CALENDAR_OF = { MICROSOFT: "Outlook calendar", GOOGLE: "Google Calendar", ZOHO: "Zoho Calendar" } as const;
const HOUR_PX = 48;
const MINUTE = 60_000;
/** A page opened after this long without a sync asks for one. */
const STALE_MS = 2 * MINUTE;

const RESPONSE: Record<string, string> = { accepted: "accepted", declined: "declined", tentative: "maybe", none: "hasn't replied" };

function ago(iso: string | null, now: number): string {
  if (!iso) return "not synced yet";
  const minutes = Math.round((now - new Date(iso).getTime()) / MINUTE);
  if (minutes < 1) return "synced just now";
  if (minutes < 60) return `synced ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `synced ${hours} h ago` : "synced over a day ago";
}

/**
 * A person's own calendar, a week at a time (a day at a time down the page on a phone) or as the next
 * fortnight's list. Opened after a while away, it asks for a sync and shows what came back.
 */
export function CalendarBoard({
  summary,
  events,
  firstDay,
  days,
  view,
  today,
  canSchedule,
}: {
  summary: CalendarSummary;
  events: MyEvent[];
  firstDay: string;
  days: number;
  view: "week" | "agenda";
  today: string;
  /** Holds "Schedule meetings": the button, and Reschedule on their own meetings. */
  canSchedule: boolean;
}) {
  const router = useRouter();
  const clock = useClock();
  const [open, setOpen] = useState<MyEvent | null>(null);
  const [syncing, startSync] = useTransition();
  const [syncError, setSyncError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const ready = summary.state === "ready";
  const lastSynced = summary.state === "ready" ? summary.lastSyncedAt : null;

  function sync() {
    setSyncError(null);
    startSync(async () => {
      const done = await syncMyCalendar();
      if (!done.ok) setSyncError(done.error);
      setNow(Date.now());
      router.refresh();
    });
  }

  // Back after a while: bring the calendar up to date once, quietly.
  const asked = useRef(false);
  useEffect(() => {
    if (!ready || asked.current) return;
    if (lastSynced && Date.now() - new Date(lastSynced).getTime() < STALE_MS) return;
    asked.current = true;
    syncMyCalendar().then((done) => {
      setNow(Date.now());
      if (done.ok) router.refresh();
    });
  }, [ready, lastSynced, router]);

  const keys = Array.from({ length: days }, (_, i) => addDays(firstDay, i));
  const last = keys[keys.length - 1]!;
  const step = view === "week" ? 7 : 14;
  const href = (week: string, v = view) => `/calendar?week=${week}${v === "agenda" ? "&view=agenda" : ""}`;
  const onDay = (key: string) => events.filter((e) => (e.allDay ? e.startsAt.slice(0, 10) <= key && key < e.endsAt.slice(0, 10) : clock.dateKey(new Date(e.startsAt)) <= key && key <= clock.dateKey(new Date(new Date(e.endsAt).getTime() - 1))));

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Calendar</h1>
          <p className="mt-1 text-sm text-muted">
            {summary.state === "ready" ? (
              <>
                Your {CALENDAR_OF[summary.provider]} · {summary.mailbox} · {syncing ? "syncing…" : ago(summary.lastSyncedAt, now)}
              </>
            ) : (
              "Your own calendar, kept in step with Outlook, Google Calendar or Zoho Calendar."
            )}
          </p>
          {(syncError || (summary.state === "ready" && summary.lastError)) && <p className="mt-1 text-xs text-warning">{syncError ?? (summary.state === "ready" ? summary.lastError : null)}</p>}
        </div>
        {ready && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" onClick={sync} disabled={syncing} aria-label="Sync now">
              <RefreshCw className={cn("h-3.5 w-3.5", syncing && "animate-spin")} />
              Sync
            </Button>
            {canSchedule && <ScheduleMeetingButton record={null} variant="primary" />}
          </div>
        )}
      </div>

      {!ready && summary.state !== "broken" ? (
        <div className="mt-6">
          <CalendarNotice summary={summary} />
        </div>
      ) : (
        <>
          {summary.state === "broken" && (
            <div className="mt-4">
              <CalendarNotice summary={summary} compact />
            </div>
          )}
          <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <Link href={href(addDays(firstDay, -step))} aria-label={view === "week" ? "Previous week" : "Earlier"} className="rounded-lg p-1.5 text-muted hover:bg-surface-sunken hover:text-text">
                <ChevronLeft className="h-4 w-4" />
              </Link>
              <Link href={href(today)} className="rounded-lg border border-line px-2.5 py-1 text-xs text-text hover:bg-surface-sunken">
                Today
              </Link>
              <Link href={href(addDays(firstDay, step))} aria-label={view === "week" ? "Next week" : "Later"} className="rounded-lg p-1.5 text-muted hover:bg-surface-sunken hover:text-text">
                <ChevronRight className="h-4 w-4" />
              </Link>
              <span className="ml-2 text-sm font-medium text-text">{spanLabel(firstDay, last)}</span>
            </div>
            <div className="flex rounded-lg border border-line p-0.5 text-xs" role="group" aria-label="View">
              <Link href={href(firstDay, "week")} aria-current={view === "week" ? "page" : undefined} className={cn("rounded-md px-2.5 py-1", view === "week" ? "bg-surface-sunken text-text" : "text-muted hover:text-text")}>
                Week
              </Link>
              <Link href={href(firstDay, "agenda")} aria-current={view === "agenda" ? "page" : undefined} className={cn("rounded-md px-2.5 py-1", view === "agenda" ? "bg-surface-sunken text-text" : "text-muted hover:text-text")}>
                Agenda
              </Link>
            </div>
          </div>

          {view === "week" && (
            <div className="mt-3 hidden md:block">
              <WeekGrid keys={keys} today={today} onDay={onDay} onOpen={setOpen} />
            </div>
          )}
          <div className={cn("mt-3", view === "week" && "md:hidden")}>
            <Agenda keys={keys} today={today} onDay={onDay} onOpen={setOpen} />
          </div>
        </>
      )}

      {open && <EventDetails event={open} now={now} canReschedule={canSchedule} onClose={() => setOpen(null)} />}
    </div>
  );
}

type DayProps = { keys: string[]; today: string; onDay: (key: string) => MyEvent[]; onOpen: (e: MyEvent) => void };

function EventChip({ e, onOpen, className, style }: { e: MyEvent; onOpen: (e: MyEvent) => void; className?: string; style?: React.CSSProperties }) {
  const clock = useClock();
  return (
    <button
      type="button"
      onClick={() => onOpen(e)}
      style={style}
      className={cn(
        "overflow-hidden rounded-md border px-1.5 py-0.5 text-left text-[11px] leading-tight",
        e.status === "CANCELLED" ? "border-line bg-surface-sunken text-subtle line-through" : e.record ? "border-brand/40 bg-brand-subtle text-brand" : "border-line-strong bg-surface text-text",
        className,
      )}
      title={e.title}
    >
      <span className="block truncate font-medium">{e.title}</span>
      {!e.allDay && <span className="block truncate opacity-80">{clock.time(e.startsAt)}</span>}
    </button>
  );
}

/** Seven columns of a day each, scrolled to the working day; overlapping events side by side. */
function WeekGrid({ keys, today, onDay, onOpen }: DayProps) {
  const clock = useClock();
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 7 * HOUR_PX;
  }, []);
  const allDay = keys.map((k) => onDay(k).filter((e) => e.allDay));
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <div className="grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))] border-b border-line">
        <div />
        {keys.map((k) => (
          <div key={k} className={cn("border-l border-line px-2 py-1.5 text-xs", k === today ? "font-semibold text-brand" : "text-muted")}>
            {dayLabel(k)}
          </div>
        ))}
      </div>
      {allDay.some((x) => x.length) && (
        <div className="grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))] border-b border-line">
          <div className="px-1 py-1 text-[10px] text-subtle">All day</div>
          {allDay.map((list, i) => (
            <div key={keys[i]} className="space-y-0.5 border-l border-line p-0.5">
              {list.map((e) => (
                <EventChip key={e.id} e={e} onOpen={onOpen} className="w-full" />
              ))}
            </div>
          ))}
        </div>
      )}
      <div ref={scroller} className="max-h-[36rem] overflow-y-auto">
        <div className="relative grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))]" style={{ height: 24 * HOUR_PX }}>
          <div className="relative">
            {Array.from({ length: 24 }, (_, h) => (
              <span key={h} className="absolute right-1.5 -translate-y-1/2 text-[10px] text-subtle" style={{ top: h * HOUR_PX }}>
                {h === 0 ? "" : h < 12 ? `${h} am` : h === 12 ? "12 pm" : `${h - 12} pm`}
              </span>
            ))}
          </div>
          {keys.map((k) => {
            const start = clock.startOfDay(k)!.getTime();
            const timed = onDay(k).filter((e) => !e.allDay).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
            // Lanes: each event takes the first lane free when it starts.
            const ends: number[] = [];
            const lanes = timed.map((e) => {
              const s = new Date(e.startsAt).getTime();
              let lane = ends.findIndex((end) => end <= s);
              if (lane < 0) lane = ends.length;
              ends[lane] = new Date(e.endsAt).getTime();
              return lane;
            });
            const width = 100 / Math.max(1, ends.length);
            return (
              <div key={k} className={cn("relative border-l border-line", k === today && "bg-brand/[0.03]")}>
                {Array.from({ length: 24 }, (_, h) => (
                  <span key={h} className="absolute inset-x-0 border-t border-line/70" style={{ top: h * HOUR_PX }} aria-hidden />
                ))}
                {timed.map((e, i) => {
                  const from = Math.max(0, (new Date(e.startsAt).getTime() - start) / MINUTE);
                  const to = Math.min(24 * 60, (new Date(e.endsAt).getTime() - start) / MINUTE);
                  return (
                    <EventChip
                      key={e.id}
                      e={e}
                      onOpen={onOpen}
                      className="absolute"
                      style={{ top: (from / 60) * HOUR_PX, height: Math.max(18, ((to - from) / 60) * HOUR_PX - 2), left: `calc(${lanes[i]! * width}% + 2px)`, width: `calc(${width}% - 4px)` }}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Day by day, only the days with something on. */
function Agenda({ keys, today, onDay, onOpen }: DayProps) {
  const clock = useClock();
  const withEvents = keys.map((k) => ({ k, list: onDay(k) })).filter((d) => d.list.length > 0);
  if (!withEvents.length) return <p className="rounded-xl border border-line bg-surface py-10 text-center text-sm text-muted">Nothing in your calendar these days.</p>;
  return (
    <div className="space-y-4">
      {withEvents.map(({ k, list }) => (
        <section key={k}>
          <h2 className={cn("mb-1.5 text-xs font-semibold uppercase tracking-wide", k === today ? "text-brand" : "text-subtle")}>
            {k === today ? "Today · " : ""}
            {dayLabel(k, true)}
          </h2>
          <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
            {list.map((e) => (
              <li key={e.id}>
                <button type="button" onClick={() => onOpen(e)} className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-surface-sunken">
                  <span className="w-28 shrink-0 text-xs text-muted">{e.allDay ? "All day" : `${clock.time(e.startsAt)} – ${clock.time(e.endsAt)}`}</span>
                  <span className="min-w-0 flex-1">
                    <span className={cn("block truncate text-sm text-text", e.status === "CANCELLED" && "text-subtle line-through")}>{e.title}</span>
                    {e.record && <span className="block truncate text-xs text-brand">{e.record.label}</span>}
                  </span>
                  {e.joinUrl && e.status !== "CANCELLED" && <Video className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-label="Has a meeting link" />}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function EventDetails({ event: e, now, canReschedule, onClose }: { event: MyEvent; now: number; canReschedule: boolean; onClose: () => void }) {
  const clock = useClock();
  const upcoming = new Date(e.endsAt).getTime() > now;
  const when = e.allDay
    ? formatCalendarDay(e.startsAt) === formatCalendarDay(new Date(new Date(e.endsAt).getTime() - 1))
      ? `${formatCalendarDay(e.startsAt)}, all day`
      : `${formatCalendarDay(e.startsAt)} – ${formatCalendarDay(new Date(new Date(e.endsAt).getTime() - 1))}`
    : `${clock.dateTime(e.startsAt)} – ${clock.time(e.endsAt)}`;
  return (
    <Dialog open onClose={onClose} title={e.title}>
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-text">{when}</span>
          {e.status === "CANCELLED" && <Badge tone="red">Cancelled</Badge>}
          {e.status === "TENTATIVE" && <Badge tone="amber">Tentative</Badge>}
        </div>
        {e.location && <p className="text-muted">{e.location}</p>}
        {e.joinUrl && e.status !== "CANCELLED" && upcoming && (
          <OutboundLink href={e.joinUrl} className="inline-flex items-center gap-1.5 font-medium text-brand hover:underline">
            <Video className="h-4 w-4" aria-hidden /> Join the meeting
          </OutboundLink>
        )}
        {e.record && (
          <p>
            For{" "}
            <Link href={e.record.href} className="text-brand hover:underline" onClick={onClose}>
              {e.record.label}
            </Link>
          </p>
        )}
        {e.organizerEmail && <p className="text-xs text-subtle">Organised by {e.isOrganizer ? "you" : e.organizerEmail}</p>}
        {e.attendees.length > 0 && (
          <ul className="space-y-0.5 text-xs text-muted">
            {e.attendees.map((a) => (
              <li key={a.email}>
                {a.name ?? a.email}
                {a.name && <span className="text-subtle"> · {a.email}</span>}
                {a.response && <span className="text-subtle"> — {RESPONSE[a.response] ?? a.response}</span>}
              </li>
            ))}
          </ul>
        )}
        {e.description && <p className="whitespace-pre-line text-xs text-muted">{e.description}</p>}
        {e.isOrganizer && upcoming && e.status !== "CANCELLED" && !e.allDay && (
          <div className="border-t border-line pt-3">
            <MeetingActions eventId={e.id} title={e.title} canReschedule={canReschedule} />
          </div>
        )}
      </div>
    </Dialog>
  );
}

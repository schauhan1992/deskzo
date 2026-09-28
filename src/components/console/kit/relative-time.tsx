"use client";

import { useSyncExternalStore } from "react";
import { istDaysBetween, plural } from "@/lib/console-shared/format";
import { formatIstDate, formatIstDateTime } from "@/lib/india-time";

/**
 * "3 min ago" / "in 2 days", with the exact India time in the tooltip.
 *
 * The server does not know the reader's clock, so the server render (and the hydration render that
 * must match it) is the absolute IST text; the relative wording arrives after mount. The clock is one
 * module-level store that ticks once a minute for every `RelativeTime` on the page — a list of 200
 * rows runs one interval, not 200, and nothing reads `Date.now()` while rendering.
 */

const MINUTE = 60_000;
const DAY = 86_400_000;

let minute: number | null = null;
let timer: number | null = null;
const listeners = new Set<() => void>();

function tick() {
  minute = Math.floor(Date.now() / MINUTE) * MINUTE;
  for (const listener of listeners) listener();
}

function onVisibility() {
  // A hidden tab's interval is throttled; catch up the moment it is looked at again.
  if (document.visibilityState === "visible") tick();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (timer === null) {
    minute = Math.floor(Date.now() / MINUTE) * MINUTE;
    timer = window.setInterval(tick, MINUTE);
    document.addEventListener("visibilitychange", onVisibility);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      window.clearInterval(timer);
      timer = null;
      document.removeEventListener("visibilitychange", onVisibility);
    }
  };
}

const getSnapshot = () => minute;
const getServerSnapshot = () => null;

/** "just now", "12 min ago", "in 3 h", "5 days ago", "in 2 months", "1 year ago". */
function relativeText(at: number, now: number): string {
  const diff = at - now;
  const future = diff > 0;
  const ms = Math.abs(diff);
  if (ms < MINUTE) return "just now";
  let amount: string;
  if (ms < 60 * MINUTE) amount = `${Math.floor(ms / MINUTE)} min`;
  else if (ms < DAY) amount = `${Math.floor(ms / (60 * MINUTE))} h`;
  else if (ms < 45 * DAY) amount = plural(Math.floor(ms / DAY), "day");
  else if (ms < 365 * DAY) amount = plural(Math.max(1, Math.round(ms / (30 * DAY))), "month");
  else amount = plural(Math.floor(ms / (365 * DAY)), "year");
  return future ? `in ${amount}` : `${amount} ago`;
}

/** A calendar date counts in India's days: "today", "tomorrow", "in 3 days", "2 days ago". */
function relativeDay(at: Date, now: number): string {
  const days = istDaysBetween(new Date(now), at);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (Math.abs(days) >= 45) return relativeText(at.getTime(), now);
  return days > 0 ? `in ${plural(days, "day")}` : `${plural(-days, "day")} ago`;
}

export function RelativeTime({ at, absolute = "datetime", className }: { at: Date | string; absolute?: "datetime" | "date"; className?: string }) {
  const now = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) return <span className={className}>—</span>;

  const exact = absolute === "date" ? formatIstDate(date) : formatIstDateTime(date);
  const text = now === null ? exact : absolute === "date" ? relativeDay(date, now) : relativeText(date.getTime(), now);
  return (
    // The absolute text is replaced right after hydration, and Intl's month names can differ by a
    // letter between the server's ICU and the browser's — not worth a hydration error.
    <time dateTime={date.toISOString()} title={now === null ? undefined : exact} className={className} suppressHydrationWarning>
      {text}
    </time>
  );
}

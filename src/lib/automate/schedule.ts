import { delayMs, LIMITS, type DelayStep, type Schedule } from "@/lib/automate/definition";
import type { Clock } from "@/lib/time/zone";

/**
 * When a schedule fires next, and when a delay ends (Deskzo Automate). Pure. Everything is a
 * wall-clock time on the workspace's own clock, turned into an instant by `Clock.at`, which handles
 * daylight saving: a time a clock change skips moves forward by the gap, and one it repeats is taken
 * the first time. "Every day at 09:00" stays 09:00 there across a change.
 */

const DAY_MS = 86_400_000;
/** A year and a little: enough for any schedule to find its next day. */
const SEARCH_DAYS = 400;

function hm(at: string | undefined, fallback: string): [number, number] {
  const [h, m] = (at ?? fallback).split(":").map(Number);
  return [h ?? 0, m ?? 0];
}

/** The first time this schedule fires strictly after `after`. */
export function nextFire(schedule: Schedule, clock: Clock, after: Date): Date {
  const start = clock.parts(after);
  const allowed = (weekday: number) => !schedule.days || schedule.days.includes(weekday);

  if (schedule.every === "hour") {
    const minute = schedule.minute ?? 0;
    for (let h = 0; h < SEARCH_DAYS * 24; h++) {
      const at = clock.at(start.year, start.month, start.day, start.hour + h, minute);
      if (at.getTime() > after.getTime() && allowed(clock.parts(at).weekday)) return at;
    }
    return new Date(after.getTime() + 3_600_000);
  }

  const [hour, minute] = hm(schedule.at, "09:00");
  for (let d = 0; d < SEARCH_DAYS; d++) {
    const at = clock.at(start.year, start.month, start.day + d, hour, minute);
    if (at.getTime() <= after.getTime()) continue;
    const parts = clock.parts(at);
    if (schedule.every === "day" && !allowed(parts.weekday)) continue;
    if (schedule.every === "week" && parts.weekday !== (schedule.weekday ?? 1)) continue;
    if (schedule.every === "month" && parts.day !== (schedule.dayOfMonth ?? 1)) continue;
    return at;
  }
  return new Date(after.getTime() + DAY_MS);
}

/** When a delay step that starts `from` ends. */
export function delayUntil(step: DelayStep, clock: Clock, from: Date): Date {
  if (step.for) return new Date(from.getTime() + Math.min(delayMs(step.for), LIMITS.delayDays * DAY_MS));
  if (step.until) return nextFire({ every: "day", at: step.until.at, days: step.until.days }, clock, from);
  return from;
}

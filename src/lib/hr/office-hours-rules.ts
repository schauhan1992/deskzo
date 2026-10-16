/**
 * Office hours and what they say about a day (owner, 16 Oct 2026) — pure, for the attendance grid, its
 * settings dialog and the checks alike. The company's hours are minutes from midnight on the
 * workspace's own clock; a clock-in is turned into the same before it's compared.
 *
 *   · Late: in after the start plus the grace.
 *   · Early: out before the end less the grace.
 *   · Overtime: worked longer than the office day by more than half an hour, or the grace if longer.
 *
 * A half day is neither late nor early: it may be either half. A day with no clock-in (marked by HR)
 * says nothing about timing, and counts the office day's hours as worked.
 */

export type OfficeHours = { startMinute: number; endMinute: number; graceMinutes: number };

/** The least overtime worth marking, in minutes. */
export const OVERTIME_AFTER_MINUTES = 30;

/** How long the office day is, in minutes. */
export const officeDayMinutes = (hours: OfficeHours) => hours.endMinute - hours.startMinute;

/** "09:30" as minutes from midnight, or null for anything that isn't a time. */
export function minuteOfTime(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  return h < 24 && m < 60 ? h * 60 + m : null;
}

/** Minutes from midnight as "09:30", for a time input. */
export const timeOfMinute = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

/** Minutes from midnight as people read them: "9:30 am". */
export function clockWordsOfMinute(minute: number): string {
  const h = Math.floor(minute / 60);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(minute % 60).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

/** Hours as typed, or why they can't be kept. */
export function officeHoursOrRefusal(input: { start: string; end: string; grace: unknown }): { ok: true; hours: OfficeHours } | { ok: false; error: string } {
  const startMinute = minuteOfTime(input.start);
  const endMinute = minuteOfTime(input.end);
  if (startMinute === null || endMinute === null) return { ok: false, error: "Give the start and end as times, like 09:30 and 18:30." };
  if (endMinute <= startMinute) return { ok: false, error: "The day has to end after it starts." };
  if (endMinute - startMinute < 60) return { ok: false, error: "An office day is at least an hour." };
  const grace = Number(input.grace);
  if (!Number.isInteger(grace) || grace < 0 || grace > 120) return { ok: false, error: "The grace is whole minutes, from 0 to 120." };
  return { ok: true, hours: { startMinute, endMinute, graceMinutes: grace } };
}

export type DayTiming = { late: boolean; early: boolean; overtime: boolean };
const ON_TIME: DayTiming = { late: false, early: false, overtime: false };

/**
 * What a day's clock-in and clock-out say, against the office hours. `minuteOf` turns an instant into
 * minutes from midnight on the workspace's clock (`clock.parts`).
 */
export function dayTiming(
  day: { status: string | null; checkInAt: Date | string | null; checkOutAt: Date | string | null; workedMinutes: number | null },
  hours: OfficeHours | null,
  minuteOf: (at: Date) => number,
): DayTiming {
  if (!hours || !day.checkInAt) return ON_TIME;
  if (day.status !== "PRESENT" && day.status !== "WORK_FROM_HOME") return ON_TIME;
  const inMinute = minuteOf(new Date(day.checkInAt));
  const outMinute = day.checkOutAt ? minuteOf(new Date(day.checkOutAt)) : null;
  const worked =
    day.workedMinutes ?? (day.checkOutAt ? Math.round((new Date(day.checkOutAt).getTime() - new Date(day.checkInAt).getTime()) / 60_000) : null);
  return {
    late: inMinute > hours.startMinute + hours.graceMinutes,
    early: outMinute !== null && outMinute < hours.endMinute - hours.graceMinutes,
    overtime: worked !== null && worked > officeDayMinutes(hours) + Math.max(OVERTIME_AFTER_MINUTES, hours.graceMinutes),
  };
}

/**
 * The minutes a day counts as worked: what the clock says, or — marked by HR with no clock — the office
 * day, half of it for a half day. Leave, absence and days off count nothing.
 */
export function workedMinutesOf(day: { status: string | null; workedMinutes: number | null }, hours: OfficeHours): number {
  if (day.status === "PRESENT" || day.status === "WORK_FROM_HOME") return day.workedMinutes ?? officeDayMinutes(hours);
  if (day.status === "HALF_DAY") return day.workedMinutes ?? Math.round(officeDayMinutes(hours) / 2);
  return 0;
}

/**
 * Working days, week-offs and holidays — the arithmetic every other part of HR rests on.
 *
 * Pure and date-only on purpose. Everything here deals in calendar days, and the moment a timezone
 * gets involved a leave application submitted at 11pm in India starts counting from the day before.
 */

/** Days the office is closed every week. Saturday/Sunday; 0 = Sunday, 6 = Saturday. */
export const DEFAULT_WEEK_OFFS = [0, 6];

/** A date reduced to its calendar day, at UTC midnight, matching how `@db.Date` stores it. */
export function dateOnly(value: Date | string): Date {
  const d = typeof value === "string" ? new Date(value) : value;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function toKey(value: Date | string): string {
  return dateOnly(value).toISOString().slice(0, 10);
}

export function addDays(value: Date, days: number): Date {
  const d = dateOnly(value);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/** Every calendar day from `from` to `to`, inclusive. */
export function eachDay(from: Date | string, to: Date | string): Date[] {
  const start = dateOnly(from);
  const end = dateOnly(to);
  const days: Date[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  return days;
}

export function isWeekOff(day: Date, weekOffs: number[] = DEFAULT_WEEK_OFFS) {
  return weekOffs.includes(day.getUTCDay());
}

export type HolidayLike = { date: Date | string; optional?: boolean };

/**
 * A lookup of the dates the office is actually closed.
 *
 * Optional (restricted) holidays are excluded: the office is open on those, so somebody who wants
 * one applies for leave like any other day. Counting them as company holidays would hand everybody
 * a dozen free days a year.
 */
export function closedDates(holidays: HolidayLike[]): Set<string> {
  return new Set(holidays.filter((h) => !h.optional).map((h) => toKey(h.date)));
}

export type LeaveSpan = {
  from: Date | string;
  to: Date | string;
  /** Only the afternoon of the first day is taken. */
  fromHalfDay?: boolean;
  /** Only the morning of the last day is taken. */
  toHalfDay?: boolean;
};

export type LeaveDayCount = {
  days: number;
  /** The working days actually consumed, for showing back what was counted. */
  workingDates: string[];
  skipped: { date: string; why: "week off" | "holiday" }[];
};

/**
 * How many days of entitlement a request actually costs.
 *
 * Weekends and holidays inside the span are free — which is the rule almost everywhere, and the
 * thing people most expect a system to get right. A half day at either end takes half off the
 * total, but only if that end is a working day: taking "the afternoon of Saturday" off should not
 * cost anybody half a day of leave.
 */
export function countLeaveDays(
  span: LeaveSpan,
  holidays: HolidayLike[],
  weekOffs: number[] = DEFAULT_WEEK_OFFS,
): LeaveDayCount {
  const closed = closedDates(holidays);
  const all = eachDay(span.from, span.to);
  const workingDates: string[] = [];
  const skipped: LeaveDayCount["skipped"] = [];

  for (const day of all) {
    const key = toKey(day);
    if (isWeekOff(day, weekOffs)) {
      skipped.push({ date: key, why: "week off" });
      continue;
    }
    if (closed.has(key)) {
      skipped.push({ date: key, why: "holiday" });
      continue;
    }
    workingDates.push(key);
  }

  let days = workingDates.length;
  const firstKey = toKey(span.from);
  const lastKey = toKey(span.to);

  if (span.fromHalfDay && workingDates.includes(firstKey)) days -= 0.5;
  // Guarded against double-counting: a single-day request flagged as both halves is one half day,
  // not zero. Somebody ticking both boxes on one date means "half of that day".
  if (span.toHalfDay && workingDates.includes(lastKey) && lastKey !== firstKey) days -= 0.5;

  return { days: Math.max(days, 0), workingDates, skipped };
}

/** Whole calendar days in a month — the denominator a monthly salary is divided by. */
export function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function monthRange(year: number, month: number) {
  return {
    from: new Date(Date.UTC(year, month - 1, 1)),
    to: new Date(Date.UTC(year, month - 1, daysInMonth(year, month))),
  };
}

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function monthLabel(month: number, year: number) {
  return `${MONTH_NAMES[month - 1] ?? month} ${year}`;
}

/**
 * The Indian financial year a date falls in — April to March.
 *
 * Leave quotas, PF returns and Form 16 all run on it, so "2026" here means April 2026 to March 2027.
 */
export function financialYearOf(value: Date | string) {
  const d = dateOnly(value);
  return d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

export function financialYearLabel(year: number) {
  return `FY ${year}-${String((year + 1) % 100).padStart(2, "0")}`;
}

/**
 * India's calendar, whatever clock the server keeps.
 *
 * Every date this business cares about is an Indian one — a financial year, a GST return period,
 * a report for "last September", the day an e-way bill expires. None of them are the server's, and
 * the server is not in India: a container runs as UTC, which puts midnight at half past five in the
 * morning IST.
 *
 * That is not a rounding error, it is five and a half hours of records landing on the wrong side of
 * a boundary, and it has now been found twice in this codebase — once in the e-way validity
 * arithmetic, where every bill was marked expired at 05:30 on its last day, and once in the report
 * window, where "1 to 30 September" began at 05:30 on the 1st and ran into the morning of 1 October.
 *
 * ## Two traps, and the first one bites even in India
 *
 *   · `new Date("2026-09-01")` is **UTC** midnight. A date-only string is always parsed as UTC, so
 *     this is 05:30 IST — wrong on every machine, including one set to Asia/Kolkata. That is the
 *     one people miss, because testing on an Indian laptop does not reveal it.
 *   · `d.getMonth()`, `d.getDate()`, `d.setHours()` read and write the **host's** calendar. These
 *     are right in Pune and wrong in a container, so they fail only in production.
 *
 * Both are avoided by never asking a `Date` what day it is and never building one from local parts.
 * IST is UTC+5:30 with no daylight saving ever, so the offset is a constant rather than a lookup —
 * but it has to be applied deliberately, which is what this module is for.
 */

/** UTC+5:30, and it has never been anything else. */
export const IST_OFFSET_MS = 5.5 * 3600_000;

/** The Indian calendar date a given instant falls on. `month` is 0-based, as `Date` has it. */
export function istDateParts(at: Date): { year: number; month: number; day: number } {
  const shifted = new Date(at.getTime() + IST_OFFSET_MS);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth(), day: shifted.getUTCDate() };
}

/**
 * The instant a given Indian calendar date begins.
 *
 * Day overflow is intentional and relied upon: `istMidnight(2026, 8, 31)` is 1 October, which is how
 * "the end of September" is expressed without special-casing month lengths.
 */
export function istMidnight(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day) - IST_OFFSET_MS);
}

/** `yyyy-mm-dd` as Indian calendar parts, or null if it is not that shape. */
function parseIsoDate(date: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!match) return null;
  const [, y, m, d] = match;
  return { year: Number(y), month: Number(m) - 1, day: Number(d) };
}

/** The moment an Indian day begins — for a date field that is a point rather than a span. */
export function startOfIndianDay(date: string): Date | null {
  const parts = parseIsoDate(date);
  if (!parts) return null;
  const at = istMidnight(parts.year, parts.month, parts.day);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * The moment an Indian day ends: midnight at the *start of the next one*.
 *
 * An exclusive upper bound rather than 23:59:59.999, because a timestamp at 23:59:59.400 is inside
 * the day and a bound of `.999` is a millisecond of hoping nothing lands there. Callers compare with
 * `<` rather than `<=`.
 */
export function endOfIndianDay(date: string): Date | null {
  const parts = parseIsoDate(date);
  if (!parts) return null;
  const at = istMidnight(parts.year, parts.month, parts.day + 1);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * `yyyy-mm-ddThh:mm` — what a `datetime-local` input gives — read as a time in India.
 *
 * The input carries no zone, and `new Date(value)` would read it in whatever zone the process runs
 * in: right on a laptop in Pune, five and a half hours out on a server in UTC. An event at 6:30 pm
 * has to be 6:30 pm wherever the form was saved from.
 */
export function parseIstDateTime(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  if (!match) return null;
  const [y, mo, d, h, mi] = [1, 2, 3, 4, 5].map((i) => Number(match[i])) as [number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const at = new Date(Date.UTC(y, mo - 1, d, h, mi) - IST_OFFSET_MS);
  // 31 February is not a date, and Date.UTC would quietly make it 3 March.
  if (istDateParts(at).day !== d) return null;
  return at;
}

/** The other way: an instant as India wall-clock time, to fill a `datetime-local` input. */
export function istDateTimeInput(at: Date | string | null | undefined): string {
  if (!at) return "";
  const shifted = new Date(new Date(at).getTime() + IST_OFFSET_MS);
  if (Number.isNaN(shifted.getTime())) return "";
  return shifted.toISOString().slice(0, 16);
}

/** "Thu, 15 Oct 2026, 6:30 pm" in India time, whatever zone the server or the reader is in. */
export function formatIstDateTime(at: Date | string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(at));
}

/** "15 Oct 2026" in India time — the day something happened, where the hour is noise. */
export function formatIstDate(at: Date | string): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" }).format(new Date(at));
}

/** "6:30 pm" in India time — the end of an event that starts and finishes on one day. */
export function formatIstTime(at: Date | string): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" }).format(new Date(at));
}

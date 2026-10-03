import { indiaClock } from "@/lib/time/zone";

/**
 * India's statutory calendar: the dates the law ties to India time whatever zone a workspace keeps — the
 * financial year (April to March), the month a GST or TDS return is filed for. E-way bill validity,
 * e-invoice dates and the books read India's clock too: `indiaClock` (src/lib/time/zone.ts).
 *
 * Every other date — a list's days, a visit's time, "today" — is the workspace's own (owner, 2 Oct 2026):
 * `workspaceClock()` on the server, `useClock()` in a client component. This module's day and time helpers
 * became the clock's methods there.
 *
 * ## Two traps, and the first one bites even in India
 *
 *   · `new Date("2026-09-01")` is **UTC** midnight. A date-only string is always parsed as UTC, so
 *     this is 05:30 IST — wrong on every machine, including one set to Asia/Kolkata.
 *   · `d.getMonth()`, `d.getDate()`, `d.setHours()` read and write the **host's** calendar. These
 *     are right in Pune and wrong in a container, so they fail only in production.
 *
 * Both are avoided by never asking a `Date` what day it is and never building one from local parts.
 */

/** The day a `@db.Date` value holds, as midnight UTC — normalised in case it arrives with a time on it. */
export function calendarDateOf(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

/**
 * The Indian month before the one an instant falls in, as a monthly return names it: `month` 1–12.
 * The default period of the GST, TDS and depreciation screens — last month is the one being filed.
 * Built from India's calendar: `new Date(y, m − 1, 1)` on the host's put a server in UTC a month
 * behind until 05:30 IST on the 1st.
 */
export function previousIstMonth(at: Date): { month: number; year: number } {
  const { year, month } = indiaClock.parts(at);
  return month === 0 ? { month: 12, year: year - 1 } : { month, year };
}

/** The calendar year the Indian financial year containing an instant starts in: April onwards is that year's. */
export function financialYearStartOf(at: Date): number {
  const { year, month } = indiaClock.parts(at);
  return month >= 3 ? year : year - 1;
}

/**
 * The financial year that starts in April of `startYear`, half-open: 1 April 00:00 IST up to, not
 * including, the next 1 April 00:00 IST. Every entry dated 31 March in India is inside it — payroll
 * and depreciation at 12:00 UTC, an invoice at 23:30 IST — and nothing of April is.
 */
export function financialYearWindow(startYear: number): { from: Date; to: Date; label: string } {
  return {
    from: indiaClock.midnight(startYear, 3, 1),
    to: indiaClock.midnight(startYear + 1, 3, 1),
    label: `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`,
  };
}

/**
 * The Indian financial year runs April to March, so "this year" on a report is almost never the
 * calendar year — defaulting to one would quietly give people the wrong period.
 *
 * Read on India's calendar. It used the host's (`getMonth`), so on a server in UTC anything between
 * midnight and 05:30 IST on 1 April was still last year.
 */
export function financialYearBounds(date: Date) {
  const year = financialYearStartOf(date);
  return {
    from: `${year}-04-01`,
    to: `${year + 1}-03-31`,
    label: `${year}-${String((year + 1) % 100).padStart(2, "0")}`,
  };
}

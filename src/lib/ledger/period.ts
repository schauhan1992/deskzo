import { calendarDateOf, financialYearStartOf, financialYearWindow } from "@/lib/india-time";
import { indiaClock } from "@/lib/time/zone";

/**
 * The Indian financial year a date falls in, as `yyyy-mm-dd` strings and a label. It lives in
 * src/lib/india-time.ts with the rest of India's calendar; the ledger's callers keep importing it
 * from here.
 */
export { financialYearBounds } from "@/lib/india-time";

/**
 * Whether an entry dated `date` falls in books closed to `lockedUntil`.
 *
 * By calendar day in India — in every workspace, as the books keep India's calendar — not by instant.
 * `lockedUntil` is a `@db.Date`, which reads back as midnight UTC, and payroll and depreciation date
 * their entries 12:00 UTC on the month's last day — so comparing the two instants let a September
 * payroll through a lock set to 30 September. The entry's day is its Indian date (01:00 IST on
 * 1 October is October's), the lock's is the date it holds, and a day on or before the lock is closed.
 */
export function isLockedDate(date: Date, lockedUntil: Date | null | undefined): boolean {
  if (!lockedUntil) return false;
  return indiaClock.calendarDate(date).getTime() <= calendarDateOf(lockedUntil).getTime();
}

/**
 * Where an entry that belongs on `date` can go: `date` itself while it is open, otherwise the
 * first open day after the lock — dated 12:00 UTC (17:30 IST), which is that day whichever clock
 * reads it, as payroll and depreciation are.
 */
export function firstOpenDate(date: Date, lockedUntil: Date | null | undefined): Date {
  if (!lockedUntil || !isLockedDate(date, lockedUntil)) return date;
  const lock = calendarDateOf(lockedUntil);
  return new Date(Date.UTC(lock.getUTCFullYear(), lock.getUTCMonth(), lock.getUTCDate() + 1, 12));
}

/**
 * The dates a year is closed under, from the calendar year it starts in.
 *
 * Two kinds, deliberately. `fromDate` and `toDate` are calendar days — 1 April and 31 March — for the
 * `@db.Date` columns: the close record and the lock set to the year end. `from` and `to` are the
 * instants the closing entry sums between, half-open in India time, so everything dated 31 March in
 * India is in and nothing of April is. `closingDate` is 31 March at 12:00 UTC (17:30 IST): inside the
 * year, and the same calendar day whichever clock reads it.
 */
export function yearEndDates(startYear: number) {
  const window = financialYearWindow(startYear);
  return {
    label: window.label,
    fromDate: new Date(Date.UTC(startYear, 3, 1)),
    toDate: new Date(Date.UTC(startYear + 1, 2, 31)),
    from: window.from,
    to: window.to,
    closingDate: new Date(Date.UTC(startYear + 1, 2, 31, 12)),
  };
}

/** The calendar year a label like "2025-26" starts in, or null when it doesn't read like one. */
export function startYearOf(label: string): number | null {
  const match = /^(\d{4})-(\d{2})$/.exec(label.trim());
  return match ? Number(match[1]) : null;
}

/**
 * Month names, kept here rather than beside the picker that uses them.
 *
 * A helper exported from a `"use client"` module can only be called from the client: the server
 * gets a reference it cannot invoke, which compiles fine and throws on the first request. Anything
 * both sides need has to live in a plain module like this one.
 */
/**
 * The financial years the books screen offers to close at `now`: the `count` before the one in
 * progress, oldest last, less those already closed. Each is over at 1 April 00:00 IST.
 *
 * On India's calendar. The screen counted back from the host's calendar year and called a year over at
 * midnight UTC on 31 March — 05:30 IST — so on the evening of 31 March it offered a close the server
 * refuses ("the year isn't over yet"), and from January to March it offered one year fewer.
 */
export function closableYears(now: Date, closed: ReadonlySet<string>, count = 5): string[] {
  const current = financialYearStartOf(now);
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const year = financialYearWindow(current - 1 - i);
    if (year.to.getTime() <= now.getTime() && !closed.has(year.label)) out.push(year.label);
  }
  return out;
}

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

export function monthName(month: number) {
  return MONTH_NAMES[month - 1] ?? String(month);
}

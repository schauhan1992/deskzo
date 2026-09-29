import { istDateParts, istMidnight, istCalendarDate } from "@/lib/india-time";

/**
 * The month-end close's calendar: months, their bounds, and the working days a checklist falls due on.
 *
 * Pure — no database, no clock of its own (every "now" is passed in) — so check:close-core can pin
 * every boundary with an explicit +05:30 instant, and the answers are the same whatever zone the
 * server keeps.
 *
 * Two kinds of date, deliberately, as in src/lib/ledger/period.ts:
 *
 *   · **Calendar days**, held the way a `@db.Date` column holds them: midnight UTC of that day. A
 *     month is its 1st (`CloseMonth.month`, `CloseTask.month`, every schedule's `month`); a month end
 *     is its last day (`LedgerLock.lockedUntil`, a task's `dueOn`). Their weekday and parts are read
 *     with the UTC getters, which is exactly the calendar day they name — no zone is involved.
 *   · **Instants**, for comparing timestamps: a month's window is 1st 00:00 IST up to, not including,
 *     the next 1st 00:00 IST (half-open, india-time.ts). An invoice at 23:30 IST on 30 September is
 *     September's; one at 00:10 IST on 1 October is not.
 *
 * Entries the close posts are dated 12:00 UTC (17:30 IST) on their day — the month's last, or an
 * accrual reversal's 1st — which is that day whichever clock reads it, as payroll and depreciation are.
 */

/** "2026-09": how a month travels between the screens and the actions. */
export type MonthKey = string;

/** The month starting on the 1st of `month0` (0-based) in `year`, as a `@db.Date` holds it. */
export function monthStart(year: number, month0: number): Date {
  return new Date(Date.UTC(year, month0, 1));
}

/** `2026-09` → the 1st of September 2026, or null when it isn't a month. */
export function parseMonthKey(key: string | null | undefined): Date | null {
  const match = /^(\d{4})-(\d{2})$/.exec((key ?? "").trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12 || year < 2000 || year > 2200) return null;
  return monthStart(year, month - 1);
}

/** A month (or any calendar day in it) → `2026-09`. Read by its UTC parts: it is a calendar date. */
export function monthKeyOf(month: Date): MonthKey {
  return `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The 1st of the month a calendar date (a `@db.Date` value) falls in. */
export function monthOfDate(date: Date): Date {
  return monthStart(date.getUTCFullYear(), date.getUTCMonth());
}

/** The Indian month an instant falls in, as its 1st. 00:10 IST on 1 October is October's. */
export function monthOfInstant(at: Date): Date {
  const { year, month } = istDateParts(at);
  return monthStart(year, month);
}

/** Whole months later (or earlier, with a negative `n`). */
export function addMonths(month: Date, n: number): Date {
  return monthStart(month.getUTCFullYear(), month.getUTCMonth() + n);
}

/** Months from `a` to `b`: 0 for the same month, 1 when `b` is the next. */
export function monthsBetween(a: Date, b: Date): number {
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
}

/** The month's instants in India, half-open: `gte: from, lt: to`. */
export function monthWindow(month: Date): { from: Date; to: Date } {
  const y = month.getUTCFullYear();
  const m = month.getUTCMonth();
  return { from: istMidnight(y, m, 1), to: istMidnight(y, m + 1, 1) };
}

/** The month's last calendar day, as a `@db.Date` holds it — what the lock is set to when it closes. */
export function monthEnd(month: Date): Date {
  return new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0));
}

/** The date an entry for the month is written on: its last day, 12:00 UTC (17:30 IST). */
export function monthEndPostingDate(month: Date): Date {
  return new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0, 12));
}

/** The date an accrual's reversal is written on: the 1st of the next month, 12:00 UTC. */
export function nextMonthFirstPostingDate(month: Date): Date {
  return new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1, 12));
}

/** The 1st of the month at 12:00 UTC — a prepaid's reclass when no bill gives it a date. */
export function monthFirstPostingDate(month: Date): Date {
  return new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1, 12));
}

/** Today in India, as a calendar day. */
export function indiaToday(now: Date): Date {
  return istCalendarDate(now);
}

/** The month India is in now. */
export function currentMonth(now: Date): Date {
  return monthOfInstant(now);
}

/**
 * The last month that has ended in India: September from 00:00 IST on 1 October. What the nightly job
 * posts through and generates a checklist for.
 */
export function lastCompletedMonth(now: Date): Date {
  return addMonths(currentMonth(now), -1);
}

/** A calendar day `n` days later. */
export function addDays(date: Date, n: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + n));
}

/** Two calendar days (or a day and the lock) by day only. */
export function sameDay(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
}

/** Monday to Friday. Holidays are not known here; a template's due day counts weekdays only. */
export function isWorkingDay(date: Date): boolean {
  const day = date.getUTCDay();
  return day >= 1 && day <= 5;
}

/**
 * The `n`th working day of a month. A month has 20 to 23 of them, so a larger `n` (a template's due
 * day may be up to 31) means the last one rather than spilling into the month after.
 */
export function workingDayOfMonth(month: Date, n: number): Date {
  const wanted = Math.max(1, Math.floor(n));
  const last = monthEnd(month);
  let found: Date | null = null;
  let count = 0;
  for (let d = monthStart(month.getUTCFullYear(), month.getUTCMonth()); d <= last; d = addDays(d, 1)) {
    if (!isWorkingDay(d)) continue;
    count += 1;
    found = d;
    if (count === wanted) return d;
  }
  return found ?? last;
}

/** When a month's task falls due: the template's `dueDay`th working day of the month after it. */
export function dueOnFor(month: Date, dueDay: number): Date {
  return workingDayOfMonth(addMonths(month, 1), dueDay);
}

const LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "September 2026", or "Sep 2026" short. */
export function monthLabel(month: Date, style: "long" | "short" = "long"): string {
  const names = style === "long" ? LONG : SHORT;
  return `${names[month.getUTCMonth()]} ${month.getUTCFullYear()}`;
}

/** Just the month's name, for a button: "Close September". */
export function monthName(month: Date): string {
  return LONG[month.getUTCMonth()]!;
}

/** `yyyy-mm-dd` of a calendar day. */
export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

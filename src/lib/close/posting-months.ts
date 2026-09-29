import { firstOpenDate, isLockedDate } from "@/lib/ledger/period";
import { indiaToday, monthEndPostingDate, monthOfDate, nextMonthFirstPostingDate } from "@/lib/close/months";

/**
 * Where a scheduled month's posting goes, and on what date — the catch-up rule the revenue run and the
 * prepaid/accrual run share (spec §3.5, §4.3).
 *
 *   · A month that is still open posts in itself, dated its last day (12:00 UTC, as payroll and
 *     depreciation are — the same calendar day under any clock).
 *   · A month already closed posts in the **first open month** instead, flagged `catchUp`: the figure
 *     is late, not lost, and a closed month's trial balance does not move.
 *   · Never after today and never into the lock: when the first open month is the one in progress, its
 *     catch-up is dated today rather than a month end still to come; and a date the lock covers moves
 *     to the first open day.
 *
 * Pure: the lock and "now" are passed in, so check:close-core pins every case.
 */

/** The month a scheduled month posts in, and whether that is a catch-up. */
export function postingMonthFor(month: Date, lockedUntil: Date | null | undefined): { postingMonth: Date; catchUp: boolean } {
  const own = monthEndPostingDate(month);
  if (!isLockedDate(own, lockedUntil)) return { postingMonth: month, catchUp: false };
  return { postingMonth: monthOfDate(firstOpenDate(own, lockedUntil)), catchUp: true };
}

/** Today in India at 12:00 UTC — how a date "today" is written on an entry. */
export function todayPostingDate(now: Date): Date {
  const today = indiaToday(now);
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 12));
}

/**
 * The date a posting month's entry is written on: its last day — or today, when that day is still to
 * come — and never inside the lock.
 */
export function postingDateFor(postingMonth: Date, lockedUntil: Date | null | undefined, now: Date): Date {
  const end = monthEndPostingDate(postingMonth);
  const today = todayPostingDate(now);
  const date = end.getTime() > today.getTime() ? today : end;
  return firstOpenDate(date, lockedUntil);
}

/**
 * An accrual's reversal: the 1st of the month after its own — or the first open day when that is
 * closed — and never before the accrual itself, so a catch-up accrual and its reversal land together.
 */
export function reversalDateFor(month: Date, entryDate: Date, lockedUntil: Date | null | undefined): Date {
  const natural = firstOpenDate(nextMonthFirstPostingDate(month), lockedUntil);
  return natural.getTime() < entryDate.getTime() ? entryDate : natural;
}

/** A date a person or the job asks for "now": today, unless the lock covers it. */
export function openDateToday(lockedUntil: Date | null | undefined, now: Date): Date {
  return firstOpenDate(todayPostingDate(now), lockedUntil);
}

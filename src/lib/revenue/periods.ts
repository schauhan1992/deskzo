import { isLockedDate } from "@/lib/ledger/period";
import { calendarDateOf, istDateKey, istDateParts } from "@/lib/india-time";

/**
 * Revenue recognition's calendar and arithmetic (Ind AS 115): which invoice lines are earned over
 * time, and how much of each falls in each month.
 *
 * Pure — no database and no clock of its own (every "now" is passed in) — so check:revenue-core can
 * pin every boundary with an explicit +05:30 instant, and the answers are the same whatever zone the
 * server keeps.
 *
 * ## Two kinds of date, deliberately
 *
 *   · **Days and months are Indian calendar dates, held as strings**: a day is `2026-09-15`, a month
 *     `2026-09`. A service period's ends are `@db.Date` columns, which read back as midnight UTC of
 *     the day they name, so a `Date` handed in as a period end is read by its UTC parts (`dayKeyOf`)
 *     — that is the calendar day, whatever the server's zone.
 *   · **Instants** — an invoice's issue date, a milestone's completion, "now" — are turned into the
 *     Indian day they fall on (`dayKeyAt`) before anything is compared. 00:10 IST on 1 October is
 *     October's, although it is still 30 September in UTC.
 *
 * ## Money
 *
 * Every figure is rounded to the paisa, and a split is done in whole paise so the parts add up to the
 * whole exactly: a ₹1,20,000 year is never ₹1,19,999.99 over its twelve months (`allocate`).
 */

/** `2026-09`: a month, as the screens, the actions and this module pass it around. */
export type MonthKey = string;
/** `2026-09-15`: an Indian calendar day. */
export type DayKey = string;
/** One month of a spread. */
export type MonthAmount = { month: MonthKey; amount: number };

export const round2 = (n: number) => Math.round(n * 100) / 100;

const DAY_MS = 86_400_000;
const MONTH_KEY = /^(\d{4})-(\d{2})$/;
const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ─── Days and months ─────────────────────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, "0");

function monthParts(month: MonthKey): { year: number; month0: number } {
  const match = MONTH_KEY.exec(month);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) throw new RangeError(`"${month}" is not a month (yyyy-mm).`);
  return { year: Number(match[1]), month0: Number(match[2]) - 1 };
}

function dayParts(day: DayKey): { year: number; month0: number; day: number } {
  const match = DAY_KEY.exec(day);
  if (!match) throw new RangeError(`"${day}" is not a day (yyyy-mm-dd).`);
  const [year, month0, d] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const at = new Date(Date.UTC(year, month0, d));
  // 31 February is not a day, and Date.UTC would quietly make it 3 March.
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month0 || at.getUTCDate() !== d) {
    throw new RangeError(`"${day}" is not a calendar day.`);
  }
  return { year, month0, day: d };
}

export function isMonthKey(value: unknown): value is MonthKey {
  if (typeof value !== "string" || !MONTH_KEY.test(value)) return false;
  const m = Number(value.slice(5, 7));
  return m >= 1 && m <= 12;
}

export function isDayKey(value: unknown): value is DayKey {
  if (typeof value !== "string") return false;
  try {
    dayParts(value);
    return true;
  } catch {
    return false;
  }
}

/** The calendar day a `@db.Date` value holds (midnight UTC of that day), read by its UTC parts. */
export function dayKeyOf(date: Date): DayKey {
  const d = calendarDateOf(date);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** The Indian calendar day an instant falls on. */
export function dayKeyAt(instant: Date): DayKey {
  return istDateKey(instant);
}

/** A period end as a day: a `yyyy-mm-dd` string as it is, a `@db.Date` value by its UTC parts. */
export function asDayKey(value: DayKey | Date): DayKey {
  if (typeof value === "string") {
    dayParts(value);
    return value;
  }
  return dayKeyOf(value);
}

export function monthOfDay(day: DayKey): MonthKey {
  return day.slice(0, 7);
}

/** The month a `@db.Date` value (a month's 1st, or any day in it) falls in. */
export function monthKeyOfDate(date: Date): MonthKey {
  return monthOfDay(dayKeyOf(date));
}

/** The Indian month an instant falls in. 00:10 IST on 1 October is October's. */
export function monthKeyAt(instant: Date): MonthKey {
  const { year, month } = istDateParts(instant);
  return `${year}-${pad(month + 1)}`;
}

export function addMonths(month: MonthKey, n: number): MonthKey {
  const { year, month0 } = monthParts(month);
  const at = new Date(Date.UTC(year, month0 + n, 1));
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}`;
}

/** Every month from `from` to `to`, both included; empty when `to` is before `from`. */
export function monthsBetween(from: MonthKey, to: MonthKey): MonthKey[] {
  const out: MonthKey[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

export function daysInMonth(month: MonthKey): number {
  const { year, month0 } = monthParts(month);
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

export function firstDay(month: MonthKey): DayKey {
  monthParts(month);
  return `${month}-01`;
}

export function lastDay(month: MonthKey): DayKey {
  return `${month}-${pad(daysInMonth(month))}`;
}

/** The month's 1st as a `@db.Date` column holds it — `RevenueScheduleLine.month`. */
export function monthDate(month: MonthKey): Date {
  const { year, month0 } = monthParts(month);
  return new Date(Date.UTC(year, month0, 1));
}

/** A day as a `@db.Date` column holds it — `RevenueSchedule.startDate`/`endDate`. */
export function dayDate(day: DayKey): Date {
  const { year, month0, day: d } = dayParts(day);
  return new Date(Date.UTC(year, month0, d));
}

/**
 * The date a month's entry is written on: its last day at 12:00 UTC (17:30 IST) — that day whichever
 * clock reads it, as payroll and depreciation are dated, and inside the month for the period lock.
 */
export function monthEntryDate(month: MonthKey): Date {
  const { year, month0 } = monthParts(month);
  return new Date(Date.UTC(year, month0 + 1, 0, 12));
}

/** Inclusive days from one day to another, as `termDays` counts them: 1 Jan–31 Jan is 31. */
export function termDays(from: DayKey, to: DayKey): number {
  return Math.round((dayDate(to).getTime() - dayDate(from).getTime()) / DAY_MS) + 1;
}

const maxDay = (a: DayKey, b: DayKey) => (a > b ? a : b);
const minDay = (a: DayKey, b: DayKey) => (a < b ? a : b);

/** The month before the one `now` falls in, in India — what the nightly job and "Recognise through" go up to. */
export function lastCompletedMonth(now: Date): MonthKey {
  return addMonths(monthKeyAt(now), -1);
}

/** "Sep 2026". */
export function monthLabel(month: MonthKey): string {
  const { year, month0 } = monthParts(month);
  return `${SHORT_MONTHS[month0]} ${year}`;
}

/** "15 Sep 2026". */
export function dayLabel(day: DayKey): string {
  const { year, month0, day: d } = dayParts(day);
  return `${d} ${SHORT_MONTHS[month0]} ${year}`;
}

// ─── Splitting money ─────────────────────────────────────────────────────────────────────────────

/**
 * `amount` split in proportion to `weights`, to the paisa, the parts adding up to `amount` exactly.
 *
 * Each part is its share rounded to the nearest paisa and the last part takes whatever rounding left
 * over — which is how a ₹1,20,000 year by day comes out at ₹10,191.78 in January and ₹10,191.80 in
 * December. Worked in whole paise, so the sum is exact rather than a float that prints like it.
 *
 * One guard: with many tiny parts, rounding each up could leave the last one negative (₹0.06 over
 * twelve months). When the weights are all non-negative, no part may be; the split then rounds the
 * running total instead, which never goes backwards.
 */
export function allocate(amount: number, weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const target = Math.round(amount * 100);
  const total = weights.reduce((t, w) => t + w, 0);
  if (total === 0) return weights.map((_, i) => (i === n - 1 ? target / 100 : 0));

  const parts = weights.map((w) => Math.round((target * w) / total));
  parts[n - 1] = target - parts.slice(0, n - 1).reduce((t, p) => t + p, 0);

  if (target >= 0 && weights.every((w) => w >= 0) && parts[n - 1] < 0) {
    let cumulative = 0;
    let previous = 0;
    return weights.map((w, i) => {
      cumulative += w;
      const upTo = i === n - 1 ? target : Math.round((target * cumulative) / total);
      const part = upTo - previous;
      previous = upTo;
      return part / 100;
    });
  }
  return parts.map((p) => p / 100);
}

/** Days of `[from, to]` in each month it touches. */
function daysPerMonth(from: DayKey, to: DayKey): { month: MonthKey; days: number; monthDays: number }[] {
  if (to < from) throw new RangeError(`A period can't end (${to}) before it starts (${from}).`);
  return monthsBetween(monthOfDay(from), monthOfDay(to)).map((month) => {
    const start = maxDay(from, firstDay(month));
    const end = minDay(to, lastDay(month));
    return { month, days: termDays(start, end), monthDays: daysInMonth(month) };
  });
}

/**
 * The weight each month of a period carries: its days in the period (by day), or the share of the
 * month the period covers (evenly — a whole month is 1, so every whole month gets the same).
 */
function monthWeights(from: DayKey, to: DayKey, evenly: boolean): { month: MonthKey; weight: number }[] {
  return daysPerMonth(from, to).map(({ month, days, monthDays }) => ({ month, weight: evenly ? days / monthDays : days }));
}

/**
 * `amount` over `[from, to]` by day: each month in proportion to its days in the period, both ends
 * included (as `termDays` counts), to the paisa, the last month taking the rounding difference. Every
 * month the period touches is listed, a zero one included.
 *
 * `from` and `to` are calendar days: `yyyy-mm-dd`, or a `@db.Date` value (read by its UTC parts).
 */
export function spreadByDay(amount: number, from: DayKey | Date, to: DayKey | Date): MonthAmount[] {
  return spreadOver(amount, from, to, { evenly: false });
}

/**
 * The same with equal months (the "Spread evenly by month" setting, D3): every whole month in the
 * period gets the same, and a part month at either end gets its share of a month — 15 Jan–14 Jan is
 * 17/31 of a month, eleven whole ones and 14/31.
 */
export function spreadEvenly(amount: number, from: DayKey | Date, to: DayKey | Date): MonthAmount[] {
  return spreadOver(amount, from, to, { evenly: true });
}

/**
 * `amount` over `[from, to]`, leaving out the months in `skip` — the months a re-plan may not touch
 * because they are already posted. Empty when every month is skipped.
 */
export function spreadOver(
  amount: number,
  from: DayKey | Date,
  to: DayKey | Date,
  options: { evenly?: boolean; skip?: Iterable<MonthKey> } = {},
): MonthAmount[] {
  const skip = new Set(options.skip ?? []);
  const weights = monthWeights(asDayKey(from), asDayKey(to), options.evenly ?? false).filter((w) => !skip.has(w.month));
  if (weights.length === 0) return [];
  const parts = allocate(amount, weights.map((w) => w.weight));
  return weights.map((w, i) => ({ month: w.month, amount: parts[i] }));
}

/**
 * A schedule's unposted months re-spread to a new remaining amount — after a credit note takes some
 * off, or its cancellation puts it back. Posted months are never passed in and never change.
 *
 * The months from `fromMonth` on keep their shape: each gets the new amount in proportion to what it
 * had. When there is nothing to be in proportion to — every unposted month is gone, as when a credit
 * note took the schedule to nil — the amount is spread over what is left of the period (`period`,
 * from `fromMonth`'s 1st), by day or evenly, skipping `period.skip`; and when not even that is left,
 * it all goes in `fromMonth`.
 *
 * Months before `fromMonth` are not part of the answer: the caller leaves them as they are.
 */
export function replan(
  lines: MonthAmount[],
  newAmountRemaining: number,
  fromMonth: MonthKey,
  period?: { from: DayKey | Date; to: DayKey | Date; evenly?: boolean; skip?: Iterable<MonthKey> },
): MonthAmount[] {
  const remaining = round2(newAmountRemaining);
  if (remaining < 0) throw new RangeError("A schedule can't have less than nothing left to recognise.");
  const candidates = lines.filter((l) => l.month >= fromMonth).sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
  const current = candidates.reduce((t, l) => t + Math.max(0, l.amount), 0);
  if (current > 0) {
    const parts = allocate(remaining, candidates.map((l) => Math.max(0, Math.round(l.amount * 100))));
    return candidates.map((l, i) => ({ month: l.month, amount: parts[i] }));
  }
  if (remaining === 0) return candidates.map((l) => ({ month: l.month, amount: 0 }));
  if (period) {
    const start = maxDay(asDayKey(period.from), firstDay(fromMonth));
    const end = asDayKey(period.to);
    if (start <= end) {
      const spread = spreadOver(remaining, start, end, { evenly: period.evenly, skip: period.skip });
      if (spread.length > 0) return spread;
    }
  }
  return [{ month: fromMonth, amount: remaining }];
}

// ─── Which lines are earned over time ────────────────────────────────────────────────────────────

export type PatternValue = "POINT_IN_TIME" | "RATABLE";
export type DeferralKind = "RATABLE" | "MILESTONE";

type ItemFacts = { type: string; revenuePattern?: PatternValue | null } | null | undefined;
type LineFacts = {
  servicePeriodFrom?: Date | DayKey | null;
  servicePeriodTo?: Date | DayKey | null;
  billingMilestoneId?: string | null;
};
/** The billing stage a line bills, as it stands at issue: its delivery milestone, and whether that is done. */
export type MilestoneFacts = { deliveryMilestoneId: string | null; deliveryCompletedAt: Date | null } | null | undefined;

/** The line's service period as days, or null when it has none (both ends are needed). */
export function periodOf(line: LineFacts): { from: DayKey; to: DayKey } | null {
  if (!line.servicePeriodFrom || !line.servicePeriodTo) return null;
  return { from: asDayKey(line.servicePeriodFrom), to: asDayKey(line.servicePeriodTo) };
}

/**
 * How an item's revenue is earned on this line (spec §3.1).
 *
 * The item's own `revenuePattern` when somebody chose one. Otherwise derived: a SUBSCRIPTION is earned
 * over its term (RATABLE); a GOOD, a PERPETUAL licence or a SERVICE at a point in time — unless this
 * line carries a service period that runs past the month it is issued in, which is time being sold.
 */
export function patternFor(item: ItemFacts, line: LineFacts, issueDate: Date): PatternValue {
  if (item?.revenuePattern) return item.revenuePattern;
  if (item?.type === "SUBSCRIPTION") return "RATABLE";
  const period = periodOf(line);
  if (period && period.to > lastDay(monthKeyAt(issueDate))) return "RATABLE";
  return "POINT_IN_TIME";
}

/**
 * Whether an invoice line's revenue waits, and for what (spec §3.2).
 *
 *   · **MILESTONE** — it bills a project stage whose delivery milestone exists and is not done yet:
 *     earned in full the month that milestone is completed.
 *   · **RATABLE** — it has a service period, and either that period ends after the last day of the
 *     issue month (IST), whatever the item; or the item's pattern is RATABLE.
 *   · **null** — recognised on the invoice, as always. That includes every line whose whole period
 *     falls inside the issue month: it is all earned by the time the month closes.
 *
 * A RATABLE line billed in arrears (a period that ended before the issue month) still defers: its
 * months are in the past, and the run posts them there, or as a catch-up where they are closed.
 */
export function defers(line: LineFacts, item: ItemFacts, issueDate: Date, milestone?: MilestoneFacts): DeferralKind | null {
  if (line.billingMilestoneId && milestone?.deliveryMilestoneId && !milestone.deliveryCompletedAt) return "MILESTONE";
  const period = periodOf(line);
  if (!period) return null;
  const issueMonth = monthKeyAt(issueDate);
  if (monthOfDay(period.from) === issueMonth && monthOfDay(period.to) === issueMonth) return null;
  if (period.to > lastDay(issueMonth)) return "RATABLE";
  return patternFor(item, line, issueDate) === "RATABLE" ? "RATABLE" : null;
}

// ─── Which month an entry can go in ──────────────────────────────────────────────────────────────

/** Whether a month's entry — dated its last day — is outside the closed books (P0's calendar-day rule). */
export function isMonthOpen(month: MonthKey, lockedUntil: Date | null | undefined): boolean {
  return !isLockedDate(monthEntryDate(month), lockedUntil);
}

/** The first month whose last day is open: the month of the day after the lock. Null with no lock. */
export function firstOpenMonth(lockedUntil: Date | null | undefined): MonthKey | null {
  if (!lockedUntil) return null;
  const lock = calendarDateOf(lockedUntil);
  return monthKeyOfDate(new Date(Date.UTC(lock.getUTCFullYear(), lock.getUTCMonth(), lock.getUTCDate() + 1)));
}

/**
 * Where a month's recognition is posted: in its own month while that is open, otherwise in the first
 * open month, as a catch-up. Posted months are never re-dated — a closed month's revenue lands late
 * rather than changing a trial balance somebody has already been given.
 */
export function postingMonthFor(month: MonthKey, lockedUntil: Date | null | undefined): { month: MonthKey; catchUp: boolean } {
  if (isMonthOpen(month, lockedUntil)) return { month, catchUp: false };
  return { month: firstOpenMonth(lockedUntil)!, catchUp: true };
}

// ─── Invoice lines in rupees ─────────────────────────────────────────────────────────────────────

/**
 * An invoice's revenue in rupees (its taxable value less freight, at its own rate, as the posting
 * converts it) shared across its lines in proportion to each line's taxable value.
 *
 * Shared rather than converting each line on its own, so the parts add up to the revenue the entry
 * credits to the paisa: an invoice whose every line defers leaves Sales at exactly nil. At rate 1 each
 * line's share is its own taxable value.
 */
export function lineRupees(revenueRupees: number, lineTaxableValues: number[]): number[] {
  return allocate(revenueRupees, lineTaxableValues.map((v) => Math.round(v * 100)));
}

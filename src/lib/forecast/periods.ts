import type { Clock } from "@/lib/time/zone";

/**
 * The periods a forecast is laid out in: months, financial-year quarters, financial years.
 *
 * Everything on the workspace's clock (passed in) and half-open — a period runs from its first
 * instant up to, not including, the first instant of the next — so a renewal due at 11:30 pm on
 * 31 March is March's and a deal closing at midnight on 1 April is April's, wherever the server is.
 * Quarters are the financial year's: Q1 is April to June, Q4 is January to March.
 */

export type Grain = "month" | "quarter" | "year";
export const GRAINS: { key: Grain; label: string; counts: number[]; defaultCount: number }[] = [
  { key: "month", label: "Month", counts: [3, 6, 12], defaultCount: 6 },
  { key: "quarter", label: "Quarter", counts: [2, 4, 8], defaultCount: 4 },
  { key: "year", label: "Financial year", counts: [1, 2, 3], defaultCount: 2 },
];

export type Period = { key: string; label: string; from: Date; to: Date };

const MONTH = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", month: "short", year: "numeric" });
const yy = (year: number) => String((year + 1) % 100).padStart(2, "0");

/** The financial year a calendar month belongs to, as the year it starts in. */
function fyStart(year: number, month0: number): number {
  return month0 >= 3 ? year : year - 1;
}

export function periodContaining(at: Date, grain: Grain, clock: Clock): Period {
  const { year, month } = clock.parts(at);
  if (grain === "month") {
    return {
      key: `${year}-${String(month + 1).padStart(2, "0")}`,
      label: MONTH.format(new Date(Date.UTC(year, month, 15))),
      from: clock.midnight(year, month, 1),
      to: clock.midnight(year, month + 1, 1),
    };
  }
  const start = fyStart(year, month);
  if (grain === "year") {
    return { key: `FY${start}`, label: `FY ${start}-${yy(start)}`, from: clock.midnight(start, 3, 1), to: clock.midnight(start + 1, 3, 1) };
  }
  // Months since the financial year began, 0–11, and the quarter they fall in.
  const index = Math.floor(((month - 3 + 12) % 12) / 3);
  const firstMonth = 3 + index * 3;
  return {
    key: `FY${start}-Q${index + 1}`,
    label: `Q${index + 1} ${start}-${yy(start)}`,
    // Day overflow carries Q4 into the next calendar year: clock.midnight(2026, 12, 1) is 1 January 2027.
    from: clock.midnight(start, firstMonth, 1),
    to: clock.midnight(start, firstMonth + 3, 1),
  };
}

/** `count` periods, starting with the one that contains `now`. */
export function periodsFrom(now: Date, grain: Grain, count: number, clock: Clock): Period[] {
  const out: Period[] = [];
  let cursor = periodContaining(now, grain, clock);
  for (let i = 0; i < Math.max(1, Math.min(count, 36)); i += 1) {
    out.push(cursor);
    cursor = periodContaining(cursor.to, grain, clock);
  }
  return out;
}

/** The same stretch of time a year earlier — "last year" beside each period. */
export function yearEarlier(period: Pick<Period, "from" | "to">, clock: Clock): { from: Date; to: Date } {
  const shift = (d: Date) => {
    const { year, month, day } = clock.parts(d);
    return clock.midnight(year - 1, month, day);
  };
  return { from: shift(period.from), to: shift(period.to) };
}

/**
 * The months inside a period, as yyyy-mm — what salesperson commits (which are monthly) roll up by.
 */
export function monthsIn(period: Pick<Period, "from" | "to">, clock: Clock): string[] {
  const out: string[] = [];
  let cursor = periodContaining(period.from, "month", clock);
  while (cursor.from.getTime() < period.to.getTime()) {
    out.push(cursor.key);
    cursor = periodContaining(cursor.to, "month", clock);
  }
  return out;
}

/**
 * Where a date lands: a period's key, before the first, after the last, or nowhere (no date).
 *
 * `at` is a moment. A calendar day — a `@db.Date`, or a day typed into a form and held as midnight
 * UTC — goes in as the moment that day begins on the workspace's clock: as midnight UTC it would
 * land on the day before anywhere west of UTC.
 */
export const BEFORE = "BEFORE";
export const AFTER = "AFTER";
export const UNDATED = "UNDATED";

export function bucketFor(at: Date | string | null | undefined, periods: Period[]): string {
  if (!at) return UNDATED;
  const t = new Date(at).getTime();
  if (Number.isNaN(t)) return UNDATED;
  if (periods.length === 0 || t < periods[0]!.from.getTime()) return BEFORE;
  const hit = periods.find((p) => t >= p.from.getTime() && t < p.to.getTime());
  return hit ? hit.key : AFTER;
}

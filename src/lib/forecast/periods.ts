import { istDateParts, istMidnight } from "@/lib/india-time";

/**
 * The periods a forecast is laid out in: months, financial-year quarters, financial years.
 *
 * Everything in India time and half-open — a period runs from its first instant up to, not
 * including, the first instant of the next — so a renewal due at 11:30 pm on 31 March is March's
 * and a deal closing at midnight on 1 April is April's, wherever the server is. Quarters are the
 * financial year's: Q1 is April to June, Q4 is January to March.
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

/** The financial year an Indian calendar month belongs to, as the year it starts in. */
function fyStart(year: number, month0: number): number {
  return month0 >= 3 ? year : year - 1;
}

export function periodContaining(at: Date, grain: Grain): Period {
  const { year, month } = istDateParts(at);
  if (grain === "month") {
    return {
      key: `${year}-${String(month + 1).padStart(2, "0")}`,
      label: MONTH.format(new Date(Date.UTC(year, month, 15))),
      from: istMidnight(year, month, 1),
      to: istMidnight(year, month + 1, 1),
    };
  }
  const start = fyStart(year, month);
  if (grain === "year") {
    return { key: `FY${start}`, label: `FY ${start}-${yy(start)}`, from: istMidnight(start, 3, 1), to: istMidnight(start + 1, 3, 1) };
  }
  // Months since the financial year began, 0–11, and the quarter they fall in.
  const index = Math.floor(((month - 3 + 12) % 12) / 3);
  const firstMonth = 3 + index * 3;
  return {
    key: `FY${start}-Q${index + 1}`,
    label: `Q${index + 1} ${start}-${yy(start)}`,
    // Day overflow carries Q4 into the next calendar year: istMidnight(2026, 12, 1) is 1 January 2027.
    from: istMidnight(start, firstMonth, 1),
    to: istMidnight(start, firstMonth + 3, 1),
  };
}

/** `count` periods, starting with the one that contains `now`. */
export function periodsFrom(now: Date, grain: Grain, count: number): Period[] {
  const out: Period[] = [];
  let cursor = periodContaining(now, grain);
  for (let i = 0; i < Math.max(1, Math.min(count, 36)); i += 1) {
    out.push(cursor);
    cursor = periodContaining(cursor.to, grain);
  }
  return out;
}

/** The same stretch of time a year earlier — "last year" beside each period. */
export function yearEarlier(period: Pick<Period, "from" | "to">): { from: Date; to: Date } {
  const shift = (d: Date) => {
    const { year, month, day } = istDateParts(d);
    return istMidnight(year - 1, month, day);
  };
  return { from: shift(period.from), to: shift(period.to) };
}

/**
 * The months inside a period, as yyyy-mm — what salesperson commits (which are monthly) roll up by.
 */
export function monthsIn(period: Pick<Period, "from" | "to">): string[] {
  const out: string[] = [];
  let cursor = periodContaining(period.from, "month");
  while (cursor.from.getTime() < period.to.getTime()) {
    out.push(cursor.key);
    cursor = periodContaining(cursor.to, "month");
  }
  return out;
}

/** Where a date lands: a period's key, before the first, after the last, or nowhere (no date). */
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

import { DATE_PRESET_LABELS, type DateRange } from "./definition";

/**
 * A report's date range as days (`yyyy-mm-dd`, the workspace's), and the period a score compares against.
 *
 * Pure, on day strings only — the server turns the two days into the workspace's instants
 * (src/lib/analytics/request.ts reportWindow), so the browser and the server agree on what "this financial year"
 * means without either asking a `Date` what day it is. The financial year is India's: April to March.
 */

export type DayWindow = { from: string; to: string; label: string };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");
const parts = (key: string) => key.split("-").map(Number) as [number, number, number];
const key = (y: number, m: number, d: number) => {
  const at = new Date(Date.UTC(y, m - 1, d));
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
};
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const shiftDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

/** "1 Apr – 23 Oct 2026", or "4 Sep 2025 – 23 Oct 2026" across years. */
export function windowLabel(from: string, to: string): string {
  const [fy, fm, fd] = parts(from);
  const [ty, tm, td] = parts(to);
  return fy === ty ? `${fd} ${MONTHS[fm - 1]} – ${td} ${MONTHS[tm - 1]} ${ty}` : `${fd} ${MONTHS[fm - 1]} ${fy} – ${td} ${MONTHS[tm - 1]} ${ty}`;
}

/** The first day of the financial year a day falls in. */
export function fyStart(day: string): string {
  const [y, m] = parts(day);
  return key(m >= 4 ? y : y - 1, 4, 1);
}

/** A range as the two days it covers, ending no later than today. */
export function rangeDays(range: DateRange, today: string): DayWindow {
  const [y, m] = parts(today);
  let from: string;
  let to = today;
  switch (range.preset) {
    case "thisFy":
      from = fyStart(today);
      break;
    case "lastFy": {
      const start = fyStart(today);
      from = key(Number(start.slice(0, 4)) - 1, 4, 1);
      to = shiftDays(start, -1);
      break;
    }
    case "thisQuarter":
      from = key(y, Math.floor((m - 1) / 3) * 3 + 1, 1);
      break;
    case "thisMonth":
      from = key(y, m, 1);
      break;
    case "lastMonth": {
      const pm = m === 1 ? 12 : m - 1;
      const py = m === 1 ? y - 1 : y;
      from = key(py, pm, 1);
      to = key(py, pm, lastDay(py, pm));
      break;
    }
    case "last30":
      from = shiftDays(today, -29);
      break;
    case "last90":
      from = shiftDays(today, -89);
      break;
    case "last12m":
      from = shiftDays(key(y - 1, m, Math.min(parts(today)[2], lastDay(y - 1, m))), 1);
      break;
    case "ytd":
      from = key(y, 1, 1);
      break;
    case "custom":
      from = range.from ?? today;
      to = range.to ?? today;
      break;
  }
  return { from, to, label: windowLabel(from, to) };
}

/** What a range is called: "This financial year", or the custom days themselves. */
export function rangeName(range: DateRange, today: string): string {
  return range.preset === "custom" ? rangeDays(range, today).label : DATE_PRESET_LABELS[range.preset];
}

/** The period a score compares against: the same days a year back, or the same length just before. */
export function compareDays(win: { from: string; to: string }, mode: "previousYear" | "previousPeriod"): DayWindow & { against: string } {
  if (mode === "previousYear") {
    const back = (day: string) => {
      const [y, mo, d] = parts(day);
      return key(y - 1, mo, Math.min(d, lastDay(y - 1, mo)));
    };
    const from = back(win.from);
    const to = back(win.to);
    return { from, to, label: windowLabel(from, to), against: "vs last year" };
  }
  const n = daysBetween(win.from, win.to);
  const to = shiftDays(win.from, -1);
  const from = shiftDays(to, -(n - 1));
  return { from, to, label: windowLabel(from, to), against: "vs previous period" };
}

/**
 * A week or a month of calendar days, as `yyyy-mm-dd` keys — for a person's own attendance card, worked out the
 * same on the server and in the browser. Pure: days are UTC dates, as attendance days are stored.
 */

export type PeriodView = "week" | "month";
export type Period = { view: PeriodView; from: string; to: string };

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const toDate = (key: string) => new Date(`${key}T00:00:00Z`);
const toKey = (d: Date) => d.toISOString().slice(0, 10);

/** A real `yyyy-mm-dd`, or null. */
export function dayKey(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = toDate(value);
  return Number.isNaN(d.getTime()) || toKey(d) !== value ? null : value;
}

/** The week (Monday to Sunday) or month holding `day`. */
export function periodOf(view: PeriodView, day: string): Period {
  const d = toDate(day);
  if (view === "week") {
    const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY_MS);
    return { view, from: toKey(monday), to: toKey(new Date(monday.getTime() + 6 * DAY_MS)) };
  }
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return { view, from: toKey(first), to: toKey(last) };
}

/** The period before (-1) or after (+1) this one. */
export function stepPeriod(period: Period, by: -1 | 1): Period {
  const anchor =
    by < 0 ? new Date(toDate(period.from).getTime() - DAY_MS) : new Date(toDate(period.to).getTime() + DAY_MS);
  return periodOf(period.view, toKey(anchor));
}

/** "20 – 26 Oct 2026", "27 Oct – 2 Nov 2026", or "October 2026". */
export function periodLabel(period: Period): string {
  const a = toDate(period.from);
  const b = toDate(period.to);
  if (period.view === "month") return `${MONTH_NAMES[a.getUTCMonth()]} ${a.getUTCFullYear()}`;
  const end = `${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
  if (a.getUTCFullYear() !== b.getUTCFullYear())
    return `${a.getUTCDate()} ${MONTHS[a.getUTCMonth()]} ${a.getUTCFullYear()} – ${end}`;
  if (a.getUTCMonth() !== b.getUTCMonth()) return `${a.getUTCDate()} ${MONTHS[a.getUTCMonth()]} – ${end}`;
  return `${a.getUTCDate()} – ${end}`;
}

/** Days from one key to another, both in. */
export function daysBetween(from: string, to: string): number {
  return Math.round((toDate(to).getTime() - toDate(from).getTime()) / DAY_MS) + 1;
}

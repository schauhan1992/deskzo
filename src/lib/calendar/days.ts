/**
 * Days as `yyyy-mm-dd` keys, moved and named without any zone: a day key is a calendar day, and
 * counting days on a calendar needs none. Which day it is *now*, or when a day begins, is the
 * workspace clock's to say (src/lib/time/zone.ts).
 */

function parse(key: string): { y: number; m: number; d: number } | null {
  const k = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  return k ? { y: Number(k[1]), m: Number(k[2]) - 1, d: Number(k[3]) } : null;
}

const keyOf = (t: number) => new Date(t).toISOString().slice(0, 10);

export function addDays(key: string, days: number): string {
  const p = parse(key);
  return p ? keyOf(Date.UTC(p.y, p.m, p.d + days)) : key;
}

/** 0 Sunday … 6 Saturday. */
export function weekdayOf(key: string): number {
  const p = parse(key);
  return p ? new Date(Date.UTC(p.y, p.m, p.d)).getUTCDay() : 0;
}

/** The Monday of the week a day is in. */
export function mondayOf(key: string): string {
  return addDays(key, -((weekdayOf(key) + 6) % 7));
}

export function isDayKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const p = parse(value);
  return !!p && keyOf(Date.UTC(p.y, p.m, p.d)) === value;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "Mon 5" for a column head; "Mon, 5 Oct" for a heading. */
export function dayLabel(key: string, long = false): string {
  const p = parse(key);
  if (!p) return key;
  const wd = WEEKDAYS[weekdayOf(key)];
  return long ? `${wd}, ${p.d} ${MONTHS[p.m]}` : `${wd} ${p.d}`;
}

/** "5 – 11 Oct 2026", "28 Sep – 4 Oct 2026", "29 Dec 2026 – 4 Jan 2027". */
export function spanLabel(first: string, last: string): string {
  const a = parse(first);
  const b = parse(last);
  if (!a || !b) return `${first} – ${last}`;
  if (a.y !== b.y) return `${a.d} ${MONTHS[a.m]} ${a.y} – ${b.d} ${MONTHS[b.m]} ${b.y}`;
  if (a.m !== b.m) return `${a.d} ${MONTHS[a.m]} – ${b.d} ${MONTHS[b.m]} ${b.y}`;
  return `${a.d} – ${b.d} ${MONTHS[b.m]} ${b.y}`;
}

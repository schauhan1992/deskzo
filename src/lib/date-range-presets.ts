import { istDateParts } from "@/lib/india-time";

/**
 * How this module holds a day: a `Date` at local midnight of that calendar date, as the date-range
 * picker's grid does — its arithmetic (`addDays`, `startOfWeek`, `startOfMonth`…) is calendar
 * arithmetic on those, and `toISODate` turns one back into the `yyyy-mm-dd` the server reads as an
 * Indian day.
 *
 * What was wrong was only where "today" came from: the host's clock. A browser outside India, or a
 * server in UTC before 05:30 IST, is on a different date from India, so "Today", "This month" and
 * "Last month" were a day — or a month — out. `indianToday` anchors every preset to India's date and
 * keeps the rest of the model as it was.
 */
export function indianToday(now: Date = new Date()) {
  const { year, month, day } = istDateParts(now);
  return new Date(year, month, day);
}

export function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function addMonths(d: Date, n: number) {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
}

export function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function endOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

/** Sunday-start week, to match the reference UI. */
export function startOfWeek(d: Date) {
  const x = startOfDay(d);
  x.setDate(x.getDate() - x.getDay());
  return x;
}

export function isSameDay(a: Date | null, b: Date | null) {
  if (!a || !b) return false;
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Local YYYY-MM-DD — avoids the UTC-shift you get from `Date#toISOString`. */
export function toISODate(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function fromISODate(s: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function formatShortYear(d: Date) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export const PRESET_KEYS = [
  "today",
  "yesterday",
  "thisWeek",
  "last7",
  "lastWeek",
  "last14",
  "thisMonth",
  "last30",
  "lastMonth",
  "allTime",
] as const;

export type PresetKey = (typeof PRESET_KEYS)[number];

export const PRESETS: { key: PresetKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "thisWeek", label: "This week (Sun – Today)" },
  { key: "last7", label: "Last 7 days" },
  { key: "lastWeek", label: "Last week (Sun – Sat)" },
  { key: "last14", label: "Last 14 days" },
  { key: "thisMonth", label: "This month" },
  { key: "last30", label: "Last 30 days" },
  { key: "lastMonth", label: "Last month" },
  { key: "allTime", label: "All time" },
];

export function computePreset(key: PresetKey, now: Date = new Date()): { from: Date | null; to: Date | null } {
  // India's date, whatever clock the browser or the server keeps.
  const today = indianToday(now);
  switch (key) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const y = addDays(today, -1);
      return { from: y, to: y };
    }
    case "thisWeek":
      return { from: startOfWeek(today), to: today };
    case "last7":
      return { from: addDays(today, -6), to: today };
    case "lastWeek": {
      const start = addDays(startOfWeek(today), -7);
      return { from: start, to: addDays(start, 6) };
    }
    case "last14":
      return { from: addDays(today, -13), to: today };
    case "thisMonth":
      return { from: startOfMonth(today), to: today };
    case "last30":
      return { from: addDays(today, -29), to: today };
    case "lastMonth": {
      const lastMonthDate = addMonths(today, -1);
      return { from: startOfMonth(lastMonthDate), to: endOfMonth(lastMonthDate) };
    }
    case "allTime":
      return { from: null, to: null };
  }
}

/** Matches a from/to pair back to a known preset, so the trigger button can show its
 * name (e.g. "Last 7 days") instead of a raw date range when they line up exactly. */
export function matchPreset(from: Date | null, to: Date | null, now: Date = new Date()): PresetKey | null {
  for (const { key } of PRESETS) {
    const preset = computePreset(key, now);
    const fromMatches = preset.from === null ? from === null : isSameDay(preset.from, from);
    const toMatches = preset.to === null ? to === null : isSameDay(preset.to, to);
    if (fromMatches && toMatches) return key;
  }
  return null;
}

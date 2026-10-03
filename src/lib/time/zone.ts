/**
 * A workspace's clock: the calendar and the wall clock of one time zone, whatever zone the server or the
 * reader is in (owner, 2 Oct 2026 — each workspace chooses its zone; the platform console has its own).
 *
 * Pure and client-safe. A server page gets its workspace's clock from `workspaceClock()`
 * (src/lib/time/workspace.ts), a client component from `useClock()` (src/components/time/clock-provider.tsx),
 * the console from `consoleClock()`. India's statutory dates — GST and TDS periods, e-way bills,
 * e-invoices, the financial year — stay on India's clock in every workspace: src/lib/india-time.ts.
 *
 * The same two traps src/lib/india-time.ts exists for apply to every zone: a date-only string is read
 * as UTC midnight, and `getDate()`/`setHours()` read the host's calendar. Neither is used here. Unlike
 * India, most zones keep daylight saving, so an offset is looked up for the moment in question, never
 * assumed: a wall-clock time a clock-change skips is moved forward by the gap, and one it repeats is
 * read as its first occurrence — what a person typing it would expect.
 */

export const INDIA_ZONE = "Asia/Kolkata";

export type ZonedParts = {
  year: number;
  /** 0-based, as `Date` has it. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 is Sunday. */
  weekday: number;
};

export type Clock = {
  /** The IANA zone, e.g. "Asia/Kolkata". */
  zone: string;
  /** An instant's wall-clock reading here. */
  parts(at: Date): ZonedParts;
  /** `yyyy-mm-dd` for the day an instant falls on here. */
  dateKey(at: Date): string;
  /** `yyyy-mm` for the month an instant falls in here. */
  monthKey(at: Date): string;
  /** Calendar days here from one instant's day to another's: 0 on the same day, negative when `to` is earlier. */
  daysBetween(from: Date, to: Date): number;
  /** Today's `yyyy-mm-dd` here. */
  today(now?: Date): string;
  /**
   * The instant a wall-clock time here names. Overflow normalises as `Date.UTC` does — day 32 is the
   * next month's 1st — which is how "the end of a month" is said without month lengths.
   */
  at(year: number, month: number, day: number, hour?: number, minute?: number): Date;
  /** The moment a day here begins. Overflows as `at` does. */
  midnight(year: number, month: number, day: number): Date;
  /** The moment the day `yyyy-mm-dd` begins here; null if it isn't a date. */
  startOfDay(key: string): Date | null;
  /** The moment the day `yyyy-mm-dd` ends here: the next day's midnight — a bound compared with `<`. */
  endOfDay(key: string): Date | null;
  /** A list's From and To (`yyyy-mm-dd`) as days here, half-open; null when neither is given. */
  dayRange(from?: string | null, to?: string | null): { gte?: Date; lt?: Date } | null;
  /** The day an instant falls on here, held as a `@db.Date` holds a day: midnight UTC. */
  calendarDate(at: Date): Date;
  /** The month here an instant falls in, half-open; `offset` moves by whole months. */
  monthWindow(at: Date, offset?: number): { from: Date; to: Date };
  /** What a `datetime-local` input gives (`yyyy-mm-ddThh:mm`), read as a time here. */
  parseInput(value: string): Date | null;
  /** `parseInput`, or a full timestamp that states its own zone ("…Z", "…+05:30"), taken as it says. */
  parseTyped(value: string): Date | null;
  /** An instant as a `datetime-local` value here; "" for nothing. */
  input(at: Date | string | null | undefined): string;
  /** "Thu, 15 Oct 2026, 6:30 pm". "—" for nothing, or what isn't a date. */
  dateTime(at: Date | string | null | undefined): string;
  /** "15 Oct 2026, 6:30 pm" — the shorter form, where the weekday is noise. */
  dateTimeShort(at: Date | string | null | undefined): string;
  /** "15 Oct 2026" — the day something happened here. */
  date(at: Date | string | null | undefined): string;
  /** "15 Oct" — a day close enough that the year goes without saying. */
  dayMonth(at: Date | string | null | undefined): string;
  /** "6:30 pm". */
  time(at: Date | string | null | undefined): string;
  /** "UTC+05:30" at an instant (now by default) — a zone with daylight saving has two. */
  offsetLabel(at?: Date): string;
};

const DAY_MS = 86_400_000;
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Whether the runtime knows this zone. Old names ("Asia/Calcutta") count: Intl takes them too. */
export function isTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || zone.trim() === "" || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(zone: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    });
    partsFormatters.set(zone, f);
  }
  return f;
}

function zonedParts(at: Date, zone: string): ZonedParts {
  const out: Record<string, string> = {};
  for (const p of partsFormatter(zone).formatToParts(at)) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month) - 1,
    day: Number(out.day),
    // "24" is how some engines say midnight even under h23.
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAYS[out.weekday ?? ""] ?? 0,
  };
}

/** The zone's offset from UTC at an instant, in milliseconds (east positive). */
function offsetMs(at: number, zone: string): number {
  const p = zonedParts(new Date(at), zone);
  const asUtc = Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** A wall-clock time (as UTC milliseconds) to the instant it names here: earlier of two, forward over a gap. */
function wallToInstant(wall: number, zone: string): Date {
  // The offsets a day either side: a day holds at most one clock change.
  const before = offsetMs(wall - DAY_MS, zone);
  const after = offsetMs(wall + DAY_MS, zone);
  const fits = (offset: number) => offsetMs(wall - offset, zone) === offset;
  const candidates = [wall - before, wall - after].filter((t, i) => fits(i === 0 ? before : after));
  if (candidates.length > 0) return new Date(Math.min(...candidates));
  // A time the clocks skip: as many minutes after the jump as it was after the hour it jumped from.
  return new Date(wall - before);
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

function parseDateKey(key: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  // 31 February is not a date, and Date.UTC would quietly make it 3 March.
  const probe = new Date(Date.UTC(year, month, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month || probe.getUTCDate() !== day) return null;
  return { year, month, day };
}

/**
 * Words are spelled here rather than asked of Intl: its en-IN data writes September as "Sept", and puts a
 * comma after the month, in some ICU versions and not in others — and a page rendered on the server must
 * read the same once a browser takes it over.
 */
export const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const dayWords = (p: { year: number; month: number; day: number }) => `${p.day} ${MONTH_NAMES[p.month]} ${p.year}`;
const clockWords = (p: ZonedParts) => `${p.hour % 12 === 0 ? 12 : p.hour % 12}:${pad(p.minute)} ${p.hour < 12 ? "am" : "pm"}`;

function validInstant(at: Date | string | null | undefined): Date | null {
  if (at === null || at === undefined || at === "") return null;
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * A calendar day held in a `@db.Date` column — "15 Oct 2026" — the day it holds, whatever zone the
 * server or the reader is in. Such a column reads back as midnight UTC, so its day is the UTC one.
 * For a moment in time, a clock's `date(at)` instead. "—" for nothing.
 */
export function formatCalendarDay(day: Date | string | null | undefined): string {
  const d = validInstant(day);
  return d ? dayWords({ year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate() }) : "—";
}

/**
 * A list's From and To (`yyyy-mm-dd`) for a `@db.Date` column: the days themselves, as the column holds
 * them, both ends in — whatever zone. Null when neither is given. For a column that holds a moment, a
 * clock's `dayRange` instead.
 */
export function calendarDayRange(from?: string | null, to?: string | null): { gte?: Date; lte?: Date } | null {
  const gteParts = from ? parseDateKey(from) : null;
  const lteParts = to ? parseDateKey(to) : null;
  if (!gteParts && !lteParts) return null;
  return {
    ...(gteParts ? { gte: new Date(Date.UTC(gteParts.year, gteParts.month, gteParts.day)) } : {}),
    ...(lteParts ? { lte: new Date(Date.UTC(lteParts.year, lteParts.month, lteParts.day)) } : {}),
  };
}

function makeClock(zone: string): Clock {
  const read = (at: Date | string | null | undefined): ZonedParts | null => {
    const d = validInstant(at);
    return d ? zonedParts(d, zone) : null;
  };

  const clock: Clock = {
    zone,
    parts: (at) => zonedParts(at, zone),
    dateKey(at) {
      const p = zonedParts(at, zone);
      return `${p.year}-${pad(p.month + 1)}-${pad(p.day)}`;
    },
    today: (now = new Date()) => clock.dateKey(now),
    monthKey: (at) => clock.dateKey(at).slice(0, 7),
    daysBetween(from, to) {
      const a = zonedParts(from, zone);
      const b = zonedParts(to, zone);
      const days = Math.round((Date.UTC(b.year, b.month, b.day) - Date.UTC(a.year, a.month, a.day)) / DAY_MS);
      return days === 0 ? 0 : days;
    },
    at: (year, month, day, hour = 0, minute = 0) => wallToInstant(Date.UTC(year, month, day, hour, minute), zone),
    midnight: (year, month, day) => clock.at(year, month, day),
    startOfDay(key) {
      const d = parseDateKey(key);
      return d ? clock.midnight(d.year, d.month, d.day) : null;
    },
    endOfDay(key) {
      const d = parseDateKey(key);
      return d ? clock.midnight(d.year, d.month, d.day + 1) : null;
    },
    dayRange(from, to) {
      const gte = from ? clock.startOfDay(from) : null;
      const lt = to ? clock.endOfDay(to) : null;
      if (!gte && !lt) return null;
      return { ...(gte ? { gte } : {}), ...(lt ? { lt } : {}) };
    },
    calendarDate(at) {
      const p = zonedParts(at, zone);
      return new Date(Date.UTC(p.year, p.month, p.day));
    },
    monthWindow(at, offset = 0) {
      const p = zonedParts(at, zone);
      return { from: clock.midnight(p.year, p.month + offset, 1), to: clock.midnight(p.year, p.month + offset + 1, 1) };
    },
    parseInput(value) {
      const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
      if (!match) return null;
      const [y, mo, d, h, mi] = [1, 2, 3, 4, 5].map((i) => Number(match[i])) as [number, number, number, number, number];
      if (h > 23 || mi > 59 || !parseDateKey(`${match[1]}-${match[2]}-${match[3]}`)) return null;
      return clock.at(y, mo - 1, d, h, mi);
    },
    parseTyped(value) {
      const here = clock.parseInput(value);
      if (here) return here;
      if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(value.trim())) return null;
      const at = new Date(value.trim());
      return Number.isNaN(at.getTime()) ? null : at;
    },
    input(at) {
      if (!at) return "";
      const instant = new Date(at);
      if (Number.isNaN(instant.getTime())) return "";
      const p = zonedParts(instant, zone);
      return `${p.year}-${pad(p.month + 1)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
    },
    dateTime(at) {
      const p = read(at);
      return p ? `${WEEKDAY_NAMES[p.weekday]}, ${dayWords(p)}, ${clockWords(p)}` : "—";
    },
    dateTimeShort(at) {
      const p = read(at);
      return p ? `${dayWords(p)}, ${clockWords(p)}` : "—";
    },
    date(at) {
      const p = read(at);
      return p ? dayWords(p) : "—";
    },
    dayMonth(at) {
      const p = read(at);
      return p ? `${p.day} ${MONTH_NAMES[p.month]}` : "—";
    },
    time(at) {
      const p = read(at);
      return p ? clockWords(p) : "—";
    },
    offsetLabel(at = new Date()) {
      const minutes = Math.round(offsetMs(at.getTime(), zone) / 60_000);
      const sign = minutes < 0 ? "-" : "+";
      const abs = Math.abs(minutes);
      return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
    },
  };
  return clock;
}

/**
 * Old names some runtimes still list (Node's ICU says "Asia/Calcutta") and the names the zones go by
 * now. A zone is stored under its current name; a browser too old to know it is given the old one.
 */
export const ZONE_ALIASES: Readonly<Record<string, string>> = {
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Europe/Kiev": "Europe/Kyiv",
  "America/Godthab": "America/Nuuk",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Pacific/Truk": "Pacific/Chuuk",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Enderbury": "Pacific/Kanton",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Indianapolis": "America/Indiana/Indianapolis",
  "America/Louisville": "America/Kentucky/Louisville",
  "America/Catamarca": "America/Argentina/Catamarca",
  "America/Cordoba": "America/Argentina/Cordoba",
  "America/Jujuy": "America/Argentina/Jujuy",
  "America/Mendoza": "America/Argentina/Mendoza",
  "America/Coral_Harbour": "America/Atikokan",
  "Africa/Asmera": "Africa/Asmara",
};
const OLD_NAMES: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(ZONE_ALIASES).map(([old, current]) => [current, old]));

const clocks = new Map<string, Clock>();

/** The clock of a zone — India's for one the runtime doesn't know, as before there was a choice. */
export function clockFor(zone: string | null | undefined): Clock {
  const known = isTimeZone(zone) ? zone : zone && isTimeZone(OLD_NAMES[zone]) ? OLD_NAMES[zone] : null;
  const key = known ?? INDIA_ZONE;
  let clock = clocks.get(key);
  if (!clock) {
    clock = makeClock(key);
    clocks.set(key, clock);
  }
  return clock;
}

/** India's clock: the default, and the one statutory dates keep in every workspace. */
export const indiaClock: Clock = clockFor(INDIA_ZONE);

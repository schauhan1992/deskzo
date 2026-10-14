import type { Clock } from "@/lib/time/zone";

/**
 * Booking pages (owner, 14 Oct 2026 — Bigin's booking pages): a public page where a customer picks a
 * time to meet somebody in the team. Pure — what the settings screen, the public page, the booking and
 * `check:booking` share:
 *
 *   · the page's weekly hours, in the workspace's zone (`parseHours`);
 *   · the times it offers (`openSlots`): each host's hours, from the minimum notice to so many days on,
 *     less whatever their calendar or earlier bookings show busy, with the gap asked for kept clear;
 *   · who gets a booking (`pickHost`): of the hosts free then, the one with fewest bookings coming up.
 */

export const BOOKING_LIMITS = { title: 80, description: 1000, hosts: 10, rangesPerDay: 3, name: 120, email: 254, phone: 40, company: 200, notes: 1000 } as const;
export const DURATIONS = [15, 20, 30, 45, 60, 90, 120] as const;
const SLUG = /^[a-z0-9][a-z0-9-]{2,40}$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Monday "1" to Sunday "7", each day's ranges of "HH:MM" — none: closed that day. */
export type WeekHours = Record<"1" | "2" | "3" | "4" | "5" | "6" | "7", [string, string][]>;
export const WEEKDAYS = ["1", "2", "3", "4", "5", "6", "7"] as const;
export const WEEKDAY_NAMES: Record<(typeof WEEKDAYS)[number], string> = { "1": "Monday", "2": "Tuesday", "3": "Wednesday", "4": "Thursday", "5": "Friday", "6": "Saturday", "7": "Sunday" };

export function defaultHours(): WeekHours {
  const work: [string, string][] = [["09:00", "17:00"]];
  return { "1": work, "2": work, "3": work, "4": work, "5": work, "6": [], "7": [] };
}

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Weekly hours as stored, checked — or why they can't be used. */
export function parseHours(raw: unknown): { ok: true; hours: WeekHours } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Set the hours it can be booked." };
  const out = {} as WeekHours;
  let any = false;
  for (const day of WEEKDAYS) {
    const ranges = (raw as Record<string, unknown>)[day] ?? [];
    if (!Array.isArray(ranges)) return { ok: false, error: `Check ${WEEKDAY_NAMES[day]}'s hours.` };
    if (ranges.length > BOOKING_LIMITS.rangesPerDay) return { ok: false, error: `${WEEKDAY_NAMES[day]} can have ${BOOKING_LIMITS.rangesPerDay} spans of hours at most.` };
    const parsed: [string, string][] = [];
    for (const r of ranges) {
      if (!Array.isArray(r) || r.length !== 2 || !TIME.test(String(r[0])) || !TIME.test(String(r[1]))) return { ok: false, error: `Check ${WEEKDAY_NAMES[day]}'s hours.` };
      const [from, to] = [String(r[0]), String(r[1])];
      if (minutesOf(to) <= minutesOf(from)) return { ok: false, error: `On ${WEEKDAY_NAMES[day]}, each span must end after it starts.` };
      parsed.push([from, to]);
    }
    parsed.sort((a, b) => minutesOf(a[0]) - minutesOf(b[0]));
    for (let i = 1; i < parsed.length; i++) {
      if (minutesOf(parsed[i]![0]) < minutesOf(parsed[i - 1]![1])) return { ok: false, error: `${WEEKDAY_NAMES[day]}'s spans overlap.` };
    }
    if (parsed.length) any = true;
    out[day] = parsed;
  }
  if (!any) return { ok: false, error: "Open at least one day." };
  return { ok: true, hours: out };
}

export type BookingPageInput = {
  slug: string;
  title: string;
  description: string;
  durationMinutes: number;
  hostUserIds: string[];
  daysAhead: number;
  minNoticeHours: number;
  bufferMinutes: number;
};

/** What is wrong with a booking page as entered, or null. Hosts are checked against who may host by the caller. */
export function checkBookingPage(input: BookingPageInput): string | null {
  if (!SLUG.test(input.slug)) return "The address is 3 to 41 lower-case letters, digits and hyphens, starting with a letter or digit.";
  const title = input.title.trim();
  if (!title) return "Give the page a title.";
  if (title.length > BOOKING_LIMITS.title) return `Keep the title to ${BOOKING_LIMITS.title} characters.`;
  if (input.description.length > BOOKING_LIMITS.description) return `Keep the description to ${BOOKING_LIMITS.description} characters.`;
  if (!(DURATIONS as readonly number[]).includes(input.durationMinutes)) return "Choose how long a meeting is.";
  if (input.hostUserIds.length < 1) return "Choose who customers can meet.";
  if (input.hostUserIds.length > BOOKING_LIMITS.hosts) return `A page can have ${BOOKING_LIMITS.hosts} hosts at most.`;
  if (new Set(input.hostUserIds).size !== input.hostUserIds.length) return "Each host once.";
  if (!Number.isInteger(input.daysAhead) || input.daysAhead < 1 || input.daysAhead > 90) return "It can be booked 1 to 90 days ahead.";
  if (!Number.isInteger(input.minNoticeHours) || input.minNoticeHours < 0 || input.minNoticeHours > 336) return "The notice is 0 to 336 hours.";
  if (!Number.isInteger(input.bufferMinutes) || input.bufferMinutes < 0 || input.bufferMinutes > 120) return "The gap between meetings is 0 to 120 minutes.";
  return null;
}

export type Busy = { start: Date; end: Date };
export type SlotRules = { hours: WeekHours; durationMinutes: number; bufferMinutes: number; minNoticeHours: number; daysAhead: number };

const MINUTE = 60_000;

/** Where a slot may start within a span: every half hour, or every duration when it is shorter. */
const stepOf = (duration: number) => Math.min(30, duration);

/**
 * The times one host can be booked: their page's hours on each day from today to `daysAhead` on, in the
 * workspace's zone, at least `minNoticeHours` from now, and clear of everything busy by `bufferMinutes`
 * either side.
 */
export function openSlots(rules: SlotRules, busy: Busy[], clock: Clock, now: Date): Date[] {
  const out: Date[] = [];
  const earliest = now.getTime() + rules.minNoticeHours * 3_600_000;
  const duration = rules.durationMinutes * MINUTE;
  const buffer = rules.bufferMinutes * MINUTE;
  const today = clock.parts(now);
  for (let offset = 0; offset <= rules.daysAhead; offset++) {
    const midnight = clock.midnight(today.year, today.month, today.day + offset);
    const p = clock.parts(midnight);
    const weekday = (p.weekday === 0 ? "7" : String(p.weekday)) as keyof WeekHours;
    for (const [from, to] of rules.hours[weekday] ?? []) {
      const end = clock.at(p.year, p.month, p.day, Number(to.slice(0, 2)), Number(to.slice(3, 5))).getTime();
      for (let m = minutesOf(from); ; m += stepOf(rules.durationMinutes)) {
        const start = clock.at(p.year, p.month, p.day, Math.floor(m / 60), m % 60).getTime();
        if (start + duration > end) break;
        if (start < earliest) continue;
        const clash = busy.some((b) => start < b.end.getTime() + buffer && start + duration + buffer > b.start.getTime());
        if (!clash) out.push(new Date(start));
      }
    }
  }
  return out;
}

/**
 * Who a booking at `start` goes to: of the hosts free then, the one with the fewest bookings coming up —
 * the first of them as the page lists its hosts when it's a tie. Null when nobody is free.
 */
export function pickHost(start: Date, hosts: { id: string; slots: Date[]; upcoming: number }[]): string | null {
  const free = hosts.filter((h) => h.slots.some((s) => s.getTime() === start.getTime()));
  if (!free.length) return null;
  return free.reduce((best, h) => (h.upcoming < best.upcoming ? h : best)).id;
}

/** The slots a page offers: any host free, each time once, in order. */
export function pageSlots(hosts: { slots: Date[] }[]): Date[] {
  const all = new Map<number, Date>();
  for (const h of hosts) for (const s of h.slots) all.set(s.getTime(), s);
  return [...all.values()].sort((a, b) => a.getTime() - b.getTime());
}

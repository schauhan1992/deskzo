import type { GatewayMode } from "@/lib/console-shared/types";
import type { Clock } from "@/lib/time/zone";

/**
 * Small, pure formatters the console shares between server pages and client components. A moment is the
 * console's clock's to show (Settings › Time zone): `clock.dateTime`, `clock.date`, `clock.dayMonth`,
 * `clock.dateKey`, `clock.monthKey`, `clock.daysBetween` — from `consoleClock()` on the server and
 * `useClock()` in a client component. Month and weekday names are spelled out here rather than asked of
 * Intl, whose en-IN data writes September as "Sept" in some ICU versions and not in others — a page
 * rendered on the server and hydrated in a browser must read the same.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const DAY_MS = 86_400_000;

/** "2026-09" → "Sep 2026"; anything else comes back as it was. */
export function monthLabel(key: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  const month = match ? Number(match[2]) : 0;
  return match && month >= 1 && month <= 12 ? `${MONTHS[month - 1]} ${match[1]}` : key;
}

/** A `yyyy-mm-dd` day as "1 Sep 2026" (or "1 Sep"), read as the calendar date it names; anything else as it was. */
export function dayKeyLabel(dayKey: string, withYear = true): string {
  const parts = dayKeyParts(dayKey);
  if (!parts) return dayKey;
  return withYear ? `${parts.day} ${MONTHS[parts.month]} ${parts.year}` : `${parts.day} ${MONTHS[parts.month]}`;
}

function dayKeyParts(dayKey: string): { year: number; month: number; day: number; weekday: number; time: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const utc = new Date(Date.UTC(year, month, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month || utc.getUTCDate() !== day) return null;
  return { year, month, day, weekday: utc.getUTCDay(), time: utc.getTime() };
}

/** A day heading for grouped lists: "Today", "Yesterday", "Thu 24 Sep" (with the year when it is not this one). */
export function dayGroupLabel(dayKey: string, todayKey: string): string {
  const day = dayKeyParts(dayKey);
  const today = dayKeyParts(todayKey);
  if (!day) return dayKey;
  if (today) {
    if (day.time === today.time) return "Today";
    if (day.time === today.time - DAY_MS) return "Yesterday";
  }
  const base = `${WEEKDAYS[day.weekday]} ${day.day} ${MONTHS[day.month]}`;
  return today && today.year === day.year ? base : `${base} ${day.year}`;
}

/** "42 s", "4 min", "1 h 5 min", "2 h"; "—" when unknown. */
export function durationText(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return "< 1 s";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** Whole days from one instant to another, rounded up; negative when `to` is earlier. */
export function daysBetween(from: Date, to: Date): number {
  const days = Math.ceil((to.getTime() - from.getTime()) / DAY_MS);
  return days === 0 ? 0 : days; // never -0
}

const INTEGER = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

/** "1 workspace", "3 workspaces", "1,200 rows". */
export function plural(n: number, one: string, many?: string): string {
  return `${INTEGER.format(n)} ${n === 1 ? one : (many ?? `${one}s`)}`;
}

/** 950 → "950", 1,234 → "1.2k", 3,400,000 → "3.4M" — short enough for a tile or a badge. */
export function compactNumber(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs < 1000) return `${sign}${INTEGER.format(Math.round(abs))}`;
  for (const [unit, size] of [["k", 1e3], ["M", 1e6], ["B", 1e9]] as const) {
    const value = abs / size;
    // One decimal below 100 ("1.2k"), none above ("340k"); 999.96k rounds up into the next unit.
    const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
    if (rounded < 1000 || unit === "B") return `${sign}${String(rounded)}${unit}`;
  }
  return `${sign}${String(abs)}`;
}

/** "42%"; "—" when there is no whole to be a part of. */
export function percent(part: number, whole: number): string {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return "—";
  return `${Math.round((part / whole) * 100)}%`;
}

/** "Chrome on Windows", "Safari on iPhone", "Unknown device" — enough to recognise one's own sessions. */
export function deviceFromUserAgent(ua: string | null): string {
  if (!ua) return "Unknown device";
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Windows/.test(ua)
          ? "Windows"
          : /Mac OS X|Macintosh/.test(ua)
            ? "Mac"
            : /CrOS/.test(ua)
              ? "ChromeOS"
              : /Linux/.test(ua)
                ? "Linux"
                : null;
  // Order matters: every Chromium browser also says "Chrome", and Chrome also says "Safari".
  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /SamsungBrowser\//.test(ua)
        ? "Samsung Internet"
        : /Firefox\/|FxiOS\//.test(ua)
          ? "Firefox"
          : /Chrome\/|CriOS\/|Chromium\//.test(ua)
            ? "Chrome"
            : /Safari\//.test(ua)
              ? "Safari"
              : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? (os ? `A browser on ${os}` : "Unknown device");
}

/** "workspaces-2026-09-27.csv", dated on the console's clock. */
export function csvFilename(prefix: string, at: Date, clock: Clock): string {
  const safe = prefix.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "export";
  return `${safe}-${clock.dateKey(at)}.csv`;
}

/** Where to look something up in the gateway's own dashboard (test mode where the keys are test keys). */
export function gatewayDashboardUrl(gateway: "STRIPE" | "RAZORPAY", kind: "subscription" | "customer" | "invoice", id: string, mode: GatewayMode): string {
  const path = kind === "subscription" ? "subscriptions" : kind === "customer" ? "customers" : "invoices";
  const safeId = encodeURIComponent(id);
  if (gateway === "STRIPE") return `https://dashboard.stripe.com${mode === "test" ? "/test" : ""}/${path}/${safeId}`;
  return `https://dashboard.razorpay.com/app/${path}/${safeId}`;
}

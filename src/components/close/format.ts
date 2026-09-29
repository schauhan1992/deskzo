import { formatMoney } from "@/lib/currency";
import { monthLabel, parseMonthKey } from "@/lib/close/months";
import { istDateParts } from "@/lib/india-time";

/**
 * How the close screens write dates, months and money.
 *
 * Every date here is India's, whatever the browser's clock says: a task due on 3 October is due on
 * 3 October in Pune, and a calendar day stored as UTC midnight read in New York would be the 2nd.
 * Pure, so the server pages and the client components share it.
 */

const IST = "Asia/Kolkata";
const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The Indian calendar day of an instant — or of a calendar day stored as UTC midnight, which is 05:30
 * the same day in India. Month names are the app's own ("Sep"), not the locale's ("Sept").
 */
function istDay(at: Date | string): { year: number; month: number; day: number } {
  const { year, month, day } = istDateParts(new Date(at));
  return { year, month, day };
}

/** "3 Oct" — a due date inside a month everybody can see. */
export function dayShort(at: Date | string): string {
  const d = istDay(at);
  return `${d.day} ${SHORT[d.month]}`;
}

/** "3 Oct 2026". */
export function dayLong(at: Date | string): string {
  const d = istDay(at);
  return `${d.day} ${SHORT[d.month]} ${d.year}`;
}

/** "3 Oct 2026, 10:15 am" — when something happened. */
export function whenLong(at: Date | string): string {
  const time = new Intl.DateTimeFormat("en-IN", { timeZone: IST, hour: "numeric", minute: "2-digit" }).format(new Date(at));
  return `${dayLong(at)}, ${time}`;
}

/** "Sep 2026" from "2026-09" (or the long form, "September 2026"). */
export function monthOfKey(key: string, style: "short" | "long" = "short"): string {
  const month = parseMonthKey(key);
  return month ? monthLabel(month, style) : key;
}

/** Rupees, en-IN, two places. */
export function rupees(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return formatMoney(value, "INR");
}

/** Rupees without the paise when there are none: "₹41,200" in a sentence, "₹41,200.50" when it matters. */
export function rupeesShort(value: number): string {
  const whole = Math.abs(value - Math.round(value)) < 0.005;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(value);
}

/** "A", "A and B", "A, B and C". */
export function listOf(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;
}

/**
 * Why a flux row is flagged, the way somebody would say it: "Up 34% and ₹41,200", "Down 21% and
 * ₹30,000", or "New this month: ₹41,200" when there was nothing to compare with.
 */
export function fluxReason(row: { changePrev: number; changePrevPct: number | null }): string {
  const direction = row.changePrev >= 0 ? "Up" : "Down";
  const amount = rupeesShort(Math.abs(row.changePrev));
  if (row.changePrevPct === null) return `${row.changePrev >= 0 ? "New this month" : "Gone this month"}: ${amount}`;
  return `${direction} ${Math.abs(Math.round(row.changePrevPct)).toLocaleString("en-IN")}% and ${amount}`;
}

/** A change as it reads in a table: "+₹41,200.00 (+34%)". */
export function changeText(change: number, pct: number | null): string {
  if (Math.abs(change) < 0.005) return "—";
  const sign = change > 0 ? "+" : "−";
  const pctText = pct === null ? "" : ` (${sign}${Math.abs(Math.round(pct)).toLocaleString("en-IN")}%)`;
  return `${sign}${rupees(Math.abs(change))}${pctText}`;
}

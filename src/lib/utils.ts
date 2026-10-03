import { formatMoney } from "@/lib/currency";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/*
 * Dates are not formatted here: a moment is shown in the workspace's zone — `clock.date(at)`,
 * `clock.dateTimeShort(at)` from `workspaceClock()` or `useClock()` — and a `@db.Date` day as the
 * day it holds, `formatCalendarDay(day)` (src/lib/time/zone.ts). The old formatDate and formatDateTime
 * read the server's zone on the server and the reader's in the browser.
 */

/**
 * An amount, in rupees unless told otherwise.
 *
 * The second argument is optional so that the hundred or so existing call sites — all of which are
 * rupees, because everything but a trade document is — keep working untouched. Anywhere a document
 * has its own currency, pass it: a dollar invoice rendered with a rupee sign is a number that looks
 * right and is wrong by a factor of eighty.
 */
export function formatCurrency(value: number | string | null | undefined, currency?: string) {
  if (value === null || value === undefined) return "—";
  return formatMoney(value, currency ?? "INR");
}

/*
 * Nor are date filters built here: a list's From and To are the workspace's days — `clock.dayRange` for a
 * column holding a moment, `calendarDayRange` for a `@db.Date` one (src/lib/time/zone.ts). The old
 * dateRangeFilter read the server's zone.
 */

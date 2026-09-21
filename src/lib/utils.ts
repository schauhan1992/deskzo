import { formatMoney } from "@/lib/currency";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(date: Date | string | null | undefined) {
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(new Date(date));
}

/**
 * Date and time together, for records where the time of day is part of what happened — a call at
 * 10:15 and one at 16:40 are different facts about the same day.
 */
export function formatDateTime(date: Date | string | null | undefined) {
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(date));
}

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

/** Builds a Prisma `gte`/`lte` range from "YYYY-MM-DD" query params — `to` is inclusive
 * of the whole day, so it's pushed to 23:59:59.999 rather than midnight. */
export function dateRangeFilter(from?: string, to?: string) {
  const range: { gte?: Date; lte?: Date } = {};
  if (from) range.gte = new Date(`${from}T00:00:00`);
  if (to) range.lte = new Date(`${to}T23:59:59.999`);
  return Object.keys(range).length > 0 ? range : undefined;
}

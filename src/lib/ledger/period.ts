/**
 * The Indian financial year runs April to March, so "this year" on a report is almost never the
 * calendar year — defaulting to one would quietly give people the wrong period.
 */
export function financialYearBounds(date: Date) {
  const year = date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
  return {
    from: `${year}-04-01`,
    to: `${year + 1}-03-31`,
    label: `${year}-${String((year + 1) % 100).padStart(2, "0")}`,
  };
}

/**
 * Month names, kept here rather than beside the picker that uses them.
 *
 * A helper exported from a `"use client"` module can only be called from the client: the server
 * gets a reference it cannot invoke, which compiles fine and throws on the first request. Anything
 * both sides need has to live in a plain module like this one.
 */
export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

export function monthName(month: number) {
  return MONTH_NAMES[month - 1] ?? String(month);
}

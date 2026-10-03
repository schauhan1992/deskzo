import type { Clock } from "@/lib/time/zone";

// Guards against formula injection if the CSV is opened in Excel/Sheets — a cell value
// starting with one of these characters can be interpreted as a formula.
export function sanitizeCsvCell(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

/**
 * Undoes the guard above when reading one of our own CSVs back.
 *
 * Without this the protection quietly corrupts data: a part number of `-X1` is written as `'-X1`,
 * and an import of the file we just exported overwrites the stored value with the apostrophe
 * version. Every subsequent export adds another one.
 *
 * Only a quote followed by one of the four characters the sanitiser acts on is removed, so a value
 * that genuinely begins with an apostrophe is left alone. This is also what Excel itself does — a
 * leading apostrophe is its own "treat this as text" marker and is not part of the value.
 */
export function desanitizeCsvCell(value: string): string {
  return /^'[=+\-@]/.test(value) ? value.slice(1) : value;
}

/**
 * `leads-export-2026-10-02.csv` — dated on the clock passed in (the workspace's: `workspaceClock()`,
 * or `useClock()` in a client component), not UTC's, which is a day behind in India until 05:30.
 * The console's own exports use src/lib/console-shared/format.ts, which takes the same arguments.
 */
export function csvFilename(prefix: string, at: Date, clock: Clock) {
  return `${prefix}-${clock.dateKey(at)}.csv`;
}

/**
 * One CSV row, quoted, with only the text cells sanitised.
 *
 * `sanitizeCsvCell` guards against formula injection, and its test is `/^[=+\-@]/` — which a
 * *negative number* matches on the minus. So every negative measure went out as `'-1488`, which
 * Excel reads as text: it drops out of SUM, and an exported total came back larger than the one on
 * screen. Margin by customer over a full window has loss-making accounts in it, and the file's Total
 * column summed to 11,286,967 against the report's 11,278,550. Neither number is hypothetical, and
 * `margin` and "Invoiced (net of credit notes)" are both signed by design.
 *
 * A number cannot carry a formula, so narrowing the guard to strings loses nothing. It lives here
 * rather than inside the export action because that module is `"use server"`, where every export
 * must be an async function — which put the one piece of this worth testing out of a test's reach.
 */
export function csvRow(values: (string | number)[]): string {
  return values
    .map((v) => `"${(typeof v === "number" ? String(v) : sanitizeCsvCell(v)).replaceAll('"', '""')}"`)
    .join(",");
}

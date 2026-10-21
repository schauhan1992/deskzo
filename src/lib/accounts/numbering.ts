import type { Prisma } from "@prisma/client";
import { financialYearOf } from "@/lib/gst-engine";

/**
 * Numbers for Accounts' own vouchers (owner, 22 Oct 2026): PMT/2026-27/0001 for the first payment voucher of
 * the year, GRN/2026-27/0001 for the first goods receipt. Each series counts per financial year.
 *
 * Taken with an increment on the series' counter row inside the caller's transaction — the row lock it
 * takes is what keeps two people from getting the same number (the journal numbers this way too). A number
 * taken by a voucher that is then cancelled stays used: it has been seen, and a gap that says "cancelled"
 * is better than a number that means two things.
 */

export const ACCOUNTS_SERIES = {
  PAYMENT: { prefix: "PMT", label: "Payment vouchers" },
  RECEIPT: { prefix: "RCT", label: "Receipt vouchers" },
  CONTRA: { prefix: "CNT", label: "Contra vouchers" },
  JOURNAL: { prefix: "JNL", label: "Journal vouchers" },
  GRN: { prefix: "GRN", label: "Goods receipts" },
  TRANSFER: { prefix: "TRF", label: "Stock transfers" },
  ADJUSTMENT: { prefix: "ADJ", label: "Stock adjustments" },
  PHYSICAL_COUNT: { prefix: "PSC", label: "Physical stock counts" },
  PURCHASE_RETURN: { prefix: "PRN", label: "Purchase returns" },
} as const;

export type AccountsSeriesKey = keyof typeof ACCOUNTS_SERIES;

export function isSeriesKey(value: string): value is AccountsSeriesKey {
  return value in ACCOUNTS_SERIES;
}

/** A prefix as typed: letters, digits and dashes, up to eight. */
export function cleanPrefix(raw: string): string | null {
  const prefix = raw.trim().toUpperCase();
  return /^[A-Z0-9-]{1,8}$/.test(prefix) ? prefix : null;
}

export function formatAccountsNumber(prefix: string, financialYear: string, n: number): string {
  return `${prefix}/${financialYear}/${String(n).padStart(4, "0")}`;
}

export function prefixFor(series: AccountsSeriesKey, prefixes: Record<string, string>): string {
  return cleanPrefix(prefixes[series] ?? "") ?? ACCOUNTS_SERIES[series].prefix;
}

/** The next number in a series, for a voucher dated `date`. Inside the voucher's own transaction. */
export async function nextAccountsNumber(
  tx: Prisma.TransactionClient,
  series: AccountsSeriesKey,
  date: Date,
  prefixes: Record<string, string>,
): Promise<string> {
  const financialYear = financialYearOf(date);
  const row = await tx.accountsCounter.upsert({
    where: { series_financialYear: { series, financialYear } },
    create: { series, financialYear, lastNumber: 1 },
    update: { lastNumber: { increment: 1 } },
    select: { lastNumber: true },
  });
  return formatAccountsNumber(prefixFor(series, prefixes), financialYear, row.lastNumber);
}

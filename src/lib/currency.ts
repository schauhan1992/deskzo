/**
 * Money in a currency other than the one the books are kept in.
 *
 * ## What is and is not multi-currency here
 *
 * A **document** can be written in any of these. Its lines, its tax and its total are stored in that
 * currency, exactly as the customer will read them, and it prints that way.
 *
 * The **books are always in rupees.** A foreign-currency invoice posts to the ledger converted at
 * the rate agreed on the day it was raised — see `financialsOf` in lib/ledger/journal.ts, which
 * already did this before there was any way to set a rate. That is the right division: a customer
 * in Dubai is quoted in dirhams, and the statutory filings are in rupees whatever was quoted.
 *
 * ## The rate is typed, not fetched
 *
 * Deliberately. A live feed means the figure on a saved document changes depending on when it is
 * reopened, and the rate that matters is the one the two parties agreed — which is a commercial
 * fact, not a market observation. Somebody types it once and the document keeps it.
 */

export type CurrencyCode = (typeof CURRENCIES)[number]["code"];

/**
 * The currencies on offer, base first.
 *
 * `decimals` is not decoration: the yen has none, and rendering ¥1,200.00 marks the document out as
 * having been produced by somebody who does not deal in yen.
 */
export const CURRENCIES = [
  { code: "INR", symbol: "₹", label: "Indian Rupee", decimals: 2, grouping: "indian",
    words: { one: "Rupee", many: "Rupees", subOne: "Paisa", subMany: "Paise" } },
  { code: "USD", symbol: "$", label: "US Dollar", decimals: 2, grouping: "western",
    words: { one: "Dollar", many: "Dollars", subOne: "Cent", subMany: "Cents" } },
  { code: "EUR", symbol: "€", label: "Euro", decimals: 2, grouping: "western",
    words: { one: "Euro", many: "Euros", subOne: "Cent", subMany: "Cents" } },
  { code: "GBP", symbol: "£", label: "Pound Sterling", decimals: 2, grouping: "western",
    words: { one: "Pound", many: "Pounds", subOne: "Penny", subMany: "Pence" } },
  { code: "AED", symbol: "AED", label: "UAE Dirham", decimals: 2, grouping: "western",
    words: { one: "Dirham", many: "Dirhams", subOne: "Fils", subMany: "Fils" } },
  { code: "SGD", symbol: "S$", label: "Singapore Dollar", decimals: 2, grouping: "western",
    words: { one: "Singapore Dollar", many: "Singapore Dollars", subOne: "Cent", subMany: "Cents" } },
  { code: "AUD", symbol: "A$", label: "Australian Dollar", decimals: 2, grouping: "western",
    words: { one: "Australian Dollar", many: "Australian Dollars", subOne: "Cent", subMany: "Cents" } },
  { code: "CAD", symbol: "C$", label: "Canadian Dollar", decimals: 2, grouping: "western",
    words: { one: "Canadian Dollar", many: "Canadian Dollars", subOne: "Cent", subMany: "Cents" } },
  // No subunit in circulation, and `decimals: 0` means one can never be reached anyway.
  { code: "JPY", symbol: "¥", label: "Japanese Yen", decimals: 0, grouping: "western",
    words: { one: "Yen", many: "Yen", subOne: null, subMany: null } },
  { code: "CHF", symbol: "CHF", label: "Swiss Franc", decimals: 2, grouping: "western",
    words: { one: "Franc", many: "Francs", subOne: "Centime", subMany: "Centimes" } },
  { code: "SAR", symbol: "SAR", label: "Saudi Riyal", decimals: 2, grouping: "western",
    words: { one: "Riyal", many: "Riyals", subOne: "Halala", subMany: "Halalas" } },
  { code: "MYR", symbol: "RM", label: "Malaysian Ringgit", decimals: 2, grouping: "western",
    words: { one: "Ringgit", many: "Ringgit", subOne: "Sen", subMany: "Sen" } },
  // Lakh and crore are native to Sri Lanka and Bangladesh too, so these group the Indian way.
  { code: "LKR", symbol: "Rs", label: "Sri Lankan Rupee", decimals: 2, grouping: "indian",
    words: { one: "Rupee", many: "Rupees", subOne: "Cent", subMany: "Cents" } },
  { code: "BDT", symbol: "৳", label: "Bangladeshi Taka", decimals: 2, grouping: "indian",
    words: { one: "Taka", many: "Taka", subOne: "Poisha", subMany: "Poisha" } },
] as const;

/** The one the ledger, the reports and every statutory return are in. */
export const BASE_CURRENCY = "INR";

export const CURRENCY_CODES = CURRENCIES.map((c) => c.code);

export function getCurrency(code: string) {
  return CURRENCIES.find((c) => c.code === code) ?? CURRENCIES[0];
}

export function isBaseCurrency(code: string | null | undefined) {
  return !code || code === BASE_CURRENCY;
}

/**
 * An amount in its own currency.
 *
 * Rupees keep the Indian grouping — ₹19,96,85,430, not ₹199,685,430 — because that is how the
 * number is read here and a lakh written in thousands is a number somebody has to translate. Every
 * other currency uses its own locale's grouping for the same reason.
 */
export function formatMoney(value: number | string | null | undefined, code: string = BASE_CURRENCY): string {
  if (value === null || value === undefined || value === "") return "—";
  const currency = getCurrency(code);
  const locale = currency.grouping === "indian" ? "en-IN" : "en-US";
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency.code,
    minimumFractionDigits: currency.decimals,
    maximumFractionDigits: currency.decimals,
  }).format(Number(value));
}

/**
 * An exchange rate, at the precision it is actually stored and converted at.
 *
 * Deliberately not `formatMoney`, which rounds to the rupee's two places. A rate shown as ₹26.07
 * while the conversion used 26.0682 makes the document disagree with itself: 32,000 × 26.07 is not
 * the rupee total printed beneath it, and a customer reconciling the two finds a discrepancy that
 * is not really there. Trailing zeros are trimmed so a clean 83.25 does not print as 83.250000.
 */
export function formatRate(rate: number | string | null | undefined): string {
  if (rate === null || rate === undefined || rate === "") return "—";
  const fixed = Number(rate).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return `${getCurrency(BASE_CURRENCY).symbol}${Number(fixed).toLocaleString("en-IN", {
    minimumFractionDigits: Math.max(2, (fixed.split(".")[1] ?? "").length),
    maximumFractionDigits: 6,
  })}`;
}

/** What a foreign amount comes to in the books. */
export function toBase(value: number, rate: number): number {
  return Math.round(value * rate * 100) / 100;
}

/**
 * "1 USD = ₹83.25", for the line under a rate field.
 *
 * Written this way round on purpose: a rate stored as "rupees per unit of foreign currency" is the
 * one people quote, and inverting it in the display is how somebody ends up entering 0.012.
 */
export function rateHint(code: string, rate: number): string {
  if (isBaseCurrency(code)) return "";
  return `1 ${code} = ${formatRate(rate)}`;
}

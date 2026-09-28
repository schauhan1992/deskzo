/**
 * GST computation for trade documents.
 *
 * The rule that shapes everything here: a supply is taxed either as CGST + SGST (half the rate
 * each) when the seller's state and the place of supply match, or as a single IGST charge when they
 * don't. Getting that wrong produces an invoice the buyer can't claim input credit on, so the
 * decision is made once, in `resolveSupplyType`, and every line follows it.
 *
 * Tax is computed per line and then summed — never on the invoice total — because rounding a mixed
 * -rate invoice at the total gives a different (and wrong) answer to the sum of its lines.
 */

import { BASE_CURRENCY, getCurrency } from "@/lib/currency";
import { istDateParts } from "@/lib/india-time";

export type SupplyType = "INTRA_STATE" | "INTER_STATE";

export const GST_STATE_CODES: Record<string, string> = {
  "01": "Jammu & Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh",
  "05": "Uttarakhand", "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh",
  "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur",
  "15": "Mizoram", "16": "Tripura", "17": "Meghalaya", "18": "Assam", "19": "West Bengal",
  "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat",
  "26": "Dadra & Nagar Haveli and Daman & Diu", "27": "Maharashtra", "29": "Karnataka",
  "30": "Goa", "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry",
  "35": "Andaman & Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh",
  "97": "Other Territory", "96": "Other Country",
};

/**
 * The same codes as a sorted list. Object key order puts "10" before "01" — JavaScript hoists
 * integer-like keys — which would show Jammu & Kashmir below Other Territory in every dropdown.
 */
export const GST_STATE_OPTIONS = Object.entries(GST_STATE_CODES)
  .map(([code, name]) => ({ code, name }))
  .sort((a, b) => a.code.localeCompare(b.code));

/** A GSTIN's first two digits are its state code — the cheapest reliable way to get the party's state. */
export function stateCodeFromGstin(gstin?: string | null) {
  if (!gstin) return null;
  const code = gstin.trim().slice(0, 2);
  return GST_STATE_CODES[code] ? code : null;
}

/**
 * A state name back to its GST code.
 *
 * The reverse lookup, for the places that hold a state as a name rather than as a code — a
 * company location, a typed address. Matched case- and punctuation-insensitively, because "Tamil
 * Nadu", "TAMILNADU" and "tamil-nadu" are all the same state and none of them is a typo worth
 * refusing an address over.
 */
/**
 * A state name reduced to the letters that identify it.
 *
 * "&" and "and" are the same word. The table below writes "Jammu & Kashmir"; India Post, the GST
 * portal's own exports and most people typing write "Jammu and Kashmir" — and stripping punctuation
 * alone turned those into `jammukashmir` and `jammuandkashmir`, two different keys for one state.
 * Every state with an ampersand in its name failed that way and was quietly taxed as inter-state.
 * Dropping "and" as a whole *word* is safe: no state name contains it as one except as a joiner,
 * and "Andaman" keeps its letters because it is a different token.
 */
export function stateKey(name: string): string {
  return name
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word && word !== "and" && word !== "the")
    .join("");
}

/**
 * Official names that were right when somebody wrote them down.
 *
 * Each is a real, former or alternative name for exactly one GST state, not a guess at a typo — the
 * India Post directory still publishes several of them, and a customer record typed years ago says
 * "Orissa" for the same reason. The two halves of Dadra & Nagar Haveli and Daman & Diu were separate
 * union territories until 2020 and both now carry code 26. "harayna" is deliberately absent: a typo
 * resolving to a state would hide exactly the mistake the address picker exists to surface.
 */
const STATE_ALIASES: Record<string, string> = {
  orissa: "21",
  pondicherry: "34",
  chattisgarh: "22",
  uttaranchal: "05",
  dadranagarhaveli: "26",
  damandiu: "26",
  nctofdelhi: "07",
  newdelhi: "07",
  andamannicobar: "35",
};

const STATE_CODE_BY_NAME = new Map([
  ...Object.entries(GST_STATE_CODES).map(([code, name]) => [stateKey(name), code] as const),
  ...Object.entries(STATE_ALIASES),
]);

export function stateCodeFromName(state?: string | null) {
  if (!state) return null;
  return STATE_CODE_BY_NAME.get(stateKey(state.trim())) ?? null;
}

export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z][Z][0-9A-Z]$/;

export function isValidGstin(gstin: string) {
  return GSTIN_PATTERN.test(gstin.trim().toUpperCase());
}

const GSTIN_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * The fifteenth character of a GSTIN, from its first fourteen: Luhn mod 36 over 0-9A-Z.
 *
 * Null when the input is not fourteen characters of that alphabet, so a caller can't mistake "could
 * not compute" for a check character.
 */
export function gstinCheckCharacter(first14: string): string | null {
  if (first14.length !== 14) return null;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = GSTIN_ALPHABET.indexOf(first14[i]);
    if (value < 0) return null;
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_ALPHABET[(36 - (sum % 36)) % 36];
}

/**
 * The pattern and the checksum — for **our own** registrations only.
 *
 * `isValidGstin` stays pattern-only on purpose: customer GSTINs typed years ago, and several suite
 * fixtures, would fail the checksum, and refusing a customer's address over it helps nobody. Our own
 * GSTIN is different — a mistyped one goes on every invoice and every return.
 */
export function hasValidGstinChecksum(gstin: string): boolean {
  const value = gstin.trim().toUpperCase();
  return GSTIN_PATTERN.test(value) && gstinCheckCharacter(value.slice(0, 14)) === value[14];
}

/** Characters 3–12 of a GSTIN are its holder's PAN — what makes two GSTINs one company. */
export function panOfGstin(gstin: string | null | undefined): string | null {
  const value = gstin?.trim().toUpperCase();
  return value && GSTIN_PATTERN.test(value) ? value.slice(2, 12) : null;
}

/**
 * Default short codes for a registration, vehicle-registration style (owner decision Q7) — what `{GST}`
 * prints in a number prefix until somebody edits it. Every GST state except 96, "Other Country", which
 * no Indian registration can be in. The migration's CASE has the same table.
 */
export const GST_STATE_ABBREVIATIONS: Record<string, string> = {
  "01": "JK", "02": "HP", "03": "PB", "04": "CH", "05": "UK", "06": "HR", "07": "DL", "08": "RJ", "09": "UP",
  "10": "BR", "11": "SK", "12": "AR", "13": "NL", "14": "MN", "15": "MZ", "16": "TR", "17": "ML", "18": "AS",
  "19": "WB", "20": "JH", "21": "OD", "22": "CG", "23": "MP", "24": "GJ", "26": "DD", "27": "MH", "29": "KA",
  "30": "GA", "31": "LD", "32": "KL", "33": "TN", "34": "PY", "35": "AN", "36": "TG", "37": "AP", "38": "LA",
  "97": "OT",
};

/**
 * Intra-state when the seller and the place of supply share a state code. Anything else — including
 * a missing place of supply, where inter-state is the safer assumption — is IGST.
 */
export function resolveSupplyType(sellerStateCode?: string | null, placeOfSupplyCode?: string | null): SupplyType {
  if (!sellerStateCode || !placeOfSupplyCode) return "INTER_STATE";
  return sellerStateCode === placeOfSupplyCode ? "INTRA_STATE" : "INTER_STATE";
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export type DiscountMode = "PERCENT" | "AMOUNT";

export type LineInput = {
  quantity: number;
  unitPrice: number;
  /** A percentage of the line, or a flat rupee amount off it. */
  discountMode?: DiscountMode;
  discountValue?: number;
  taxRatePercent?: number;
};

export type ComputedLine = {
  gross: number;
  discountAmount: number;
  taxableValue: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  lineTotal: number;
};

export function computeLine(line: LineInput, supplyType: SupplyType): ComputedLine {
  const gross = round2(line.quantity * line.unitPrice);
  const value = line.discountValue ?? 0;
  // A flat discount is capped at the line: a discount larger than what is being sold would produce
  // a negative taxable value, which is not a discount, it is a credit note.
  const discountAmount =
    line.discountMode === "AMOUNT" ? Math.min(round2(value), gross) : round2((gross * value) / 100);
  const taxableValue = round2(gross - discountAmount);
  const taxAmount = round2((taxableValue * (line.taxRatePercent ?? 0)) / 100);

  // Half each for CGST/SGST. Splitting the already-rounded total keeps the two halves adding back
  // to it exactly, which splitting the rate separately would not guarantee.
  const half = round2(taxAmount / 2);
  const cgstAmount = supplyType === "INTRA_STATE" ? half : 0;
  const sgstAmount = supplyType === "INTRA_STATE" ? round2(taxAmount - half) : 0;
  const igstAmount = supplyType === "INTER_STATE" ? taxAmount : 0;

  return {
    gross,
    discountAmount,
    taxableValue,
    cgstAmount,
    sgstAmount,
    igstAmount,
    lineTotal: round2(taxableValue + cgstAmount + sgstAmount + igstAmount),
  };
}

export type DocumentExtras = {
  /** Freight billed on, taxed at its own rate rather than the lines'. */
  shippingCharge?: number;
  shippingTaxRatePercent?: number;
  /** TDS reduces what the customer pays; TCS adds to it. Both are a % of the taxable value. */
  withholdingMode?: "NONE" | "TDS" | "TCS";
  withholdingRatePercent?: number;
  /** A free-text plus or minus applied to the total. */
  adjustment?: number;
  /**
   * Round the total to the nearest rupee and record the difference. Usual on an Indian invoice,
   * but a preference rather than a rule — some businesses bill to the paisa.
   */
  roundOff?: boolean;
};

export type ComputedDocument = {
  lines: ComputedLine[];
  subtotal: number;
  discountTotal: number;
  taxableValue: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  shippingCharge: number;
  shippingTax: number;
  withholdingAmount: number;
  adjustment: number;
  roundOff: number;
  total: number;
  supplyType: SupplyType;
};

/**
 * Totals are the sum of the computed lines, then rounded to the nearest rupee — the round-off is
 * kept as its own figure because an invoice has to show it as a separate line to reconcile.
 */
export function computeDocument(
  lines: LineInput[],
  supplyType: SupplyType,
  extras: DocumentExtras = {},
): ComputedDocument {
  const computed = lines.map((line) => computeLine(line, supplyType));

  const sum = (pick: (l: ComputedLine) => number) => round2(computed.reduce((total, l) => total + pick(l), 0));
  const subtotal = sum((l) => l.gross);
  const discountTotal = sum((l) => l.discountAmount);
  const lineTaxable = sum((l) => l.taxableValue);

  // Freight is a supply in its own right, taxed at its own rate and split the same way the lines
  // are — so it joins the taxable value rather than being bolted onto the total after tax.
  const shippingCharge = round2(extras.shippingCharge ?? 0);
  const shippingTax = round2((shippingCharge * (extras.shippingTaxRatePercent ?? 0)) / 100);
  const shippingHalf = round2(shippingTax / 2);

  const taxableValue = round2(lineTaxable + shippingCharge);
  const cgstAmount = round2(sum((l) => l.cgstAmount) + (supplyType === "INTRA_STATE" ? shippingHalf : 0));
  const sgstAmount = round2(
    sum((l) => l.sgstAmount) + (supplyType === "INTRA_STATE" ? round2(shippingTax - shippingHalf) : 0),
  );
  const igstAmount = round2(sum((l) => l.igstAmount) + (supplyType === "INTER_STATE" ? shippingTax : 0));

  // TDS/TCS is reckoned on the taxable value, not the tax-inclusive total — that is how both are
  // assessed, and computing them on the gross overstates the deduction.
  const withholdingRate = extras.withholdingRatePercent ?? 0;
  const withholdingBase = round2((taxableValue * withholdingRate) / 100);
  const withholdingAmount =
    extras.withholdingMode === "TDS" ? -withholdingBase : extras.withholdingMode === "TCS" ? withholdingBase : 0;

  const adjustment = round2(extras.adjustment ?? 0);

  const beforeRounding = round2(
    taxableValue + cgstAmount + sgstAmount + igstAmount + withholdingAmount + adjustment,
  );
  const total = extras.roundOff === false ? beforeRounding : Math.round(beforeRounding);
  const roundOff = round2(total - beforeRounding);

  return {
    lines: computed,
    subtotal,
    discountTotal,
    taxableValue,
    cgstAmount,
    sgstAmount,
    igstAmount,
    shippingCharge,
    shippingTax,
    withholdingAmount,
    adjustment,
    roundOff,
    total,
    supplyType,
  };
}

/** The calendar year an Indian financial year starts in — read on India's calendar, not the host's. */
function financialYearStart(date: Date) {
  const { year, month } = istDateParts(date);
  return month >= 3 ? year : year - 1;
}

/**
 * Indian financial year (April–March) a date falls in, e.g. "2026-27" — the unit invoice series reset on.
 *
 * On India's calendar (X5): read from the host's, an invoice issued between midnight and 05:30 IST on
 * 1 April took the previous year's prefix and journal series on a server running in UTC.
 */
export function financialYearOf(date: Date) {
  const startYear = financialYearStart(date);
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

/** The same year in four digits, "2627" — `{FY2}`, for prefixes that must fit GST's 16 characters. */
export function shortFinancialYear(date: Date) {
  const startYear = financialYearStart(date);
  return `${String(startYear % 100).padStart(2, "0")}${String((startYear + 1) % 100).padStart(2, "0")}`;
}

const UNITS = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function twoDigits(n: number): string {
  if (n < 20) return UNITS[n];
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${UNITS[n % 10]}` : ""}`;
}

function belowThousand(n: number): string {
  const hundred = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (hundred) parts.push(`${UNITS[hundred]} Hundred`);
  if (rest) parts.push(twoDigits(rest));
  return parts.join(" ");
}

/**
 * Where a currency puts its separators when it is spoken.
 *
 * Not cosmetic. "Eight Lakh Seventy Thousand Dollars" is not a sum an American reads, and the
 * figure in words is the one that governs if it disagrees with the numerals — so a document that
 * groups the wrong way is a document whose binding amount is unreadable to its recipient.
 */
const SCALES = {
  indian: [
    { value: 10000000, name: "Crore" },
    { value: 100000, name: "Lakh" },
    { value: 1000, name: "Thousand" },
  ],
  western: [
    { value: 1000000000, name: "Billion" },
    { value: 1000000, name: "Million" },
    { value: 1000, name: "Thousand" },
  ],
} as const;

function wholeWords(n: number, grouping: "indian" | "western"): string {
  const parts: string[] = [];
  let left = n;
  for (const scale of SCALES[grouping]) {
    const count = Math.floor(left / scale.value);
    if (!count) continue;
    // Recursive rather than two-digit: the top group runs past 99 on its own. ₹100,00,00,000 is
    // "One Hundred Crore", which the old two-digit helper rendered as "undefined Crore".
    parts.push(`${wholeWords(count, grouping)} ${scale.name}`);
    left -= count * scale.value;
  }
  if (left) parts.push(belowThousand(left));
  return parts.join(" ");
}

/**
 * Amount in words, in the currency the document is written in.
 *
 * Defaults to rupees, which is what every caller that predates multi-currency wants and what a
 * payslip will always want.
 */
export function amountInWords(amount: number, code: string = BASE_CURRENCY): string {
  const { words, decimals, grouping } = getCurrency(code);
  const abs = Math.abs(amount);
  let whole = Math.floor(abs);
  // Carried rather than left to round on its own: 1.999 puts 100 in the subunit, and "One Rupee
  // and Hundred Paise" on an invoice is the kind of thing a customer queries.
  let sub = decimals === 0 ? 0 : Math.round((abs - whole) * 100);
  if (sub === 100) {
    whole += 1;
    sub = 0;
  }

  if (whole === 0 && sub === 0) return `Zero ${words.many} Only`;

  const sign = amount < 0 ? "Minus " : "";
  const major = whole > 0 ? `${wholeWords(whole, grouping)} ${whole === 1 ? words.one : words.many}` : "";
  if (!sub || !words.subMany) return `${sign}${major} Only`;
  return `${sign}${major ? `${major} and ` : ""}${twoDigits(sub)} ${sub === 1 ? words.subOne : words.subMany} Only`;
}

/** The GST "state" of a party outside India — place of supply for an export. */
export const OTHER_COUNTRY_CODE = "96";

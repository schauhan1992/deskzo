import type { DocumentSeriesScope, TradeDocumentType } from "@prisma/client";
import { documentPrefixes } from "@/lib/trade-documents";
import { financialYearOf, shortFinancialYear } from "@/lib/gst-engine";

/**
 * Document numbers are built from a prefix and a running serial, both editable per document type —
 * the way Zoho Books does it, because a business's number format is usually inherited from whatever
 * it used before and isn't ours to dictate.
 *
 * Tokens in a prefix:
 *   · `{FY}`  — the Indian financial year, so `WT/{FY}/QT/` renders as `WT/2026-27/QT/`. That keeps the
 *               year in the number without needing a separate counter reset.
 *   · `{FY2}` — the same year in four characters, `2627`, for prefixes that must fit GST's 16.
 *   · `{GST}` — the GST registration's short code (`MH`), empty when the branch has none.
 *   · `{BR}`  — the branch's code.
 */
export const FY_TOKEN = "{FY}";
export const FY2_TOKEN = "{FY2}";
export const GST_TOKEN = "{GST}";
export const BR_TOKEN = "{BR}";

/** What `{GST}` and `{BR}` expand to: the branch a number is allocated for, and its registration. */
export type PrefixContext = { branchCode?: string | null; registrationCode?: string | null };

export function expandPrefix(prefix: string, date: Date, ctx: PrefixContext = {}) {
  return prefix
    .replaceAll(FY2_TOKEN, shortFinancialYear(date))
    .replaceAll(FY_TOKEN, financialYearOf(date))
    .replaceAll(GST_TOKEN, ctx.registrationCode ?? "")
    .replaceAll(BR_TOKEN, ctx.branchCode ?? "");
}

export function buildDocumentNumber(prefix: string, nextNumber: number, padding: number, date: Date, ctx?: PrefixContext) {
  return `${expandPrefix(prefix, date, ctx)}${String(nextNumber).padStart(Math.max(padding, 1), "0")}`;
}

/**
 * The prefix a new per-registration or per-branch series starts with, from the type's template.
 *
 * `INV/{FY}/` becomes `{GST}/INV/{FY2}/` (or `{BR}/INV/{FY2}/`): the owner's code in front, so two
 * series of one type can never print the same number, and the short year so the result still fits
 * 16 characters — `MH/INV/2627/0001` is exactly 16. A template that already names `{GST}` or `{BR}`
 * was written for this and is used as it is.
 */
export function derivedSeriesPrefix(template: string, scope: "REGISTRATION" | "BRANCH"): string {
  if (template.includes(GST_TOKEN) || template.includes(BR_TOKEN)) return template;
  const owner = scope === "REGISTRATION" ? GST_TOKEN : BR_TOKEN;
  return `${owner}/${template.replaceAll(FY_TOKEN, FY2_TOKEN)}`;
}

/**
 * The types whose number is a GST document number: a tax invoice, a credit note (Rule 46(b), 53) and a
 * delivery challan (Rule 55). The IRP's `DocDtls.No` takes the same rules for the first two.
 */
export const GST_NUMBERED_TYPES: readonly TradeDocumentType[] = ["INVOICE", "CREDIT_NOTE", "DELIVERY_CHALLAN"];

const GST_NUMBER_MAX = 16;
const GST_NUMBER_SHAPE = /^[A-Za-z1-9][A-Za-z0-9/-]*$/;

/**
 * Null, or why this number cannot go on a GST document: more than 16 characters, or a character (or a
 * first character) the IRP refuses. Other types are not GST documents and pass whatever they are.
 */
export function gstNumberProblem(docType: TradeDocumentType, docNumber: string): string | null {
  if (!GST_NUMBERED_TYPES.includes(docType)) return null;
  if (docNumber.length > GST_NUMBER_MAX) {
    return `GST allows at most 16 characters in a document number — this one has ${docNumber.length}.`;
  }
  if (!GST_NUMBER_SHAPE.test(docNumber)) {
    return "A GST document number may use only letters, digits, / and -, and cannot start with 0, / or -.";
  }
  return null;
}

/**
 * Not refused, but worth saying: a format that fits today and will pass 16 characters once the serial
 * outgrows its padding — `INV/{FY}/` with four digits is 16 until invoice 10,000 and 17 after it.
 *
 * Null when it never will (within a serial the database can hold), and null when it already fails:
 * that is `gstNumberProblem`'s to refuse. The financial year only changes digits, never length, so the
 * answer does not depend on the date.
 */
export function numberFormatWarning(
  docType: TradeDocumentType,
  prefix: string,
  nextNumber: number,
  padding: number,
  ctx?: PrefixContext,
): string | null {
  if (!GST_NUMBERED_TYPES.includes(docType)) return null;
  const now = new Date();
  const prefixLength = expandPrefix(prefix, now, ctx).length;
  // The first width of serial that no longer fits, and the first serial of that width. Past ten digits
  // it is beyond what the serial column holds.
  const width = GST_NUMBER_MAX + 1 - prefixLength;
  if (width <= Math.max(padding, 1) || width > 10) return null;
  const serial = 10 ** (width - 1);
  if (serial <= nextNumber) return null;
  const example = buildDocumentNumber(prefix, serial, padding, now, ctx);
  return `Numbers will exceed 16 characters at serial ${serial.toLocaleString("en-IN")} (${example}) — GST allows 16. Shorten the prefix, or use {FY2} for the year.`;
}

/** The format a type starts with before anyone changes it — the existing `INV/2026-27/0001` shape. */
export function defaultNumberSetting(docType: TradeDocumentType) {
  return { prefix: `${documentPrefixes[docType]}/${FY_TOKEN}/`, nextNumber: 1, padding: 4, mode: "AUTO" as const };
}

/**
 * Whose series a type's numbers are counted in. One for the company is today's behaviour and every
 * type's default; one per GSTIN is what Rule 46(b) reads most naturally as — CA question C1 decides
 * which to recommend, and the choice stays per type.
 */
export const numberScopeLabels: Record<DocumentSeriesScope, string> = {
  COMPANY: "One for the company",
  REGISTRATION: "One per GST registration",
  BRANCH: "One per branch",
};

/** A draft has no place in the series yet, so it carries a marker until it's numbered. */
export function isDraftNumber(docNumber: string) {
  return docNumber.startsWith("DRAFT-");
}

export const numberModeLabels = {
  AUTO: "Continue auto-generating numbers",
  MANUAL: "Enter numbers manually",
} as const;

/**
 * The serial a freshly created setting should start from, given the numbers already in use.
 *
 * Without this, turning numbering on in an existing system starts at 1 and immediately collides
 * with documents issued under whatever scheme came before — the first save fails with "already
 * used", which is correct but useless. Reading the highest trailing number off existing documents
 * picks up where the old scheme left off.
 */
export function startingSerial(existingNumbers: string[]) {
  let highest = 0;
  for (const number of existingNumbers) {
    const trailing = /(\d+)\s*$/.exec(number);
    if (!trailing) continue;
    const value = Number(trailing[1]);
    if (Number.isFinite(value) && value > highest) highest = value;
  }
  return highest + 1;
}

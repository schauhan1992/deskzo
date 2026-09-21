import type { TradeDocumentType } from "@prisma/client";
import { documentPrefixes } from "@/lib/trade-documents";
import { financialYearOf } from "@/lib/gst-engine";

/**
 * Document numbers are built from a prefix and a running serial, both editable per document type —
 * the way Zoho Books does it, because a business's number format is usually inherited from whatever
 * it used before and isn't ours to dictate.
 *
 * `{FY}` in a prefix expands to the Indian financial year, so `WT/{FY}/QT/` renders as
 * `WT/2026-27/QT/`. That keeps the year in the number without needing a separate counter reset.
 */
export const FY_TOKEN = "{FY}";

export function expandPrefix(prefix: string, date: Date) {
  return prefix.replaceAll(FY_TOKEN, financialYearOf(date));
}

export function buildDocumentNumber(prefix: string, nextNumber: number, padding: number, date: Date) {
  return `${expandPrefix(prefix, date)}${String(nextNumber).padStart(Math.max(padding, 1), "0")}`;
}

/** The format a type starts with before anyone changes it — the existing `INV/2026-27/0001` shape. */
export function defaultNumberSetting(docType: TradeDocumentType) {
  return { prefix: `${documentPrefixes[docType]}/${FY_TOKEN}/`, nextNumber: 1, padding: 4, mode: "AUTO" as const };
}

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

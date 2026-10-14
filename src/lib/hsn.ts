import { HSN_PATTERN, normaliseHsn } from "@/lib/items/catalogue-import";

/**
 * HSN and SAC codes: what one has to look like, and which kind of item takes which.
 *
 * Pure, so the item form, the actions and the checks share one answer. Whether a code is *real* is a
 * question for the GST directory (src/lib/platform/hsn-directory.ts); this is everything that can be
 * told without it.
 *
 * ## Goods and services
 *
 * HSN codes classify goods, SAC codes services, and every SAC starts with 99 — chapter 99 is not a
 * chapter of goods. A good with a 99 code, or a service without one, is an invoice line filed under
 * the wrong schedule.
 *
 * An item is goods or a service; a service may be sold as a subscription or as a perpetual licence (the
 * item form's "Sub type"), so those two are services too and take a SAC — software licensed or
 * provided electronically is 99733x/99831x. Software sold on a physical medium is goods, sold one-time.
 */

export type HsnKind = "GOODS" | "SERVICES";
type ItemTypeKey = "GOOD" | "SERVICE" | "SUBSCRIPTION" | "PERPETUAL";

export const HSN_REQUIRED_MESSAGE = "HSN/SAC is required — search the GST directory by code or description.";

/** Goods or services, from the code alone. */
export function kindOfCode(code: string): HsnKind {
  return code.startsWith("99") ? "SERVICES" : "GOODS";
}

/** The kind of code an item type carries: goods an HSN, every kind of service a SAC. */
export function kindsForItemType(type: string | null | undefined): HsnKind[] {
  if (type === "GOOD") return ["GOODS"];
  if (type === "SERVICE" || type === "SUBSCRIPTION" || type === "PERPETUAL") return ["SERVICES"];
  return ["GOODS", "SERVICES"];
}

/**
 * What is wrong with an item's code without asking the directory, or null: missing, the wrong shape,
 * or the wrong kind for the item. `code` may be as typed — spaces and dots are dropped first.
 */
export function hsnShapeIssue(value: unknown, type: ItemTypeKey | string | null | undefined): string | null {
  const code = normaliseHsn(value);
  if (code === "") return HSN_REQUIRED_MESSAGE;
  if (!HSN_PATTERN.test(code)) return "HSN/SAC must be 4, 6 or 8 digits.";
  const allowed = kindsForItemType(type);
  const kind = kindOfCode(code);
  if (!allowed.includes(kind)) {
    if (kind === "SERVICES") return `${code} is a SAC (services) code — goods take an HSN code.`;
    const what = type === "SUBSCRIPTION" ? "a subscription is a service, and" : type === "PERPETUAL" ? "a perpetual licence is a service, and" : "a service";
    return `${code} is an HSN (goods) code — ${what} takes a SAC code, which starts with 99.`;
  }
  return null;
}

/**
 * A code as the portal's spreadsheet lists it, cleaned: digits only, and a leading zero put back where
 * the sheet dropped it ("30559" is 030559, fish). Null for anything that isn't 2–8 digits after that.
 */
export function directoryCode(raw: unknown): string | null {
  let code = String(raw ?? "").replace(/\D/g, "");
  if (code.length % 2 === 1) code = `0${code}`;
  return /^\d{2,8}$/.test(code) ? code : null;
}

/** A description as the portal writes it, tidied: "CHAPTER~heading" read as a dash, runs of space as one. */
export function directoryDescription(raw: unknown): string {
  return String(raw ?? "")
    .replace(/~/g, " — ")
    .replace(/\s+/g, " ")
    .trim();
}

/** One row the item form's search offers. */
export type HsnOption = { code: string; description: string; heading: string | null; kind: HsnKind };

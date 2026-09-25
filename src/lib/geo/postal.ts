import { z } from "zod";
import { isIndia } from "@/lib/geo/countries";
import { PIN_PATTERN } from "@/lib/geo/pincode";

/**
 * A postal code, judged by the country it belongs to.
 *
 * An Indian PIN is six digits and never starts with zero, and that is worth enforcing — it is what
 * the PIN directory is keyed on. Nowhere else follows that rule. "SW1A 1AA", "10001", "M5V 3L9" and
 * "2000" are all real, and a form that refused them made every export customer's address unsavable
 * the moment it had a postcode. So the Indian rule applies to Indian addresses, and everywhere else
 * gets the shape every postal system shares: letters, digits, spaces and hyphens, up to twelve.
 *
 * A blank country is India, as it is throughout `src/lib/geo/` — every address stored before the
 * country field existed is domestic.
 */

/** Letters, digits, spaces and hyphens, starting with a letter or digit — every postal system's shape. */
export const FOREIGN_POSTAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 -]{1,11}$/;

export function postalCodeIssue(country: string | null | undefined, code: string | null | undefined): string | null {
  const value = (code ?? "").trim();
  if (!value) return null;
  if (isIndia(country)) return PIN_PATTERN.test(value) ? null : "A PIN code is six digits.";
  return FOREIGN_POSTAL_PATTERN.test(value) ? null : "A postal code is letters, digits, spaces and hyphens — up to 12.";
}

/**
 * The field on its own: anything up to twelve characters.
 *
 * It cannot check more than that, because a field cannot see the country beside it. The real rule
 * is `refinePostalCode`, applied to the object that holds both.
 */
export const postalCodeField = z.string().trim().max(12, "Too long for a postal code.").optional().or(z.literal(""));

/**
 * The country-aware rule, for `.superRefine` on any schema with `country` and `pincode`.
 *
 * Applied to each *final* schema, not only to the shared one: spreading a zod object's `.shape`
 * into another copies the fields and leaves object-level rules behind. `check:address` asserts
 * every address schema carries it, because a missed one fails open — it accepts anything.
 */
export function refinePostalCode(value: { country?: string | null; pincode?: string | null }, ctx: z.RefinementCtx) {
  const issue = postalCodeIssue(value.country, value.pincode);
  if (issue) ctx.addIssue({ code: "custom", message: issue, path: ["pincode"] });
}

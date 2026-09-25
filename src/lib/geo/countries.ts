/**
 * The countries an address can be in.
 *
 * India first and by default — this is an Indian business, every GST rule in the app assumes it,
 * and better than nine in ten addresses will never be anything else. The rest are here because
 * exports exist: an invoice raised in USD to a customer in Dubai is a real document this app issues,
 * and a country field that only said "India" would be a field people worked around.
 *
 * ## Only India constrains its states
 *
 * `INDIAN_STATES` is authoritative because the GST state code is derived from it. No equivalent
 * exists for anywhere else, and inventing one would be worse than useless: an export invoice's place
 * of supply is the country, not the province, so a half-remembered list of Emirates or US states
 * would add typing without adding correctness. Outside India the state field stays free text and
 * says so.
 */

import { WORLD_COUNTRIES, type WorldCountry } from "@/lib/geo/world-countries";

export type Country = { code: string; name: string };

/**
 * Every country — India first, then alphabetical — from GeoNames (src/lib/geo/world-countries.ts).
 *
 * It used to be the 28 places this business trades with most. That kept the scroll short and left
 * every other customer abroad unsavable without somebody editing code, so the list is now complete
 * and the select is searchable by typing, like any long select. The 28 names are kept exactly as
 * they were stored.
 */
export const COUNTRIES: Country[] = WORLD_COUNTRIES.map(({ code, name }) => ({ code, name }));

/** A stored country name's entry, or null for one the list does not know (an old free-text value). */
export function countryByName(name: string | null | undefined): WorldCountry | null {
  const key = (name ?? "").trim().toLowerCase();
  if (!key) return WORLD_COUNTRIES[0];
  return WORLD_COUNTRIES.find((c) => c.name.toLowerCase() === key) ?? null;
}

export const DEFAULT_COUNTRY = "India";

/** Whether this address is one the GST state list applies to. */
export function isIndia(country: string | null | undefined): boolean {
  // An empty country means India: every address stored before this field existed is domestic, and
  // treating a blank as "somewhere else" would drop the state picker on most of the book.
  if (!country || !country.trim()) return true;
  return country.trim().toLowerCase() === "india";
}

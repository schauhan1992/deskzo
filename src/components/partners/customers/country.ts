import { WORLD_COUNTRIES } from "@/lib/geo/world-countries";

/**
 * Country names for the portal's pages, looked up on the server — the list is long, and a client
 * component is handed only the few names its rows need. A code the list does not know shows as
 * itself.
 */

const NAMES = new Map(WORLD_COUNTRIES.map((c) => [c.code.toUpperCase(), c.name]));

/** "IN" → "India"; an unknown code comes back as it was. */
export function countryName(code: string): string {
  return NAMES.get(String(code ?? "").trim().toUpperCase()) ?? code;
}

/** Names for a handful of codes, for a client component's props. */
export function countryNames(codes: readonly string[]): Record<string, string> {
  return Object.fromEntries([...new Set(codes)].map((code) => [code, countryName(code)]));
}

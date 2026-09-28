import { COUNTRIES } from "@/lib/geo/countries";

/**
 * Small pure helpers for the console's partner screens — /partners, a partner's page, the requests
 * queue and the workspace 360's Partner panel. Client-safe: nothing from src/lib/partners/** is
 * imported (the server pages hand the defaults and lists in as props), so dialogs can use these for
 * their live hints. The server checks every value again; these only decide what a form shows.
 */

export const PARTNERS_PATH = "/partners";
export const REQUESTS_PATH = "/partners/requests";

/** The partner 360's tab bar id prefix: its tabs are `pt-tab-<key>`, its panels `pt-panel-<key>`. */
export const PARTNER_TABS_ID = "pt";

export const partnerPath = (slug: string) => `${PARTNERS_PATH}/${encodeURIComponent(slug)}`;
export const workspacePath = (slug: string) => `/workspaces/${encodeURIComponent(slug)}`;

/** A partner's console address: 3–40 lower-case letters, digits and hyphens, no hyphen at either end. */
export const PARTNER_SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
/** Addresses the console uses itself under /partners. */
const RESERVED_SLUGS = new Set(["new", "requests"]);

/** The server's own email test (the partner and staff libraries use the same shape). */
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** What is wrong with a typed address, in words — null when it is fine. The live hint under the field. */
export function slugProblem(slug: string): string | null {
  const text = slug.trim();
  if (!text) return "3 to 40 lower-case letters, digits and hyphens.";
  if (text !== text.toLowerCase()) return "Lower-case letters only.";
  if (text.length < 3) return "At least 3 characters.";
  if (text.length > 40) return "At most 40 characters.";
  if (/[^a-z0-9-]/.test(text)) return "Only letters, digits and hyphens — no spaces or other signs.";
  if (text.startsWith("-") || text.endsWith("-")) return "It can't start or end with a hyphen.";
  if (RESERVED_SLUGS.has(text)) return "That address is reserved.";
  return PARTNER_SLUG.test(text) ? null : "3 to 40 lower-case letters, digits and hyphens.";
}

/** A console address suggested from a company's name ("Acme Channel Pvt Ltd" → "acme-channel-pvt-ltd"), or "" when none fits. */
export function suggestSlug(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return PARTNER_SLUG.test(base) && !RESERVED_SLUGS.has(base) ? base : "";
}

/** A read-only lookup table (never written after it is built). */
const COUNTRY_NAMES = new Map(COUNTRIES.map((c) => [c.code, c.name]));

/** "India", or the code itself for one the list does not know. */
export function countryName(code: string): string {
  return COUNTRY_NAMES.get(code) ?? code;
}

/** Every country as a select's options, India first (the list's own order). */
export const COUNTRY_OPTIONS: { value: string; label: string }[] = COUNTRIES.map((c) => ({ value: c.code, label: `${c.name} (${c.code})` }));

/** "IN, AE, SG +2" — the first few codes, then how many more. */
export function territoriesText(codes: readonly string[], max = 3): string {
  if (codes.length === 0) return "—";
  const shown = codes.slice(0, max).join(", ");
  return codes.length > max ? `${shown} +${codes.length - max}` : shown;
}

/** The codes of `codes` that are not in `within` — a reseller's territories outside its distributor's. */
export function outsideOf(codes: readonly string[], within: readonly string[]): string[] {
  const allowed = new Set(within);
  return codes.filter((c) => !allowed.has(c));
}

/** A whole number typed into a field, when it is one in the range; null otherwise. */
export function wholeIn(text: string, min: number, max: number): number | null {
  if (!/^\s*\d{1,4}\s*$/.test(text)) return null;
  const n = Number(text.trim());
  return n >= min && n <= max ? n : null;
}

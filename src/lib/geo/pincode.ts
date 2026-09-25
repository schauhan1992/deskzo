import { GST_STATE_CODES, stateCodeFromName } from "@/lib/gst-engine";
import { CITIES_BY_STATE } from "@/lib/geo/india";

/**
 * India Post's PIN directory, as rules — no database in this file.
 *
 * The directory itself lives in `post_offices`, loaded from the Department of Posts' own file (see
 * `prisma/reference/pincodes.ts`). Everything here is the part that can be wrong without a query
 * being involved: which rows are usable, which GST state a row belongs to, and what a person would
 * call the place a PIN is in. It is kept pure so `check:address` can exercise every rule directly.
 *
 * ## Why a PIN is worth looking up at all
 *
 * The state on an address decides CGST + SGST against IGST. A PIN pins that state down
 * independently — 122001 is in Haryana whatever anybody types beside it — so the directory turns
 * the PIN into a second opinion on the one field that moves tax. Typed first, it fills the state
 * and city in; typed last, it catches a state picked from the wrong line of the dropdown.
 */

/** The key the directory is recorded under in `reference_datasets`. */
export const PIN_DIRECTORY_KEY = "india-post-pincodes";

/**
 * A real Indian PIN: six digits, never starting with zero.
 *
 * The first digit is the postal zone, 1 to 9, and 9 is the Army Postal Service — so a leading zero is
 * not a PIN anywhere in the country. That is what lets the checks use `0xxxxx` for their fixture
 * rows with no chance of meeting a real one.
 */
export const PIN_PATTERN = /^[1-9]\d{5}$/;

export function isPincode(value: string | null | undefined): boolean {
  return PIN_PATTERN.test((value ?? "").trim());
}

/** Lowercase letters only — the key cities and districts are compared by. */
export function placeKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, "");
}

/** "GAUTAM BUDDHA NAGAR" → "Gautam Buddha Nagar". The directory is published in capitals. */
export function titleCase(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/(^|[\s(\-/.])([a-z])/g, (_, lead: string, letter: string) => lead + letter.toUpperCase());
}

/**
 * A post office's name without its office-type suffix.
 *
 * "Gurgaon H.O", "Sector 14 S.O", "Bangalore G.P.O." — the suffix says what kind of office it is,
 * which is a column of its own; the rest is the locality, which is what an address means.
 */
export function officeLocality(officeName: string): string {
  return officeName
    .replace(/\s+(g\.?\s?p\.?\s?o|h\.?\s?o|s\.?\s?o|b\.?\s?o|p\.?\s?o|n\.?\s?d\.?\s?o|e\.?\s?d\.?\s?o)\.?\s*$/i, "")
    .trim();
}

/**
 * Former names a city is still published under, mapped to the name this app offers.
 *
 * Only renamings and districts that *are* the city — never a district mapped to its headquarters.
 * Dakshina Kannada is not Mangaluru and Gautam Buddha Nagar is not Noida: both contain other towns,
 * and filling every PIN in them with the big city's name would be confidently wrong for the rest.
 * Those fall through to the district name, which is at least true.
 */
const CITY_ALIASES: Record<string, string> = {
  Bangalore: "Bengaluru",
  "Bengaluru Urban": "Bengaluru",
  "Bangalore Urban": "Bengaluru",
  Gurgaon: "Gurugram",
  Bombay: "Mumbai",
  "Mumbai Suburban": "Mumbai",
  Madras: "Chennai",
  Calcutta: "Kolkata",
  Mysore: "Mysuru",
  Mangalore: "Mangaluru",
  Hubli: "Hubballi",
  Belgaum: "Belagavi",
  Bellary: "Ballari",
  Tumkur: "Tumakuru",
  Trivandrum: "Thiruvananthapuram",
  Cochin: "Kochi",
  Calicut: "Kozhikode",
  Allahabad: "Prayagraj",
  Poona: "Pune",
  Baroda: "Vadodara",
  Panjim: "Panaji",
  Trichy: "Tiruchirappalli",
  Tiruchirapalli: "Tiruchirappalli",
  "Kanpur Nagar": "Kanpur",
};

const ALIAS_BY_KEY = new Map(Object.entries(CITY_ALIASES).map(([from, to]) => [placeKey(from), to]));

/** The curated cities for a GST state, keyed for matching — the names the picker already offers. */
function curatedFor(stateCode: string | null): Map<string, string> {
  const name = stateCode ? GST_STATE_CODES[stateCode] : undefined;
  const cities = (name && CITIES_BY_STATE[name]) || [];
  const byKey = new Map(cities.map((c) => [placeKey(c), c]));
  // An alias counts only where the city it points at is one this state actually lists — "Bombay"
  // means Mumbai in Maharashtra and nothing at all anywhere else.
  for (const [key, to] of ALIAS_BY_KEY) if (byKey.has(placeKey(to))) byKey.set(key, to);
  return byKey;
}

/** The name a district is offered under: its current city name where it has one, else itself. */
export function districtDisplay(district: string): string {
  const titled = titleCase(district);
  return ALIAS_BY_KEY.get(placeKey(titled)) ?? titled;
}

/**
 * What a person would write as the city for a PIN.
 *
 * The directory has no "city" column — it has a district and a list of post offices. A district is
 * often right (Gurugram) and sometimes only technically so (Gautam Buddha Nagar, for Noida). The
 * office names know better: "Noida Sector 19 S.O" and "Greater Noida S.O" say where they are.
 *
 * So the offices vote first, each matched against the cities the picker already offers for that
 * state — longest name first, so "Greater Noida" is not counted as "Noida". Then the district is
 * tried against the same list. Only then does the district stand on its own, title-cased: never a
 * guess, just the less familiar of two true answers.
 */
export function cityForPin(input: { district: string; offices: string[]; stateCode: string | null }): string {
  const curated = curatedFor(input.stateCode);
  const votes = new Map<string, number>();

  for (const office of input.offices) {
    const words = officeLocality(office).split(/\s+/).filter(Boolean);
    for (let n = Math.min(words.length, 3); n >= 1; n -= 1) {
      const hit = curated.get(placeKey(words.slice(0, n).join(" ")));
      if (hit) {
        votes.set(hit, (votes.get(hit) ?? 0) + 1);
        break;
      }
    }
  }
  if (votes.size > 0) return [...votes.entries()].sort((a, b) => b[1] - a[1])[0]![0];

  const fromDistrict = curated.get(placeKey(input.district));
  if (fromDistrict) return fromDistrict;
  return districtDisplay(input.district);
}

/**
 * Where to look for a city's PINs — the reverse of `cityForPin`.
 *
 * Bengaluru's post offices are published under "Bengaluru Urban" and named "Bangalore …", so a
 * search for the name on screen alone finds almost none of them. Every name the city is known by
 * becomes both a district key and an office-name prefix.
 */
export function pinSearchFor(city: string): { districtKeys: string[]; officePrefixes: string[] } {
  const target = ALIAS_BY_KEY.get(placeKey(city)) ?? city.trim();
  const names = [target, ...Object.entries(CITY_ALIASES).filter(([, to]) => to === target).map(([from]) => from)];
  return {
    districtKeys: [...new Set(names.map(placeKey))].filter(Boolean),
    officePrefixes: [...new Set(names)].filter((n) => n.length >= 3),
  };
}

/**
 * City suggestions for a state: the curated list first, then every district the directory knows.
 *
 * The curated names come first because they are the places this business actually quotes into.
 * The districts make the list complete — Hosur and Bhiwadi stop needing to be typed — and are
 * deduplicated against the curated names, aliases included, so Bengaluru is not offered twice.
 */
export function mergeCitySuggestions(curated: string[], districts: string[]): string[] {
  const seen = new Set(curated.map(placeKey));
  const extra: string[] = [];
  for (const district of districts) {
    const display = districtDisplay(district);
    const key = placeKey(display);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    extra.push(display);
  }
  extra.sort((a, b) => a.localeCompare(b));
  return [...curated, ...extra];
}

// ── Reading the Department of Posts' file ───────────────────────────────────────────────────────

export type PostOfficeRow = {
  pincode: string;
  officeName: string;
  officeType: string | null;
  delivery: boolean;
  district: string;
  districtKey: string;
  stateName: string;
  stateCode: string | null;
  latitude: number | null;
  longitude: number | null;
};

/**
 * The column names the file has used, per field.
 *
 * The directory has been republished with different headings over the years — `District` and
 * `Districtname`, `Deliverystatus` and `Delivery` — and matching them case-insensitively by any of
 * their known names means next month's file loads without a code change.
 */
const COLUMNS = {
  pincode: ["pincode", "pin", "pin code"],
  officeName: ["officename", "office name", "office_name", "postoffice"],
  officeType: ["officetype", "office type", "office_type"],
  delivery: ["delivery", "deliverystatus", "delivery status"],
  district: ["district", "districtname", "district name", "district_name"],
  stateName: ["statename", "state name", "state_name", "state"],
  latitude: ["latitude", "lat"],
  longitude: ["longitude", "long", "lng", "lon"],
} as const;

export type ColumnMap = { [K in keyof typeof COLUMNS]: string | null };

/** Which heading in this file holds each field — or which required ones it is missing. */
export function mapColumns(headers: string[]): { ok: true; map: ColumnMap } | { ok: false; missing: string[] } {
  const normal = new Map(headers.map((h) => [h.trim().toLowerCase(), h]));
  const map = Object.fromEntries(
    Object.entries(COLUMNS).map(([field, names]) => [field, names.map((n) => normal.get(n)).find(Boolean) ?? null]),
  ) as ColumnMap;
  const missing = (["pincode", "officeName", "district", "stateName"] as const).filter((f) => !map[f]);
  return missing.length ? { ok: false, missing } : { ok: true, map };
}

/** A coordinate, or null for the "NA", blank and out-of-country values the file carries. */
function coordinate(raw: string | undefined, min: number, max: number): number | null {
  const n = Number((raw ?? "").trim());
  if (!raw || !raw.trim() || !Number.isFinite(n) || n < min || n > max) return null;
  return Math.round(n * 1e6) / 1e6;
}

export type SkipReason = "bad-pincode" | "no-office" | "no-district";

/**
 * One line of the file, or why it cannot be used.
 *
 * A row whose state does not resolve is *kept*, with a null state code: the PIN is still real and
 * still worth finding. The loader reports those names by count so a new spelling gets noticed and
 * added to the engine's aliases, instead of a whole state silently going missing from lookups.
 */
export function parseRow(record: Record<string, string>, map: ColumnMap): PostOfficeRow | { skip: SkipReason } {
  const get = (field: keyof ColumnMap) => (map[field] ? (record[map[field]!] ?? "").trim() : "");

  const pincode = get("pincode").replace(/\s+/g, "");
  if (!isPincode(pincode)) return { skip: "bad-pincode" };
  const officeName = get("officeName");
  if (!officeName) return { skip: "no-office" };
  const district = get("district");
  if (!district) return { skip: "no-district" };

  const stateName = get("stateName");
  const delivery = get("delivery").toLowerCase().replace(/[^a-z]/g, "");

  return {
    pincode,
    // Title-casing capitalises after a full stop too, so "GURGAON H.O" comes out "Gurgaon H.O".
    officeName: titleCase(officeName),
    officeType: get("officeType") || null,
    // "Non Delivery", "Non-Delivery", "NonDelivery" — anything else, including a blank, delivers.
    delivery: !delivery.startsWith("non"),
    district: titleCase(district),
    districtKey: placeKey(district),
    stateName: titleCase(stateName),
    stateCode: stateCodeFromName(stateName),
    latitude: coordinate(get("latitude"), 6, 38),
    longitude: coordinate(get("longitude"), 68, 98),
  };
}

/**
 * GeoNames' published files, as rows — no database and no network in this file.
 *
 * GeoNames (geonames.org, CC BY 4.0) is where addresses outside India get their countries, states,
 * cities and postal codes. India keeps India Post's own PIN directory (src/lib/geo/pincode.ts): that
 * is the authoritative source, and the state on an Indian address moves GST, so it stays tied to the
 * GST state list rather than to anybody's copy of it.
 *
 * The formats are GeoNames' own, documented at download.geonames.org/export/dump/readme.txt and
 * /export/zip/readme.txt: tab-separated UTF-8, one record per line, `#` for comments.
 *
 * Kept pure so check:geonames can run every parser against sample lines.
 */

/** The credit the licence asks for, shown wherever the data is offered. */
export const GEONAMES_CREDIT = "Place names and postal codes outside India from GeoNames (geonames.org), CC BY 4.0.";

export type GeoCountry = {
  code: string;
  iso3: string;
  name: string;
  capital: string | null;
  continent: string;
  currency: string | null;
  phone: string | null;
  /** GeoNames' description of the shape, `#` a digit and `@` a letter: "@# #@@|@## #@@". */
  postalFormat: string | null;
  postalRegex: string | null;
  geonameId: number | null;
};

export type GeoAdmin1 = { countryCode: string; code: string; name: string; asciiName: string; geonameId: number | null };

export type GeoCity = {
  id: number;
  name: string;
  asciiName: string;
  countryCode: string;
  admin1Code: string | null;
  population: number;
  latitude: number;
  longitude: number;
};

export type GeoPostal = {
  countryCode: string;
  postalCode: string;
  placeName: string;
  admin1Name: string | null;
  admin1Code: string | null;
  admin2Name: string | null;
  latitude: number | null;
  longitude: number | null;
};

const cell = (v: string | undefined) => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};
const int = (v: string | undefined) => {
  const n = Number.parseInt((v ?? "").trim(), 10);
  return Number.isFinite(n) ? n : null;
};
const num = (v: string | undefined) => {
  const n = Number.parseFloat((v ?? "").trim());
  return Number.isFinite(n) ? n : null;
};
const COUNTRY = /^[A-Z]{2}$/;

/** countryInfo.txt: ISO, ISO3, ISO-Numeric, fips, Country, Capital, Area, Population, Continent, tld, CurrencyCode, CurrencyName, Phone, Postal Code Format, Postal Code Regex, Languages, geonameid, neighbours, EquivalentFipsCode. */
export function parseCountryLine(line: string): GeoCountry | null {
  if (!line || line.startsWith("#")) return null;
  const f = line.split("\t");
  const code = cell(f[0]);
  const name = cell(f[4]);
  if (!code || !COUNTRY.test(code) || !name) return null;
  return {
    code,
    iso3: cell(f[1]) ?? "",
    name,
    capital: cell(f[5]),
    continent: cell(f[8]) ?? "",
    currency: cell(f[10]),
    phone: cell(f[12]),
    postalFormat: cell(f[13]),
    postalRegex: cell(f[14]),
    geonameId: int(f[16]),
  };
}

/** admin1CodesASCII.txt: "IN.10", name, ascii name, geonameid. */
export function parseAdmin1Line(line: string): GeoAdmin1 | null {
  if (!line || line.startsWith("#")) return null;
  const f = line.split("\t");
  const key = cell(f[0]);
  const name = cell(f[1]);
  if (!key || !name) return null;
  const dot = key.indexOf(".");
  if (dot !== 2 || !COUNTRY.test(key.slice(0, 2))) return null;
  return { countryCode: key.slice(0, 2), code: key.slice(3), name, asciiName: cell(f[2]) ?? name, geonameId: int(f[3]) };
}

/**
 * The main gazetteer format (cities1000.txt): geonameid, name, asciiname, alternatenames, latitude,
 * longitude, feature class, feature code, country code, cc2, admin1..4, population, elevation, dem,
 * timezone, modification date. Only populated places (class P) are cities.
 */
export function parseCityLine(line: string): GeoCity | null {
  if (!line || line.startsWith("#")) return null;
  const f = line.split("\t");
  if (f[6] !== "P") return null;
  const id = int(f[0]);
  const name = cell(f[1]);
  const countryCode = cell(f[8]);
  const latitude = num(f[4]);
  const longitude = num(f[5]);
  if (id === null || !name || !countryCode || !COUNTRY.test(countryCode) || latitude === null || longitude === null) return null;
  return {
    id,
    name,
    asciiName: cell(f[2]) ?? name,
    countryCode,
    admin1Code: cell(f[10]),
    population: int(f[14]) ?? 0,
    latitude,
    longitude,
  };
}

/** The postal code files: country code, postal code, place name, admin name1, admin code1, admin name2, admin code2, admin name3, admin code3, latitude, longitude, accuracy. */
export function parsePostalLine(line: string): GeoPostal | null {
  if (!line || line.startsWith("#")) return null;
  const f = line.split("\t");
  const countryCode = cell(f[0]);
  const postalCode = cell(f[1]);
  const placeName = cell(f[2]);
  if (!countryCode || !COUNTRY.test(countryCode) || !postalCode || !placeName || postalCode.length > 20) return null;
  return {
    countryCode,
    postalCode,
    placeName,
    admin1Name: cell(f[3]),
    admin1Code: cell(f[4]),
    admin2Name: cell(f[5]),
    latitude: num(f[9]),
    longitude: num(f[10]),
  };
}

/** Accents off, so "Zürich" is found by "Zurich" and "São Paulo" by "Sao Paulo". */
export function plainText(s: string): string {
  return s.normalize("NFD").replace(/\p{M}+/gu, "");
}

/**
 * The key a postal code is looked up by: upper case, no spaces or hyphens. "sw1a 1aa", "SW1A1AA"
 * and "SW1A 1AA" are one postcode; so are "10001" and "10001-".
 */
export function postalKey(code: string): string {
  return code.toUpperCase().replace(/[\s-]+/g, "");
}

/**
 * The outward part a short-form file holds — "SW1A" for "SW1A 1AA", "M5V" for "M5V 3L9", "1012" for
 * "1012 AB" — so a full code still finds its area when only the first part was published.
 */
export function outwardKey(countryCode: string, code: string): string | null {
  const key = postalKey(code);
  if (countryCode === "GB" && key.length >= 5) return key.slice(0, -3);
  if (countryCode === "CA" && key.length === 6) return key.slice(0, 3);
  if (countryCode === "NL" && key.length === 6) return key.slice(0, 4);
  return null;
}

/**
 * Whether a postal code looks right for its country — a hint, never a refusal. GeoNames' patterns are
 * a good guide and not gospel (it has the UAE, which barely uses postcodes, as "#####-#####"), so a
 * code that fails is flagged for a second look and still saved.
 */
export function postalLooksWrong(country: { name: string; postalRegex?: string | null } | null, code: string): string | null {
  if (!country?.postalRegex || !code.trim()) return null;
  let re: RegExp;
  try {
    re = new RegExp(country.postalRegex.trim(), "i");
  } catch {
    return null;
  }
  return re.test(code.trim()) ? null : `That doesn't look like a postal code in ${country.name} — worth a second look.`;
}

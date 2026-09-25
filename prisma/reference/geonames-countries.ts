/**
 * Writes src/lib/geo/world-countries.ts from GeoNames' countryInfo.txt.
 *
 *   npx tsx prisma/reference/geonames-countries.ts [path/to/countryInfo.txt]
 *
 * The country list lives in code rather than in a table, like the rest of src/lib/geo/: the address
 * forms render it in the browser, a country list changes once in a few years, and a list in code is
 * one no data operation can empty. This regenerates that file; review the diff and commit it.
 *
 * ## Names that are already stored stay exactly as they are
 *
 * Addresses store the country's *name* ("Netherlands"), and `isIndia`, the printed address and the
 * GST export rules all read it. So every name the app already offered keeps its spelling here, even
 * where GeoNames writes it differently ("The Netherlands") — otherwise opening an old address would
 * show a country that is not in the list, and saving it would quietly change it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseCountryLine, type GeoCountry } from "../../src/lib/geo/geonames";

/** The names the app used before the full list, by ISO code — kept verbatim. */
const KEEP: Record<string, string> = {
  IN: "India", AE: "United Arab Emirates", AU: "Australia", BD: "Bangladesh", BH: "Bahrain", CA: "Canada",
  CH: "Switzerland", DE: "Germany", FR: "France", GB: "United Kingdom", HK: "Hong Kong", ID: "Indonesia",
  JP: "Japan", KE: "Kenya", LK: "Sri Lanka", MY: "Malaysia", NL: "Netherlands", NP: "Nepal", NZ: "New Zealand",
  OM: "Oman", PH: "Philippines", QA: "Qatar", SA: "Saudi Arabia", SG: "Singapore", TH: "Thailand",
  US: "United States", VN: "Vietnam", ZA: "South Africa",
};

/** Codes GeoNames lists that are not places anybody has an address in. */
const SKIP = new Set(["AN", "CS", "XK"]);

const source = process.argv[2] ?? path.join(__dirname, "geonames", "countryInfo.txt");
const countries = readFileSync(source, "utf8")
  .split(/\r?\n/)
  .map(parseCountryLine)
  .filter((c): c is GeoCountry => c !== null && !SKIP.has(c.code))
  .map((c) => ({ ...c, name: KEEP[c.code] ?? c.name.replace(/^The /, "") }));

const missing = Object.keys(KEEP).filter((code) => !countries.some((c) => c.code === code));
if (missing.length) throw new Error(`countryInfo.txt is missing countries the app already uses: ${missing.join(", ")}`);

// India first — the default, and nine addresses in ten — then alphabetical.
countries.sort((a, b) => (a.code === "IN" ? -1 : b.code === "IN" ? 1 : a.name.localeCompare(b.name, "en")));

const rows = countries
  .map((c) => {
    const fields = [
      `code: ${JSON.stringify(c.code)}`,
      `name: ${JSON.stringify(c.name)}`,
      c.postalRegex ? `postalRegex: ${JSON.stringify(c.postalRegex.trim())}` : null,
      c.postalFormat ? `postalFormat: ${JSON.stringify(c.postalFormat)}` : null,
      c.phone ? `phone: ${JSON.stringify(c.phone)}` : null,
      c.currency ? `currency: ${JSON.stringify(c.currency)}` : null,
    ].filter(Boolean);
    return `  { ${fields.join(", ")} },`;
  })
  .join("\n");

const out = path.join(__dirname, "..", "..", "src", "lib", "geo", "world-countries.ts");
writeFileSync(
  out,
  `/**
 * Every country, generated from GeoNames' countryInfo.txt by prisma/reference/geonames-countries.ts
 * — do not edit by hand; regenerate, review the diff, and commit.
 *
 * Country data from GeoNames (geonames.org), CC BY 4.0. Names the app already stored are kept as
 * they were; see the generator for why.
 */
export type WorldCountry = {
  code: string;
  name: string;
  /** GeoNames' pattern for the country's postal codes — a hint for the form, never a refusal. */
  postalRegex?: string;
  /** "#" a digit, "@" a letter: "@# #@@|@## #@@". */
  postalFormat?: string;
  phone?: string;
  currency?: string;
};

export const WORLD_COUNTRIES: WorldCountry[] = [
${rows}
];
`,
);
console.log(`Wrote ${countries.length} countries to ${path.relative(process.cwd(), out)}`);

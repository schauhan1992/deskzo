/**
 * World places — GeoNames' countries, states, cities and postal codes outside India.
 * src/lib/geo/{geonames,world-countries,world-lookup,zip-lines}.ts, prisma/reference/geonames.ts,
 * src/components/ui/foreign-address-fields.tsx.
 *
 *   · Without a database: every GeoNames line format, postal keys and short-form areas, accents,
 *     the per-country postal hint (a hint, never a refusal), the zip reader on zips it builds itself,
 *     the country list (every name the app already stored kept exactly), and the loader's refusal to
 *     shrink a table to less than half.
 *   · The tax safety: a foreign address is "Other Country" (96) and its state is never matched to an
 *     Indian GST state — Pakistan's Punjab is not India's 03 — and keeps its own country.
 *   · Lookups against fixture rows inside a transaction that is always rolled back, so the reference
 *     tables are never written to: states, towns by prefix and without accents, a postal code, a full
 *     code finding its published area, and India refused (its data is India Post's).
 *   · What the address form renders abroad and at home.
 *
 *   npm run check:geonames
 */
import "dotenv/config";
import Module from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import type { ReactElement } from "react";
import { PrismaClient } from "@prisma/client";
import {
  outwardKey,
  parseAdmin1Line,
  parseCityLine,
  parseCountryLine,
  parsePostalLine,
  plainText,
  postalKey,
  postalLooksWrong,
} from "../src/lib/geo/geonames";
import { WORLD_COUNTRIES } from "../src/lib/geo/world-countries";
import { COUNTRIES, countryByName, isIndia } from "../src/lib/geo/countries";
import { ZipError, zipLines } from "../src/lib/geo/zip-lines";
import { REFERENCE_TABLES } from "../src/lib/reference-data";

const load = Module.createRequire(__filename);
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/navigation") return { useRouter: () => ({ push() {}, refresh() {} }), usePathname: () => "/", useSearchParams: () => new URLSearchParams() };
  if (request === "next/cache") return { revalidatePath() {}, unstable_cache: (f: unknown) => f };
  return realLoad.call(this, request, parent, isMain);
} as typeof realLoad;

const db = new PrismaClient();
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

/** A zip with the given entries — deflated, or stored when `stored` — built by hand, as GeoNames' are. */
function makeZip(entries: { name: string; text: string; stored?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.text, "utf8");
    const data = e.stored ? raw : deflateRawSync(raw);
    const name = Buffer.from(e.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.stored ? 0 : 8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(e.stored ? 0 : 8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const l of gen) out.push(l);
  return out;
}

async function main() {
  // ─────────────────────────────────────────────────────────────────────────────
  section("Reading GeoNames' formats");

  const country = parseCountryLine("GB\tGBR\t826\tUK\tUnited Kingdom\tLondon\t244820\t66488991\tEU\t.uk\tGBP\tPound\t44\t@# #@@|@## #@@\t^([A-Z]{1,2}\\d[A-Z\\d]? ?\\d[A-Z]{2})$\ten-GB\t2635167\tIE\t");
  ok("a country line", country?.code === "GB" && country.name === "United Kingdom" && country.currency === "GBP" && country.postalFormat === "@# #@@|@## #@@" && country.geonameId === 2635167);
  ok("a comment is not a country", parseCountryLine("#ISO\tISO3") === null);
  const admin = parseAdmin1Line("AE.03\tDubai\tDubai\t292224");
  ok("a state line", admin?.countryCode === "AE" && admin.code === "03" && admin.name === "Dubai");
  ok("a malformed state key is skipped", parseAdmin1Line("AE03\tDubai\tDubai\t1") === null);
  const cityLine = ["2657896", "Zürich", "Zuerich", "Zurich,Zurigo", "47.36667", "8.55", "P", "PPLA", "CH", "", "ZH", "112", "261", "", "415367", "", "408", "Europe/Zurich", "2024-01-01"].join("\t");
  const c = parseCityLine(cityLine);
  ok("a city line", c?.id === 2657896 && c.name === "Zürich" && c.countryCode === "CH" && c.admin1Code === "ZH" && c.population === 415367);
  ok("only populated places are cities", parseCityLine(cityLine.replace("\tP\tPPLA\t", "\tH\tLK\t")) === null);
  const postal = parsePostalLine("GB\tSW1A 1AA\tLondon\tEngland\tENG\tGreater London\t11\t\t\t51.501\t-0.1416\t6");
  ok("a postal line", postal?.postalCode === "SW1A 1AA" && postal.placeName === "London" && postal.admin1Code === "ENG" && postal.latitude === 51.501);
  ok("a postal line with no code is skipped", parsePostalLine("GB\t\tLondon") === null);

  ok("postal keys ignore case, spaces and hyphens", postalKey("sw1a 1aa") === "SW1A1AA" && postalKey("10001-") === "10001" && postalKey("1012 ab") === "1012AB");
  ok("a full UK code's area", outwardKey("GB", "SW1A 1AA") === "SW1A" && outwardKey("GB", "M1 1AE") === "M1");
  ok("a full Canadian and Dutch code's area", outwardKey("CA", "M5V 3L9") === "M5V" && outwardKey("NL", "1012 AB") === "1012");
  ok("no area elsewhere", outwardKey("US", "10001") === null && outwardKey("GB", "SW1") === null);
  ok("accents come off", plainText("Zürich") === "Zurich" && plainText("São Paulo") === "Sao Paulo" && plainText("Kraków") === "Krakow");

  const us = WORLD_COUNTRIES.find((x) => x.code === "US")!;
  ok("a US ZIP looks right", postalLooksWrong(us, "10001") === null && postalLooksWrong(us, "10001-1234") === null);
  ok("a UK postcode in the US is flagged", postalLooksWrong(us, "SW1A 1AA")?.includes("United States") === true);
  ok("no pattern means no hint", postalLooksWrong({ name: "Hong Kong" }, "anything") === null);
  ok("a broken pattern means no hint, not a crash", postalLooksWrong({ name: "X", postalRegex: "^([" }, "123") === null);
  ok("an empty code gets no hint", postalLooksWrong(us, "  ") === null);

  // ─────────────────────────────────────────────────────────────────────────────
  section("The zip reader");

  const work = mkdtempSync(path.join(tmpdir(), "zzgeo-"));
  try {
    const zip = path.join(work, "t.zip");
    writeFileSync(zip, makeZip([
      { name: "readme.txt", text: "not this one\n" },
      { name: "cities.txt", text: "line one\r\nline two ü\nline three" },
      { name: "plain.txt", text: "stored\nlines\n", stored: true },
    ]));
    ok("a deflated entry reads line by line, CRLF and all", JSON.stringify(await collect(zipLines(zip, "cities.txt"))) === JSON.stringify(["line one", "line two ü", "line three"]));
    ok("a stored entry reads too", JSON.stringify(await collect(zipLines(zip, "plain.txt"))) === JSON.stringify(["stored", "lines"]));
    let missing = "";
    try {
      await collect(zipLines(zip, "nope.txt"));
    } catch (e) {
      missing = e instanceof ZipError ? e.message : "wrong error";
    }
    ok("a missing entry says so", missing.includes("nope.txt"), missing);
    const junk = path.join(work, "junk.zip");
    writeFileSync(junk, "this is not a zip at all");
    let notZip = "";
    try {
      await collect(zipLines(junk, "x"));
    } catch (e) {
      notZip = e instanceof ZipError ? e.message : "wrong error";
    }
    ok("a file that isn't a zip says so", notZip === "That isn't a zip file.", notZip);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  section("The country list");

  const LEGACY: Record<string, string> = {
    IN: "India", AE: "United Arab Emirates", AU: "Australia", BD: "Bangladesh", BH: "Bahrain", CA: "Canada", CH: "Switzerland", DE: "Germany",
    FR: "France", GB: "United Kingdom", HK: "Hong Kong", ID: "Indonesia", JP: "Japan", KE: "Kenya", LK: "Sri Lanka", MY: "Malaysia",
    NL: "Netherlands", NP: "Nepal", NZ: "New Zealand", OM: "Oman", PH: "Philippines", QA: "Qatar", SA: "Saudi Arabia", SG: "Singapore",
    TH: "Thailand", US: "United States", VN: "Vietnam", ZA: "South Africa",
  };
  const renamed = Object.entries(LEGACY).filter(([code, name]) => COUNTRIES.find((x) => x.code === code)?.name !== name).map(([code]) => code);
  ok("every name the app already stored is kept exactly", renamed.length === 0, renamed.join(", "));
  ok("it is the whole world", COUNTRIES.length > 240, COUNTRIES.length);
  ok("India comes first", COUNTRIES[0]?.code === "IN");
  ok("codes and names are unique", new Set(COUNTRIES.map((x) => x.code)).size === COUNTRIES.length && new Set(COUNTRIES.map((x) => x.name.toLowerCase())).size === COUNTRIES.length);
  ok("a blank country is India", countryByName("")?.code === "IN" && isIndia(""));
  ok("a stored name is found whatever its case", countryByName("  united KINGDOM ")?.code === "GB");
  ok("a name nobody lists is not guessed at", countryByName("Narnia") === null);

  const { shrinks } = load("../prisma/reference/geonames") as typeof import("../prisma/reference/geonames");
  ok("a file half the size of what is loaded is refused", shrinks(4_000_000, 1_500_000));
  ok("…a normal update is not", !shrinks(4_000_000, 3_900_000) && !shrinks(0, 10));

  // ─────────────────────────────────────────────────────────────────────────────
  section("Tax: a foreign state is never an Indian one");

  const { partyDetails } = load("../src/lib/proposals/party") as typeof import("../src/lib/proposals/party");
  const site = (over: Record<string, unknown>) => ({ id: "s", address: "1 Road", city: "Lahore", state: "Punjab", pincode: "54000", country: "Pakistan", gstNumber: null, gstTreatment: "OVERSEAS", ...over });
  const pk = partyDetails(site({}), "Zz Lahore Traders");
  ok("Pakistan's Punjab is Other Country (96), not India's 03", pk.ok && pk.data.placeOfSupplyCode === "96", pk.ok ? pk.data.placeOfSupplyCode : pk.error);
  ok("…and the address keeps its own country and postal code", pk.ok && pk.data.address.country === "Pakistan" && pk.data.address.pincode === "54000");
  const inPunjab = partyDetails(site({ city: "Ludhiana", pincode: "141001", country: "India", gstTreatment: "UNREGISTERED" }), "Zz Ludhiana Traders");
  ok("India's Punjab is still 03", inPunjab.ok && inPunjab.data.placeOfSupplyCode === "03" && inPunjab.data.address.country === "India");
  const blank = partyDetails(site({ state: "Haryana", country: null, gstTreatment: "UNREGISTERED", pincode: "122001" }), "Zz Gurugram");
  ok("a blank country is India, as before", blank.ok && blank.data.placeOfSupplyCode === "06");

  // ─────────────────────────────────────────────────────────────────────────────
  section("Lookups, against fixture rows that are always rolled back");

  const lookup = load("../src/lib/geo/world-lookup") as typeof import("../src/lib/geo/world-lookup");
  ok("the world tables are reference data", ["geo_states", "geo_cities", "geo_postal_codes"].every((t) => REFERENCE_TABLES.some((r) => r.table === t)));
  const { readFileSync } = load("node:fs") as typeof import("node:fs");
  const root = path.join(__dirname, "..");
  ok("the seed reloads world places", /await ensureGeonames\(/.test(readFileSync(path.join(root, "prisma", "seed.ts"), "utf8")));
  ok("so does a restore", /await ensureGeonames\(/.test(readFileSync(path.join(root, "scripts", "restore-worker.ts"), "utf8")));
  class Rollback extends Error {}
  try {
    await db.$transaction(async (tx) => {
      await tx.geoState.createMany({ data: [
        { countryCode: "ZZ", code: "01", name: "Zzland North", asciiName: "Zzland North" },
        { countryCode: "ZZ", code: "02", name: "Zzland South", asciiName: "Zzland South" },
      ] });
      await tx.geoCity.createMany({ data: [
        { id: 990000001, name: "Zürichzz", asciiName: "Zuerichzz", plainName: "Zurichzz", countryCode: "ZZ", stateCode: "01", population: 400000 },
        { id: 990000002, name: "Zürichzz-Nord", asciiName: "Zuerichzz-Nord", plainName: "Zurichzz-Nord", countryCode: "ZZ", stateCode: "01", population: 9000 },
        { id: 990000003, name: "Southzz", asciiName: "Southzz", plainName: "Southzz", countryCode: "ZZ", stateCode: "02", population: 5000 },
      ] });
      await tx.geoPostalCode.createMany({ data: [
        { countryCode: "ZZ", postalCode: "ZZ1 2AB", postalKey: "ZZ12AB", placeName: "Zürichzz", stateName: "Zzland North", stateCode: "01" },
        { countryCode: "ZZ", postalCode: "ZZ1 2AB", postalKey: "ZZ12AB", placeName: "Zürichzz-Nord", stateName: "Zzland North", stateCode: "01" },
        { countryCode: "ZZ", postalCode: "ZZ1 2AB", postalKey: "ZZ12AB", placeName: "Zürichzz", stateName: "Zzland North", stateCode: "01" },
        // A short-form area, as GeoNames publishes for the UK without the full file.
        { countryCode: "GB", postalCode: "ZZ9", postalKey: "ZZ9", placeName: "Zzhampton", stateName: "England", stateCode: "ENG" },
      ] });

      const states = await lookup.statesOf(tx, "ZZ");
      ok("a country's states, in order", states.map((s) => s.name).join() === "Zzland North,Zzland South");
      ok("India's states are not asked of GeoNames", (await lookup.statesOf(tx, "IN")).length === 0);
      ok("a state's towns, biggest first", (await lookup.citiesIn(tx, "ZZ", "01", "")).join() === "Zürichzz,Zürichzz-Nord");
      ok("towns by what is typed", (await lookup.citiesIn(tx, "ZZ", null, "sou")).join() === "Southzz");
      ok("…without the accent", (await lookup.citiesIn(tx, "ZZ", null, "Zurichzz"))[0] === "Zürichzz");
      ok("…or with it", (await lookup.citiesIn(tx, "ZZ", null, "Zürichzz"))[0] === "Zürichzz");

      const found = await lookup.findPostal(tx, "ZZ", "zz1-2ab");
      ok("a postal code fills in the state and the likeliest town", found.ok && found.city === "Zürichzz" && found.stateName === "Zzland North" && !found.partial, JSON.stringify(found));
      ok("…and lists the other places it covers", found.ok && found.places.join() === "Zürichzz,Zürichzz-Nord");
      const area = await lookup.findPostal(tx, "GB", "ZZ9 9ZZ");
      ok("a full UK code finds its published area", area.ok && area.partial && area.city === "Zzhampton" && area.stateName === "England", JSON.stringify(area));
      ok("an unknown code in a known country is 'not found'", !(await lookup.findPostal(tx, "ZZ", "QQ99")).ok);
      const noData = await lookup.findPostal(tx, "QZ", "12345");
      ok("a country with no codes loaded says so, not 'wrong'", !noData.ok && noData.reason === "no-data");
      const india = await lookup.findPostal(tx, "IN", "110001");
      ok("an Indian PIN is left to India Post", !india.ok && india.reason === "invalid");
      ok("junk is refused before any query", !(await lookup.findPostal(tx, "ZZ", "'; drop table")).ok);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  ok("nothing was left behind", (await db.geoState.count({ where: { countryCode: "ZZ" } })) === 0 && (await db.geoPostalCode.count({ where: { postalKey: "ZZ9" } })) === 0);

  // ─────────────────────────────────────────────────────────────────────────────
  section("What the address form shows");

  const React = load("react") as typeof import("react");
  const { renderToStaticMarkup } = load("react-dom/server") as typeof import("react-dom/server");
  const { AddressFields } = load("../src/components/ui/address-fields") as typeof import("../src/components/ui/address-fields");
  const render = (props: Record<string, unknown>) =>
    renderToStaticMarkup(React.createElement(AddressFields, { country: "India", state: "", city: "", pincode: "", onChange: () => {}, ...props }) as ReactElement);
  const home = render({});
  ok("at home: the GST state list and the PIN field", home.includes("Choose a state…") && home.includes("PIN") && !home.includes("GeoNames"));
  const abroad = render({ country: "Germany", state: "Bavaria", city: "Munich", pincode: "80331" });
  ok("abroad: state or province, and the GeoNames credit", abroad.includes("State / province") && abroad.includes("GeoNames") && abroad.includes("Postal code"));
  ok("abroad: no Indian state list", !abroad.includes("Choose a state…"));
  ok("a country from before the full list is kept, not replaced", render({ country: "Narnia" }).includes('value="Narnia"'));
  ok("every country is offered", (home.match(/<option value="[^"]*">/g) ?? []).length > 240);

  console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll world places checks passed.");
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await db.$disconnect();
  process.exit(1);
});

/**
 * That a chosen address resolves to the right tax.
 *
 * The state on an address is not a label. `stateCodeFromName` turns it into a GST state code, and
 * that code decides CGST + SGST against IGST — so a spelling the lookup cannot match yields no code
 * and the supply is treated as inter-state. On an employee's address the same field sets the
 * professional-tax slab on their payslip.
 *
 * That is the whole reason these became pickers, and it is the one property worth asserting: every
 * option the picker offers must come back out of the tax engine as a real code. A list that drifted
 * from `GST_STATE_CODES` by one spelling would look completely fine and quietly mis-tax one state.
 *
 *   npm run check:address
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import Module from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PrismaClient } from "@prisma/client";
import { PrismaClient as ReferenceClient } from "@wroffy/reference-client";
import { readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { GST_STATE_CODES, stateCodeFromName } from "../src/lib/gst-engine";
import { INDIAN_STATES, CITIES_BY_STATE, citiesIn } from "../src/lib/geo/india";
import { COUNTRIES, isIndia } from "../src/lib/geo/countries";
import {
  PIN_DIRECTORY_KEY,
  cityForPin,
  isPincode,
  mapColumns,
  mergeCitySuggestions,
  officeLocality,
  parseRow,
  pinSearchFor,
  placeKey,
  titleCase,
} from "../src/lib/geo/pincode";
import { REFERENCE_TABLES } from "../src/lib/reference-data";
import { postalCodeIssue } from "../src/lib/geo/postal";
import { offersCreate } from "../src/lib/company-name";
import { EMPLOYEE_BANDS, bandForCount, countForBand } from "../src/lib/company-size";
import { treatmentForCountryChange } from "../src/lib/gst";
import { openForPlatform } from "../src/lib/platform/kek";
import { addCompanyLocationSchema, companyLocationFieldsSchema, updateCompanyLocationSchema } from "../src/lib/validation/company-location";
import { createCompanySchema } from "../src/lib/validation/company";
import { documentAddressSchema, organisationSettingsSchema } from "../src/lib/validation/trade-document";
import { parseDirectory, readDirectoryFile, refusalFor } from "../prisma/reference/pincodes";
import { citySuggestions, lookupPincode, pincodeSuggestions } from "../src/actions/geo";


/**
 * Enough of the Next runtime for a client component to render outside it.
 *
 * The forms below are `"use client"`, but a React component is a function either way — so rendering
 * one to HTML here is how the last section checks what the markup actually contains, rather than
 * what the source looks like. `useRouter` is the only hook they reach for that Node cannot provide.
 */
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/navigation") {
    return { useRouter: () => ({ push() {}, refresh() {}, replace() {}, back() {} }) };
  }
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {} };
  // For the company actions, which are required lazily inside main() so this is in place first.
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return {
      requireUser: async () => ({ id: actorId, name: "Probe" }),
      currentUser: async () => ({ id: actorId, name: "Probe" }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;
let actorId = "";

const db = new PrismaClient();
// The PIN directory and its sync row are the shared reference database's, not a workspace's.
const ref = new ReferenceClient({ datasourceUrl: process.env.REFERENCE_DATABASE_URL });
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function main() {
  section("Every state the picker offers is a state the tax engine knows");

  const unresolvable = INDIAN_STATES.filter((s) => stateCodeFromName(s.name) === null);
  ok(
    "every option resolves to a GST code",
    unresolvable.length === 0,
    unresolvable.length ? unresolvable.map((s) => s.name).join(", ") : `${INDIAN_STATES.length} states and union territories`,
  );

  const wrongCode = INDIAN_STATES.filter((s) => stateCodeFromName(s.name) !== s.code);
  ok(
    "  and to the code it is listed under",
    wrongCode.length === 0,
    wrongCode.length
      ? wrongCode.map((s) => `${s.name}: listed ${s.code}, resolves ${stateCodeFromName(s.name)}`).join("; ")
      : "the picker and the engine agree on all of them",
  );

  ok(
    "the list is derived, not a second copy",
    INDIAN_STATES.length === Object.keys(GST_STATE_CODES).length,
    `${INDIAN_STATES.length} vs ${Object.keys(GST_STATE_CODES).length} in GST_STATE_CODES — two hand-kept lists would drift`,
  );

  section("City suggestions belong to their own state");

  const strayStates = Object.keys(CITIES_BY_STATE).filter((s) => !INDIAN_STATES.some((x) => x.name === s));
  ok(
    "every state with cities is a real state",
    strayStates.length === 0,
    strayStates.length ? strayStates.join(", ") : `${Object.keys(CITIES_BY_STATE).length} states carry suggestions`,
  );

  const missing = INDIAN_STATES.filter((s) => !(s.name in CITIES_BY_STATE));
  ok(
    "  and every state has an entry",
    missing.length === 0,
    missing.length ? missing.map((s) => s.name).join(", ") : "no state falls through to an empty picker unexplained",
  );

  ok("Gurugram is suggested for Haryana", citiesIn("Haryana").includes("Gurugram"));
  ok("  but not for Karnataka", !citiesIn("Karnataka").includes("Gurugram"));
  ok(
    "a state stored with odd spacing still gets suggestions",
    citiesIn("tamil nadu").includes("Chennai"),
    "matched loosely, so addresses written before the picker existed are not left bare",
  );
  ok("an unknown state simply has none", citiesIn("harayna").length === 0);

  const dupes = Object.entries(CITIES_BY_STATE).filter(([, cities]) => new Set(cities).size !== cities.length);
  ok("no state lists the same city twice", dupes.length === 0, dupes.map(([s]) => s).join(", "));

  section("Countries");

  ok("India is first and is the default", COUNTRIES[0]?.name === "India");
  ok("a blank country counts as India", isIndia("") && isIndia(null) && isIndia(undefined), "every address stored before this field existed is domestic");
  ok("  and a foreign one does not", !isIndia("Singapore") && !isIndia("United States"));
  ok("no country is listed twice", new Set(COUNTRIES.map((c) => c.code)).size === COUNTRIES.length);

  section("A state written the other official way still resolves");

  /**
   * Every one of these returned null before this section existed.
   *
   * "&" and "and" were different keys, so the four states with an ampersand in their GST name were
   * unreachable by the spelling India Post, the GST portal's exports and most people use — and each
   * of those addresses was taxed as inter-state. The rest are names that were official when somebody
   * wrote them down. The PIN directory is published in exactly these spellings, so without this the
   * whole of Jammu & Kashmir would load with no state to fill in.
   */
  const SPELLINGS: [string, string][] = [
    ["JAMMU AND KASHMIR", "01"],
    ["Jammu and Kashmir", "01"],
    ["ANDAMAN AND NICOBAR ISLANDS", "35"],
    ["DADRA AND NAGAR HAVELI AND DAMAN AND DIU", "26"],
    ["THE DADRA AND NAGAR HAVELI AND DAMAN AND DIU", "26"],
    ["DADRA AND NAGAR HAVELI", "26"],
    ["DAMAN AND DIU", "26"],
    ["CHATTISGARH", "22"],
    ["ORISSA", "21"],
    ["PONDICHERRY", "34"],
    ["UTTARANCHAL", "05"],
    ["NCT OF DELHI", "07"],
  ];
  const wrongly = SPELLINGS.filter(([name, code]) => stateCodeFromName(name) !== code);
  ok(
    "published and former spellings resolve to their GST code",
    wrongly.length === 0,
    wrongly.length
      ? wrongly.map(([n, c]) => `${n} → ${stateCodeFromName(n)} (want ${c})`).join("; ")
      : `${SPELLINGS.length} spellings, all to the right state`,
  );
  ok("  but a typo still resolves to nothing", stateCodeFromName("harayna") === null, "an alias for a typo would hide exactly what the picker is for");
  ok('  and "Andaman" keeps its "and"', stateCodeFromName("Andaman & Nicobar Islands") === "35");
  ok("the picker and the engine still agree on every canonical name", INDIAN_STATES.every((s) => stateCodeFromName(s.name) === s.code));
  ok(
    "city suggestions find a state however it is spelled",
    citiesIn("Jammu and Kashmir").includes("Srinagar"),
    "citiesIn matches the way the engine matches",
  );

  section("PIN rules, before any database");

  ok("a real PIN is accepted", isPincode("110001") && isPincode(" 560001 "));
  ok(
    "  and a leading zero is not a PIN",
    !isPincode("011000"),
    "which is what lets the fixture rows below use 0xxxxx without meeting a real one",
  );
  ok("  nor are five or seven digits", !isPincode("12345") && !isPincode("1100011"));

  const LOCALITIES: [string, string][] = [
    ["Gurgaon H.O", "Gurgaon"],
    ["Bangalore G.P.O.", "Bangalore"],
    ["Sector 14 S.O", "Sector 14"],
    ["Kanhai B.O", "Kanhai"],
    ["Connaught Place S.O", "Connaught Place"],
  ];
  const badLocality = LOCALITIES.filter(([office, want]) => officeLocality(office) !== want);
  ok(
    "an office name loses its office-type suffix",
    badLocality.length === 0,
    badLocality.map(([o]) => `${o} → ${officeLocality(o)}`).join("; ") || "H.O, S.O, B.O and G.P.O.",
  );
  ok("capitals are title-cased", titleCase("GAUTAM BUDDHA NAGAR") === "Gautam Buddha Nagar" && titleCase("GURGAON H.O") === "Gurgaon H.O");

  section("What a PIN is called");

  /**
   * The rules `cityForPin` is built on, one case each.
   *
   * The interesting ones are the refusals. Gautam Buddha Nagar is not Noida: it holds Greater Noida,
   * Dadri and Jewar too, and filling every PIN in it with "Noida" would be confidently wrong for all
   * of those. So a Dadri PIN is called what the directory calls its district — less familiar, never
   * false.
   */
  const CITY_CASES: [string, Parameters<typeof cityForPin>[0], string][] = [
    ["Noida by its office name", { district: "Gautam Buddha Nagar", offices: ["Noida Sector 19 S.O"], stateCode: "09" }, "Noida"],
    ["Greater Noida is not counted as Noida", { district: "Gautam Buddha Nagar", offices: ["Greater Noida S.O"], stateCode: "09" }, "Greater Noida"],
    ["Dadri is not called Noida", { district: "Gautam Buddha Nagar", offices: ["Dadri S.O"], stateCode: "09" }, "Gautam Buddha Nagar"],
    ["Bangalore's offices are Bengaluru", { district: "Bengaluru Urban", offices: ["Bangalore G.P.O."], stateCode: "29" }, "Bengaluru"],
    ["a district that is the city", { district: "Gurugram", offices: ["Sector 14 S.O"], stateCode: "06" }, "Gurugram"],
    ["the offices outvote each other", { district: "New Delhi", offices: ["Dwarka Sector 6 S.O", "Dwarka Sector 10 S.O", "Palam S.O"], stateCode: "07" }, "Dwarka"],
    // Office names carry arbitrary road names. "Bombay Road" in Karnataka is not Mumbai, because an
    // alias only counts where the city it points at is one that state actually has.
    ["an old name in an office is not another state's city", { district: "Tumakuru", offices: ["Bombay Road S.O"], stateCode: "29" }, "Tumakuru"],
    ["a town is named by its office, not its district", { district: "Krishnagiri", offices: ["Hosur Industrial Complex S.O"], stateCode: "33" }, "Hosur"],
    ["nothing to match falls back to the district", { district: "KRISHNAGIRI", offices: ["Bargur S.O"], stateCode: "33" }, "Krishnagiri"],
  ];
  for (const [label, input, want] of CITY_CASES) {
    const got = cityForPin(input);
    ok(label, got === want, got === want ? want : `got "${got}", want "${want}"`);
  }

  const bengaluru = pinSearchFor("Bengaluru");
  ok(
    "a city's PINs are searched under every name it has had",
    bengaluru.districtKeys.includes("bengaluruurban") && bengaluru.officePrefixes.includes("Bangalore"),
    `districts ${bengaluru.districtKeys.join(", ")} · offices ${bengaluru.officePrefixes.join(", ")}`,
  );
  ok("  and asking by an old name finds the same place", pinSearchFor("Bangalore").districtKeys.includes("bengaluru"));

  const merged = mergeCitySuggestions(["Bengaluru", "Mysuru"], ["BENGALURU URBAN", "MYSORE", "KOLAR", "BANGALORE"]);
  ok(
    "district suggestions follow the curated ones without repeating them",
    merged.join("|") === "Bengaluru|Mysuru|Kolar",
    merged.join(", "),
  );

  section("Reading India Post's file");

  const CURRENT = "circlename,regionname,divisionname,officename,pincode,officetype,delivery,district,statename,latitude,longitude";
  const current = mapColumns(CURRENT.split(","));
  ok("the current headings are recognised", current.ok);
  const older = mapColumns(["officename", "pincode", "officeType", "Deliverystatus", "divisionname", "Taluk", "Districtname", "statename"]);
  ok("  and the older ones", older.ok, "Districtname and Deliverystatus, as the directory was published before 2020");
  const wrongFile = mapColumns(["name", "email", "pincode"]);
  ok(
    "a file that is not the directory is named as such",
    !wrongFile.ok && wrongFile.missing.includes("district"),
    wrongFile.ok ? "" : `missing ${wrongFile.missing.join(", ")}`,
  );

  if (current.ok) {
    const row = parseRow(
      { officename: "SRINAGAR G.P.O.", pincode: "190001", officetype: "HO", delivery: "Non Delivery", district: "SRINAGAR", statename: "JAMMU AND KASHMIR", latitude: "NA", longitude: "74.79" },
      current.map,
    );
    ok("a row reads cleanly", !("skip" in row), JSON.stringify(row).slice(0, 90));
    if (!("skip" in row)) {
      ok("  its state resolves through the published spelling", row.stateCode === "01", row.stateName);
      ok('  "Non Delivery" is not a delivery office', row.delivery === false);
      ok('  "NA" is no coordinate, and a real one survives', row.latitude === null && row.longitude === 74.79);
      ok("  the office and district are title-cased", row.officeName === "Srinagar G.P.O." && row.district === "Srinagar");
    }
    const bad = parseRow({ officename: "X", pincode: "011000", district: "Y", statename: "Z" }, current.map);
    ok("a row with no real PIN is set aside, with the reason", "skip" in bad && bad.skip === "bad-pincode");
  }

  /**
   * The whole path a download takes: gzipped, with the byte-order mark Excel puts on a CSV, and a
   * state spelling nothing recognises. That last row must be *kept* — the PIN is real — and reported.
   */
  const sample = [
    CURRENT,
    "Delhi,Delhi,New Delhi Central,Connaught Place S.O,110001,SO,Delivery,NEW DELHI,DELHI,28.63,77.21",
    "Delhi,Delhi,New Delhi Central,Janpath S.O,110001,SO,Delivery,NEW DELHI,DELHI,NA,NA",
    "Karnataka,Bangalore HQ,Bangalore GPO,Bangalore G.P.O.,560001,HO,Delivery,BENGALURU URBAN,KARNATAKA,12.97,77.59",
    "X,X,X,Nowhere B.O,560099,BO,Delivery,SOMEWHERE,ATLANTIS,,",
    "X,X,X,Broken B.O,56,BO,Delivery,SOMEWHERE,KARNATAKA,,",
  ].join("\n");
  const tmp = path.join(tmpdir(), `zz-pin-${process.pid}.csv.gz`);
  try {
    writeFileSync(tmp, gzipSync(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(sample)])));
    const { text, checksum } = readDirectoryFile(tmp);
    ok("a gzipped download with a byte-order mark reads", text.startsWith("circlename"), `sha256 ${checksum.slice(0, 12)}…`);
    const parsed = parseDirectory(text);
    ok("  every usable row is kept", parsed.rows.length === 4, `${parsed.rows.length} rows`);
    ok("  the broken PIN is counted, not silently dropped", parsed.skipped["bad-pincode"] === 1);
    ok(
      "  and an unknown state is loaded but reported",
      parsed.unresolvedStates["Atlantis"] === 1 && parsed.rows.some((r) => r.pincode === "560099" && r.stateCode === null),
      JSON.stringify(parsed.unresolvedStates),
    );
  } finally {
    rmSync(tmp, { force: true });
  }

  ok(
    "a much smaller file is refused rather than loaded",
    refusalFor(165_000, 40, false) !== null && refusalFor(165_000, 40, true) === null,
    "a truncated download must not empty the country's PIN lookup in one transaction",
  );
  ok("  a normal month's change is not", refusalFor(165_000, 164_700, false) === null);
  ok("  and the first load always goes ahead", refusalFor(0, 12, false) === null);
  ok("  but an empty file never does, forced or not", refusalFor(0, 0, true) !== null);

  section("The forms that collect an address use the picker");

  /**
   * Read rather than rendered.
   *
   * A form that quietly kept a free-text state would pass every behavioural check in this file —
   * the picker is fine, it is just not being used — so what has to be asserted is the wiring.
   */
  const FORMS = [
    ["company locations", "src/components/companies/locations-manager.tsx"],
    ["new company", "src/components/companies/new-company-form.tsx"],
    ["quick-create company", "src/components/companies/quick-create-company-dialog.tsx"],
    ["employee record", "src/components/hr/employee-form.tsx"],
    ["new-joiner intake", "src/components/hr/intake-form.tsx"],
    ["organisation settings", "src/components/settings/organisation-manager.tsx"],
  ] as const;

  for (const [name, file] of FORMS) {
    const source = readFileSync(file, "utf8");
    ok(`${name}: uses AddressFields`, /<AddressFields/.test(source));
    ok(
      `  and no longer takes the state as free text`,
      !/<Input[^>]*value=\{form\.state\}/.test(source) &&
        !/register\("state"\)/.test(source) &&
        !/register\("location\.state"\)/.test(source) &&
        !/register\("location\.city"\)/.test(source),
      "a leftover text box beside the picker is two ways to set the same field",
    );
  }

  /**
   * The document address is the one case that cannot use `AddressFields`, and is checked separately
   * rather than waived.
   *
   * It stores the GST state *code* alongside the name — the code is what the e-invoice carries and
   * what `isIntraState` compares — so its state control is a `GST_STATE_OPTIONS` select keyed on the
   * code, which `AddressFields` (names only) would have downgraded. What it was missing was the rest
   * of the hierarchy: a free-text country, and a city box with no idea which state it sat under.
   */
  const editor = readFileSync("src/components/documents/address-editor.tsx", "utf8");
  ok("document address: state is still the GST code list", /GST_STATE_OPTIONS.map/.test(editor));
  ok(
    "  city suggestions follow the chosen state",
    /useCitySuggestions\(draft\.state/.test(editor),
    "off the state name the select stores beside the code, districts included",
  );
  ok(
    "  the PIN is looked up, and moves the code and the name together",
    /<PincodeField/.test(editor) && /stateCode: place\.stateCode, state: place\.stateName/.test(editor),
    "setting the name alone would print one state and tax another",
  );
  ok(
    "  and the fields run country → state → city → PIN",
    ["htmlFor=\"country\"", "htmlFor=\"stateCode\"", "htmlFor=\"city\"", "<PincodeField"]
      .map((marker) => editor.indexOf(marker))
      .every((at, i, all) => at !== -1 && (i === 0 || at > all[i - 1]!)),
  );

  const quick = readFileSync("src/components/companies/quick-create-company-dialog.tsx", "utf8");
  ok("the quick-create dialog collects a PIN too", /pincode=\{String\(watch\("location\.pincode"\)/.test(quick) && !/showPincode=\{false\}/.test(quick));
  ok(
    "  country is chosen, not typed",
    /<Select id="country"/.test(editor) && !/<Input id="country"/.test(editor),
    'otherwise "Bharat", "IN" and "india" are three countries on three documents',
  );

  section("Repeated rows do not label themselves with a field-array id");

  /**
   * Not an address rule, but the bug that surfaced while wiring these forms, and it lives here
   * because this is the suite that reads the forms.
   *
   * `useFieldArray` gives each row an id that is stable across re-renders — the right React `key`.
   * It is also a fresh random UUID per render *environment*, so putting it in a DOM id makes the
   * server's markup and the browser's disagree on every one of those attributes. That is a hydration
   * mismatch, and React does not patch attributes up: the labels end up pointing at nothing, so
   * clicking one does not focus its field and a screen reader announces the input unnamed.
   */
  const ROW_FORMS = [
    "src/components/companies/new-company-form.tsx",
    "src/components/leads/new-lead-form.tsx",
    "src/components/orders/new-order-form.tsx",
  ];
  for (const file of ROW_FORMS) {
    const source = readFileSync(file, "utf8");
    const offenders = source.match(/(?:htmlFor|id)=\{`[^`]*\$\{\w+\.id\}/g) ?? [];
    ok(
      `${file.split("/").pop()}: no DOM id built from a row id`,
      offenders.length === 0,
      offenders.length ? offenders.join(", ") : "labels pair by useId or by aria-label",
    );
  }

  section("The new-company form, rendered");

  /**
   * The sections above read source. This one runs it, because two things cannot be read off a file:
   * whether the picker actually puts the GST list in the markup, and whether the markup is the same
   * twice.
   *
   * Hydration compares the server's HTML with the browser's first render, and anything inside an
   * attribute that differs between them is a mismatch React will not patch up. Two renders in one
   * process stand in for the two environments — identical ids here means identical ids there. This
   * caught a real one: every contact row was labelled with its `useFieldArray` id, which is a fresh
   * uuid per environment, so none of those labels pointed at anything after hydration.
   */
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { NewCompanyForm } = require("../src/components/companies/new-company-form") as {
    NewCompanyForm: React.ComponentType<{ industries: { id: string; name: string }[] }>;
  };
  const render = () =>
    renderToStaticMarkup(React.createElement(NewCompanyForm, { industries: [{ id: "i1", name: "IT Services" }] }));
  const first = render();
  const second = render();

  const attrs = (html: string) => (html.match(/(?:\bid|for)="[^"]*"/g) ?? []).sort();
  ok(
    "two renders agree on every id and htmlFor",
    JSON.stringify(attrs(first)) === JSON.stringify(attrs(second)),
    "which is exactly what hydration compares",
  );
  ok(
    "  and no id is a uuid",
    !/(?:\bid|for)="[0-9a-f]{8}-[0-9a-f]{4}-/.test(first),
    "a row id from useFieldArray is regenerated per render environment",
  );

  const labelled = [...first.matchAll(/for="([^"]+)"/g)].map((m) => m[1]!);
  const targets = new Set([...first.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!));
  const dangling = labelled.filter((f) => !targets.has(f));
  ok("every label points at a field that exists", dangling.length === 0, dangling.join(", "));

  ok(
    "the state reaches the browser as the GST list",
    /<option value="Haryana">/.test(first) && /<option value="Tamil Nadu">/.test(first),
    "imported is not the same as rendered",
  );
  ok("  and no free-text state box is left beside it", !/id="location\.state"/.test(first));

  section("A postal code is judged by its country");

  /**
   * Six digits is an Indian rule. It used to be applied to every address, so a customer in London
   * could not be saved with their postcode at all.
   */
  const POSTAL: [string, string, boolean][] = [
    ["India", "110001", true],
    ["India", "12345", false],
    ["", "SW1A 1AA", false], // a blank country is India
    ["United Kingdom", "SW1A 1AA", true],
    ["United States", "10001", true],
    ["Canada", "M5V 3L9", true],
    ["Australia", "2000", true],
    ["Singapore", "$$$", false],
  ];
  const postalWrong = POSTAL.filter(([country, code, valid]) => (postalCodeIssue(country, code) === null) !== valid);
  ok(
    "six digits in India, any postal code elsewhere",
    postalWrong.length === 0,
    postalWrong.length ? postalWrong.map(([c, p]) => `${c || "(blank)"} ${p}`).join("; ") : `${POSTAL.length} cases`,
  );

  /**
   * Against every schema that actually parses an address, not just the helper.
   *
   * The rule lives on the object, and zod drops object-level rules when one schema spreads another's
   * `.shape` — so each final schema has to carry it, and one that forgot would accept anything. The
   * way to know is to hand each one a UK postcode twice: once as a UK address, once as an Indian one.
   */
  const uk = { country: "United Kingdom", pincode: "SW1A 1AA" };
  const inIndia = { country: "India", pincode: "SW1A 1AA" };
  const SCHEMAS: [string, (a: object) => { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }][] = [
    ["company location", (a) => companyLocationFieldsSchema.safeParse({ label: "HQ", ...a })],
    ["adding a location", (a) => addCompanyLocationSchema.safeParse({ companyId: "c", label: "HQ", ...a })],
    ["editing a location", (a) => updateCompanyLocationSchema.safeParse({ id: "l", label: "HQ", ...a })],
    ["a new company's first address", (a) => createCompanySchema.safeParse({ name: "Xylo Ltd", location: { label: "HQ", ...a } })],
    ["a document's billing address", (a) => documentAddressSchema.safeParse(a)],
    ["the organisation's address", (a) => organisationSettingsSchema.safeParse({ legalName: "X", ...a })],
  ];
  for (const [label, parse] of SCHEMAS) {
    const abroad = parse(uk);
    const home = parse(inIndia);
    ok(
      `${label}: a UK postcode saves for a UK address, and not for an Indian one`,
      abroad.success && !home.success && (home.error?.issues ?? []).some((i) => i.path.includes("pincode")),
      abroad.success ? (home.success ? "the Indian address was accepted too" : "") : "the UK address was refused",
    );
  }

  section("The organisation's GST state is its GSTIN's");

  const org = (extra: object) => organisationSettingsSchema.safeParse({ legalName: "X", ...extra });
  const clash = org({ gstin: "27AABCW1234F1Z5", stateCode: "06" });
  ok(
    "a state code that disagrees with the GSTIN is refused",
    !clash.success && clash.error.issues.some((i) => i.path.includes("stateCode") && /Maharashtra \(27\)/.test(i.message)),
    clash.success ? "saved — every invoice would be taxed from Haryana under a Maharashtra GSTIN" : clash.error.issues[0]?.message,
  );
  ok("  the matching one is accepted", org({ gstin: "27AABCW1234F1Z5", stateCode: "27" }).success);
  ok("  and with no GSTIN yet, any state code is", org({ stateCode: "06" }).success);

  const orgForm = readFileSync("src/components/settings/organisation-manager.tsx", "utf8");
  ok("the organisation profile offers a country", /<AddressFields/.test(orgForm) && !/showCountry=\{false\}/.test(orgForm) && /country=\{form\.country\}/.test(orgForm));
  ok(
    "  and its address state moves the GST code only while there is no GSTIN",
    /patch\.state !== undefined && !gstinState/.test(orgForm),
    "choosing Haryana used to turn a Maharashtra GSTIN's company into a Haryana seller",
  );

  section("Creating a company from the forms");

  /**
   * Through the real `createCompany` and `findCompanyMatches`, as the super admin and as a salesperson
   * who cannot see the admin's accounts. Everything is named ZZPROBE_ADDR and removed in the finally.
   */
  /* eslint-disable @typescript-eslint/no-require-imports */
  const companyActions = require("../src/actions/company") as typeof import("../src/actions/company");
  const PROBE = `ZZPROBE_ADDR ${process.pid}`;
  const admin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  const cleanup = async () => {
    const probes = await db.company.findMany({ where: { name: { startsWith: "ZZPROBE_ADDR" } }, select: { id: true } });
    await db.auditLog.deleteMany({ where: { entityType: "Company", entityId: { in: probes.map((p) => p.id) } } });
    await db.company.deleteMany({ where: { id: { in: probes.map((p) => p.id) } } });
    await db.user.deleteMany({ where: { email: "zzprobe.addr@example.invalid" } });
  };
  await cleanup();
  try {
    actorId = admin!.id;
    const created = await companyActions.createCompany({
      name: `${PROBE} Gurugram`,
      location: { label: "HQ", city: "Gurugram", state: "Haryana", country: "India", pincode: "122001", gstTreatment: "UNREGISTERED" },
      contacts: [{ name: "Zzprobe Person", designation: "CIO", email: "zzprobe.person@example.invalid", phone: "", isPrimary: true }],
    });
    ok("a company with an address and a contact is created", created.ok, created.ok ? "" : created.error);
    if (created.ok) {
      ok(
        "  the new contact comes back, so the lead form can select it",
        created.data.contacts.length === 1 && created.data.contacts[0]!.name === "Zzprobe Person",
      );
      const loc = await db.companyLocation.findFirst({ where: { companyId: created.data.id } });
      ok("  its PIN is saved", loc?.pincode === "122001", `stored ${JSON.stringify(loc?.pincode)} — this was dropped before`);
      ok(
        "  and its only address is both billing and shipping",
        loc?.isBilling === true && loc?.isShipping === true,
        "a company created from the app used to have no billing address for its first invoice",
      );
    }

    const overseas = await companyActions.createCompany({
      name: `${PROBE} London`,
      location: { label: "HQ", city: "London", state: "Greater London", country: "United Kingdom", pincode: "SW1A 1AA", gstTreatment: "OVERSEAS" },
    });
    ok("an overseas company saves with its postcode", overseas.ok, overseas.ok ? "" : overseas.error);
    const badPin = await companyActions.createCompany({
      name: `${PROBE} Bad`,
      location: { label: "HQ", country: "India", pincode: "SW1A 1AA", gstTreatment: "UNREGISTERED" },
    });
    ok("  but an Indian one without a real PIN does not", !badPin.ok && /six digits/.test(badPin.error), badPin.ok ? "saved" : badPin.error);

    const asAdmin = await companyActions.findCompanyMatches(`  ${PROBE.toLowerCase()}   gurugram `);
    ok(
      "typing an existing name finds it, whatever the case and spacing",
      asAdmin.duplicate?.visible === true && /^[A-Z]{3}-\d{6}$/.test(asAdmin.duplicate.match.ref),
      asAdmin.duplicate?.visible ? `${asAdmin.duplicate.match.name} → ${asAdmin.duplicate.match.ref}` : JSON.stringify(asAdmin.duplicate),
    );
    const partial = await companyActions.findCompanyMatches(PROBE);
    ok("  and part of a name lists the similar ones", partial.matches.length >= 2 && partial.duplicate === null, partial.matches.map((m) => m.name).join(", "));

    const rep = await db.user.create({
      data: { name: "Zzprobe Rep", email: "zzprobe.addr@example.invalid", role: "SALES", passwordHash: "x".repeat(60) },
    });
    actorId = rep.id;
    const asRep = await companyActions.findCompanyMatches(`${PROBE} Gurugram`);
    ok(
      "somebody who cannot see it is told it exists, and nothing more",
      asRep.duplicate !== null && asRep.duplicate.visible === false && asRep.matches.length === 0,
      "no name, no link, no owner — only that saving would be refused, which the save itself would say",
    );
  } finally {
    await cleanup();
  }
  ok(
    "the probe companies and user are gone",
    (await db.company.count({ where: { name: { startsWith: "ZZPROBE_ADDR" } } })) === 0 &&
      (await db.user.count({ where: { email: "zzprobe.addr@example.invalid" } })) === 0,
  );

  const quickSrc = readFileSync("src/components/companies/quick-create-company-dialog.tsx", "utf8");
  const leadSrc = readFileSync("src/components/leads/new-lead-form.tsx", "utf8");
  const newCompanySrc = readFileSync("src/components/companies/new-company-form.tsx", "utf8");
  ok(
    "the quick-create dialog takes a contact person and hands it back",
    /qc-contact-name/.test(quickSrc) && /contacts: result\.data\.contacts/.test(quickSrc),
  );
  ok("  and the lead form selects them", /setValue\("contactId", company\.contacts\[0\]\?\.id \?\? ""\)/.test(leadSrc));
  ok("the new-company form searches existing companies as the name is typed", /nameAddon=\{<ExistingCompanyMatches/.test(newCompanySrc));

  section("A company's size is a band");

  const bandsTouch = EMPLOYEE_BANDS.every((b, i) => i === 0 || b.min === (EMPLOYEE_BANDS[i - 1]!.max ?? -1) + 1);
  ok(
    "the bands run from 1 upward with no gap and no overlap",
    EMPLOYEE_BANDS[0]!.min === 1 && bandsTouch && EMPLOYEE_BANDS.at(-1)!.max === null,
    EMPLOYEE_BANDS.map((b) => b.label).join(" · "),
  );
  ok(
    "a count finds its band, at the edges too",
    bandForCount(37)?.key === "11-50" && bandForCount(50)?.key === "11-50" && bandForCount(51)?.key === "51-200" && bandForCount(250_000)?.key === "10001+",
  );
  ok("  and nothing, or a zero left over from older data, has none", bandForCount(null) === null && bandForCount(0) === null);
  ok(
    "a band keeps a precise count it already contains",
    countForBand("51-200", 85) === 85,
    "re-saving a company with 85 staff must not round it down to 51",
  );
  ok("  and otherwise stores its lower bound", countForBand("51-200", 30) === 51 && countForBand("10001+", null) === 10001);
  ok("  and blank clears it", countForBand("", 85) === null);

  const fieldsSrc = readFileSync("src/components/companies/company-fields.tsx", "utf8");
  ok(
    "the company form offers the bands, not a number box",
    /EMPLOYEE_BANDS\.map/.test(fieldsSrc) && !/id="employeeCount" type="number"/.test(fieldsSrc),
  );
  const SHOWS = [
    "src/components/companies/company-detail.tsx",
    "src/components/workspace/workbook-results.tsx",
    "src/components/workspace/calling-station.tsx",
    "src/components/domains/domain-panel.tsx",
    "src/lib/domain-intel/opportunities.ts",
  ];
  const rawShown = SHOWS.filter((f) => !/headcountLabel\(/.test(readFileSync(f, "utf8")));
  ok(
    "  and everywhere a size is shown, it is shown as the band",
    rawShown.length === 0,
    rawShown.length ? rawShown.join(", ") : "a stored lower bound would otherwise read as a precise “51 employees”",
  );

  await cleanup();
  try {
    actorId = admin!.id;
    const sized = await companyActions.createCompany({
      name: `${PROBE} Sized`,
      employeeBand: "11-50",
      location: { label: "HQ", gstTreatment: "UNREGISTERED" },
    });
    ok("a new company saved with a band", sized.ok, sized.ok ? "" : sized.error);
    if (sized.ok) {
      const stored = async () => (await db.company.findUnique({ where: { id: sized.data.id }, select: { employeeCount: true } }))?.employeeCount;
      ok("  stores the band's lower bound", (await stored()) === 11);

      // As if an import or domain intelligence had since learned the exact figure.
      await db.company.update({ where: { id: sized.data.id }, data: { employeeCount: 37 } });
      const resave = (employeeBand: string) =>
        companyActions.updateCompany({ id: sized.data.id, name: `${PROBE} Sized`, relationshipType: "CLIENT", employeeBand });
      await resave("11-50");
      ok("editing it without changing the band keeps the exact 37", (await stored()) === 37, `stored ${await stored()}`);
      await resave("51-200");
      ok("  choosing a different band moves it", (await stored()) === 51);
      await resave("");
      ok("  and choosing Not known clears it", (await stored()) === null);
    }
  } finally {
    await cleanup();
  }

  section("A company picker does not offer to create what it already lists");

  const listed = ["Acme Chemicals India Pvt Ltd", "Bharat Steel"];
  const CREATE_CASES: [string, boolean][] = [
    ["Acme Chemicals India Pvt Ltd", false],
    ["  acme   chemicals india pvt ltd ", false],
    ["Acme Chem", true],
    ["Zenith Labs", true],
    ["   ", false],
  ];
  const createWrong = CREATE_CASES.filter(([typed, want]) => offersCreate(typed, listed) !== want);
  ok(
    'an exact name — however it is typed — hides "create new"',
    createWrong.length === 0,
    createWrong.map(([t]) => JSON.stringify(t)).join(", ") || "part of a name still offers it; the whole name does not",
  );
  ok("  and the picker uses that rule", /offersCreate\(trimmed,/.test(readFileSync("src/components/ui/company-combobox.tsx", "utf8")));

  section("The quick-create dialog");

  const quickDialog = readFileSync("src/components/companies/quick-create-company-dialog.tsx", "utf8");
  ok("offers a country", /<AddressFields/.test(quickDialog) && !/showCountry=\{false\}/.test(quickDialog));
  ok("  and checks the name against the whole CRM as it is typed", /<ExistingCompanyMatches name=/.test(quickDialog));
  ok(
    "a customer abroad becomes Overseas, not Unregistered",
    treatmentForCountryChange(false, "UNREGISTERED") === "OVERSEAS" && treatmentForCountryChange(true, "OVERSEAS") === "UNREGISTERED",
    "the dialog has no treatment field, so this is the only way it could be right",
  );
  ok(
    "  but a treatment somebody chose is left alone",
    treatmentForCountryChange(false, "SEZ") === null && treatmentForCountryChange(false, "REGISTERED_REGULAR") === null,
  );
  ok(
    "  and the dialog starts from a treatment the rule can see",
    (quickDialog.match(/gstTreatment: "UNREGISTERED"/g) ?? []).length === 2 && /treatmentForCountryChange\(/.test(quickDialog),
    "left to the schema default, the form reads undefined and the rule never fires",
  );

  section("Syncing the PIN directory from Settings");

  const catalogue = readFileSync("src/lib/settings/catalogue.ts", "utf8");
  ok(
    "it has a settings page, for settings managers only",
    /key: "pin-directory"[\s\S]{0,300}permission: "settings\.manage"/.test(catalogue),
  );
  ok("  and its sync state is reference data, which no workspace's reset reaches", REFERENCE_TABLES.some((t) => t.table === "reference_syncs"));

  /**
   * Through the real actions, as the super admin — but only while no real key is saved. Everything
   * below writes to `reference_syncs`, and a check must never overwrite somebody's key or interrupt
   * a sync they started. With a key in place it says so and checks only what cannot change anything.
   */
  const refActions = require("../src/actions/reference-data") as typeof import("../src/actions/reference-data");
  const existingSync = await ref.referenceSync.findUnique({ where: { key: PIN_DIRECTORY_KEY } });
  actorId = admin!.id;

  // Shared by every workspace, so changed only from the platform's (src/lib/platform/shared-data.ts).
  {
    const { currentTenant, runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
    const here = await currentTenant();
    ok("this workspace may change it — the first, the installation's own", here.isDefault);
    const elsewhere = { ...here, isDefault: false };
    const refusedKey = await runAsTenant(elsewhere, () => refActions.savePinDirectoryApiKey("zzprobe0123456789abcdef0123456789"));
    const refusedSync = await runAsTenant(elsewhere, () => refActions.startPinDirectorySync());
    const refusedWorld = await runAsTenant(elsewhere, () => refActions.startWorldPlacesSync());
    ok(
      "  any other workspace's admin can see it but not save a key or start a sync",
      !refusedKey.ok && !refusedSync.ok && !refusedWorld.ok && /only the platform/.test(refusedKey.error),
      refusedKey.ok ? "saved" : refusedKey.error,
    );
    const seen = await runAsTenant(elsewhere, () => refActions.getPinDirectory());
    ok("  and its page says so, with no controls", seen.ok && seen.data.canManage === false);
  }
  if (existingSync?.apiKeyCipher || existingSync?.status === "RUNNING") {
    console.log("  (a real key or a running sync is in place — checking read-only)");
    const state = await refActions.getPinDirectory();
    ok("the page state says a key is saved, and nothing more", state.ok && state.data.sync.hasApiKey && (!existingSync.apiKeyCipher || !JSON.stringify(state).includes(existingSync.apiKeyCipher)));
  } else {
    const FAKE = "zzprobe0123456789abcdef0123456789";
    // Only the audit rows this run writes are removed afterwards — never anybody's real history.
    const auditSince = new Date();
    try {
      const noKey = await refActions.startPinDirectorySync();
      ok("a sync cannot start without a key", !noKey.ok && /API key first/.test(noKey.error), noKey.ok ? "started" : noKey.error);

      const junk = await refActions.savePinDirectoryApiKey("not a key");
      ok("  and junk is not saved as one", !junk.ok);

      const saved = await refActions.savePinDirectoryApiKey(`  ${FAKE}  `);
      ok("a key is saved", saved.ok, saved.ok ? "" : saved.error);
      const row = await ref.referenceSync.findUnique({ where: { key: PIN_DIRECTORY_KEY } });
      ok(
        "  sealed under the platform key, not as typed",
        !!row?.apiKeyCipher && !row.apiKeyCipher.includes(FAKE) && openForPlatform("reference-sync-key", row.apiKeyCipher) === FAKE,
        "and it opens back to exactly the key, trimmed — with no workspace's keys involved",
      );
      const state = await refActions.getPinDirectory();
      ok(
        "  and the page gets only the fact of it",
        state.ok && state.data.sync.hasApiKey && !JSON.stringify(state).includes(FAKE) && !JSON.stringify(state).includes(row!.apiKeyCipher!),
        "neither the key nor its ciphertext reaches a browser",
      );

      // A run already going: the claim must refuse a second one — without spawning anything.
      await ref.referenceSync.update({ where: { key: PIN_DIRECTORY_KEY }, data: { status: "RUNNING", startedAt: new Date() } });
      const second = await refActions.startPinDirectorySync();
      ok("a second sync while one runs is refused", !second.ok && /already running/.test(second.error), second.ok ? "started a second" : second.error);

      const removed = await refActions.removePinDirectoryApiKey();
      const afterRemove = await ref.referenceSync.findUnique({ where: { key: PIN_DIRECTORY_KEY } });
      ok("a key can be removed", removed.ok && afterRemove?.apiKeyCipher === null);
    } finally {
      // Back exactly as it was: gone if there was no row, otherwise the row it was (a past run's
      // outcome, with no key — the branch above is only taken when there is none).
      if (existingSync) {
        const { key, updatedAt, ...before } = existingSync;
        void updatedAt;
        await ref.referenceSync.update({ where: { key }, data: before });
      } else {
        await ref.referenceSync.deleteMany({ where: { key: PIN_DIRECTORY_KEY } });
      }
      await db.auditLog.deleteMany({ where: { entityType: "ReferenceSync", entityId: PIN_DIRECTORY_KEY, createdAt: { gte: auditSince } } });
    }
  }

  section("PIN lookups against the directory");

  /**
   * Through the real server actions, against rows this check owns.
   *
   * The fixture PINs start with 0, which no real PIN does, and every office is named "Zzprobe …" —
   * so the cleanup below matches on both and cannot reach a real post office even if one of the two
   * conditions were somehow wrong. Rows are added and removed here directly, never through the
   * loader: the loader *replaces* the table, and a check has no business doing that to the live one.
   */
  const FIXTURE_WHERE = { pincode: { startsWith: "0" }, officeName: { startsWith: "Zzprobe" } };
  const fixture = [
    // Two offices on one PIN, and the non-delivery one sorts first alphabetically — the lookup must
    // still lead with the office that delivers.
    { pincode: "000001", officeName: "Zzprobe Aaa S.O", delivery: false, district: "Zzprobe Town", stateName: "Haryana", stateCode: "06" },
    { pincode: "000001", officeName: "Zzprobe Zzz S.O", delivery: true, district: "Zzprobe Town", stateName: "Haryana", stateCode: "06" },
    { pincode: "000002", officeName: "Zzprobe Market B.O", delivery: true, district: "Zzprobe Town", stateName: "Haryana", stateCode: "06" },
    { pincode: "000003", officeName: "Zzprobe Hill B.O", delivery: true, district: "Zzprobe Uplands", stateName: "Karnataka", stateCode: "29" },
  ].map((r) => ({ ...r, officeType: "SO", districtKey: placeKey(r.district) }));

  await ref.postOffice.deleteMany({ where: FIXTURE_WHERE });
  try {
    await ref.postOffice.createMany({ data: fixture });

    const found = await lookupPincode("000001");
    ok("a PIN is found", found.ok, found.ok ? "" : found.reason);
    if (found.ok) {
      ok("  with its state as the picker spells it", found.stateCode === "06" && found.stateName === "Haryana");
      ok("  its city", found.city === "Zzprobe Town", found.city);
      ok(
        "  and the delivering office named first",
        found.localities[0] === "Zzprobe Zzz",
        `${found.localities.join(", ")} — the one a person gets post at, not the alphabetical one`,
      );
    }
    const spaced = await lookupPincode(" 000 001 ");
    ok("spaces typed into a PIN do not matter", spaced.ok);

    const missing = await lookupPincode("000009");
    ok(
      "a PIN the directory lacks says so",
      !missing.ok && missing.reason === "not-found",
      "as distinct from there being no directory at all, which the form keeps quiet about",
    );
    const junk = await lookupPincode("12ab56");
    ok("  and junk is refused before any query", !junk.ok && junk.reason === "invalid");

    const cities = await citySuggestions("Haryana");
    ok(
      "a state's cities include the directory's districts",
      cities.includes("Zzprobe Town") && cities.includes("Gurugram"),
      `${cities.length} cities`,
    );
    ok(
      "  after the curated ones, not mixed in",
      cities.indexOf("Gurugram") < cities.indexOf("Zzprobe Town"),
    );
    ok("  and nothing from another state", !cities.includes("Zzprobe Uplands"));
    ok(
      "an unrecognised state still gets its curated list",
      (await citySuggestions("harayna")).length === 0 && (await citySuggestions("Kerala")).includes("Kochi"),
    );

    const pins = await pincodeSuggestions("Haryana", "Zzprobe Town");
    ok(
      "a city's PINs are offered once it is chosen",
      pins.map((p) => p.pincode).join(",") === "000001,000002",
      pins.map((p) => `${p.pincode} ${p.area}`).join(" · "),
    );
    ok("  once each, named by the office that delivers", pins[0]?.area === "Zzprobe Zzz");
    ok("  and not across a state line", (await pincodeSuggestions("Karnataka", "Zzprobe Town")).length === 0);
  } finally {
    await ref.postOffice.deleteMany({ where: FIXTURE_WHERE });
  }
  ok("the fixture is gone", (await ref.postOffice.count({ where: FIXTURE_WHERE })) === 0);

  section("Reference data survives every reset");

  /**
   * Read rather than run, like the ordering checks elsewhere — the property is that nothing
   * *would* delete these rows, and the only way to demonstrate that by running things is to run
   * every reset and look, which on a development database is itself the damage.
   *
   * The scanner is proved on text first, so a regex that matched nothing cannot pass for a clean
   * codebase.
   */
  const offendersIn = (source: string) =>
    REFERENCE_TABLES.flatMap(({ model, table }) => [
      ...[...source.matchAll(new RegExp(`\\.${model}\\.(?:delete|deleteMany)\\(`, "g"))].map((m) => m[0]),
      ...[...source.matchAll(new RegExp(`(?:TRUNCATE|DELETE\\s+FROM|DROP\\s+TABLE)[^;]{0,40}?\\b${table}\\b`, "gi"))].map((m) => m[0]),
    ]);

  ok(
    "the scanner catches a delete",
    offendersIn("await db.postOffice.deleteMany({});").length === 1 &&
      offendersIn('await tx.referenceDataset.delete({ where: { key: "x" } })').length === 1,
  );
  ok(
    "  and raw SQL",
    offendersIn('await db.$executeRawUnsafe("TRUNCATE TABLE post_offices")').length === 1 &&
      offendersIn('db.$executeRaw`DELETE FROM "post_offices"`').length === 1,
  );
  ok("  but not a read", offendersIn("await db.postOffice.findMany({ where: { pincode } })").length === 0);

  /**
   * Everything that could be asked to clear data: seeds, demo resets, scripts, and the app itself.
   * Two exemptions, each for a reason. The loader is the one thing allowed to replace these rows.
   * This file removes the fixture rows it added above, by a filter that cannot match a real PIN.
   */
  const EXEMPT = [path.normalize("prisma/reference/"), path.normalize("scripts/check-address.ts")];
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return name === "node_modules" || name === "migrations" ? [] : walk(full);
      return /\.(ts|tsx|mjs|js)$/.test(name) ? [full] : [];
    });
  const scanned = ["prisma", "scripts", "src"].flatMap(walk).filter((f) => !EXEMPT.some((e) => path.normalize(f).startsWith(e)));
  const deleting = scanned.flatMap((file) => offendersIn(readFileSync(file, "utf8")).map((hit) => `${file}: ${hit}`));
  ok(
    `no seed, reset, script or action deletes reference data`,
    deleting.length === 0,
    deleting.length ? deleting.join("; ") : `${scanned.length} files scanned, ${REFERENCE_TABLES.map((t) => t.table).join(" and ")} untouched`,
  );

  const seed = readFileSync("prisma/seed.ts", "utf8");
  ok(
    "a new machine's seed loads the directory into the shared database",
    /import \{ ensurePincodes \} from "\.\/reference\/pincodes"/.test(seed) && /await ensurePincodes\(reference\)/.test(seed),
  );
  const workspaceSchema = readFileSync("prisma/schema.prisma", "utf8");
  ok(
    "  and no workspace's database holds it — a reset, restore or migrate reset of one cannot reach it",
    REFERENCE_TABLES.every((t) => !workspaceSchema.includes(`@@map("${t.table}")`)),
    "prisma/reference/schema.prisma",
  );

  /**
   * The migration that took the tables out of workspace databases refuses while any of them holds a
   * row — the one thing standing between a workspace that was never moved and losing its copy. Run
   * for real, against stand-in tables in a schema of its own, inside a transaction that is rolled back.
   */
  {
    const sql = readFileSync("prisma/migrations/20260926090000_reference_data_moves_out/migration.sql", "utf8");
    const guard = sql.slice(sql.indexOf("DO $$"), sql.indexOf("END $$;") + "END $$;".length);
    const drops = [...sql.matchAll(/^DROP TABLE "[a-z_]+";$/gm)].map((m) => m[0]);
    const attempt = async (withRow: boolean) => {
      class Rollback extends Error {}
      try {
        await db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`CREATE SCHEMA zz_reference_guard`);
          await tx.$executeRawUnsafe(`SET LOCAL search_path TO zz_reference_guard`);
          for (const t of REFERENCE_TABLES) await tx.$executeRawUnsafe(`CREATE TABLE "${t.table}" (x int)`);
          if (withRow) await tx.$executeRawUnsafe(`INSERT INTO "post_offices" VALUES (1)`);
          await tx.$executeRawUnsafe(guard);
          for (const drop of drops) await tx.$executeRawUnsafe(drop);
          throw new Rollback();
        });
      } catch (err) {
        return err instanceof Rollback ? "ran" : (err as Error).message;
      }
      return "ran";
    };
    const refused = await attempt(true);
    ok("the migration retiring these tables refuses while one still holds a row", /reference:move/.test(refused), refused.split("\n").find((l) => /reference/.test(l))?.trim().slice(0, 120));
    ok("  and goes through once they are empty", (await attempt(false)) === "ran" && drops.length === REFERENCE_TABLES.length);
  }

  section("What is in the database now");

  const dataset = await ref.referenceDataset.findUnique({ where: { key: PIN_DIRECTORY_KEY } });
  const offices = await ref.postOffice.count();
  if (dataset) {
    console.log(
      `  PIN directory: ${offices.toLocaleString("en-IN")} post offices from ${dataset.source}, loaded ${dataset.loadedAt.toISOString().slice(0, 10)}`,
    );
    const unresolved = Object.entries((dataset.unresolvedStates ?? {}) as Record<string, number>);
    if (unresolved.length) console.log(`  state names that did not resolve: ${unresolved.map(([n, c]) => `${n} (${c})`).join(", ")}`);
  } else {
    console.log("  PIN directory: not loaded yet — npm run db:reference (see prisma/reference/README.md)");
  }

  /**
   * The picker stops new bad values; it does not clean up old ones. Reported rather than asserted,
   * because a row typed before today is not a regression and failing on it would make this suite
   * red until somebody edited a customer record.
   */
  const states = await db.companyLocation.groupBy({ by: ["state"], _count: true });
  const bad = states.filter((s) => s.state && stateCodeFromName(s.state) === null);
  console.log(`  ${states.length} distinct states on company addresses`);
  if (bad.length === 0) {
    console.log("  all of them resolve to a GST code");
  } else {
    console.log(`  ${bad.length} do NOT resolve, so their documents are taxed as inter-state:`);
    for (const b of bad) console.log(`    "${b.state}" — ${b._count} location(s)`);
  }
  await db.$disconnect();
  await ref.$disconnect();
}

main()
  .then(() => {
    console.log(failures === 0 ? "\nAll address checks passed." : `\n${failures} failed.`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (error) => {
    console.error(error);
    await db.$disconnect();
  await ref.$disconnect();
    process.exit(1);
  });

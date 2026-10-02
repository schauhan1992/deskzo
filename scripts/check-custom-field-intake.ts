/**
 * check:custom-field-intake — the website lead API and public forms filling the workspace's own fields
 * (owner, 2 Oct 2026): src/lib/custom-fields/outside.ts and outside-server.ts, the lead capture API
 * (src/lib/lead-capture, src/app/api/v1/leads) and the forms (src/lib/marketing/form-fields.ts,
 * src/actions/forms.ts, src/actions/marketing-public.ts).
 *
 * The pure part needs no database: which fields can be filled from outside, each value checked on its
 * own, what a lead says is still to fill in, a question's "save the answer to" and the builder's
 * checks of it, the body a plain HTML form sends, and the documentation.
 *
 * The rest builds a scratch workspace database beside the real one (as check:custom-fields does),
 * drives the real route handler and the real actions as a workspace pointed at it, and drops it at
 * the end, pass or fail:
 *
 *   · the API: a new lead, company and contact with their own fields; a company or contact already on
 *     file left as it was, what was sent for it noted on the lead; a required field not stopping the
 *     lead and named as still to fill in; restricted, person, retired and unknown keys set aside with
 *     one answer for all; an option that isn't one, a word where a number goes, set aside without
 *     costing the lead; a plain HTML form's custom_fields[key]; a malformed custom_fields refused as
 *     any malformed field is; a retry and a reseller's customer writing nothing;
 *   · Settings → Lead capture: the fields a website can fill, with their keys, values and options;
 *   · forms: the fields the builder offers; saveForm checking every link again; the public page asking
 *     a linked question as its field now is; answers saved to the lead, and to a company and contact
 *     only when the answer creates them; an answer a field can't take refused in the question's
 *     words; a field retired since leaving its question a plain one; an invitation writing to the
 *     lead only;
 *   · and the real workspace untouched.
 *
 *   npm run check:custom-field-intake
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import type { PrismaClient } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";
import type { CustomFieldDef } from "../src/lib/custom-fields/rules";
import {
  NOT_FILLABLE,
  applyOutsideInput,
  outsideDefs,
  stillToFill,
  stillToFillLines,
} from "../src/lib/custom-fields/outside";
import {
  QUESTION_TYPE_FOR,
  checkFieldsForSave,
  joinPicks,
  linkQuestions,
  linkedAnswers,
  parseFields,
  readSaveTo,
  savedToLead,
  summariseAnswers,
  targetFor,
  type FieldTarget,
} from "../src/lib/marketing/form-fields";
import { LEAD_FIELDS, ownFieldDoc, renderMarkdown } from "../src/lib/lead-capture/spec";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const errorOf = (r: { ok: boolean; error?: string }) => (r.ok ? "ok" : r.error);
/** Two JSON values with the same content, whatever order Postgres keeps an object's keys in. */
const sameJson = (a: unknown, b: unknown) => {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => x.localeCompare(y)).map(([k, x]) => [k, sorted(x)])) : v;
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
};

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

const TAG = "ZZINTAKE";

// ── Who the actions think is calling ────────────────────────────────────────────────────────────

let actor: { id: string; name: string; email: string; role: string } | null = null;

const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
class UnauthorizedError extends Error {}
const session = {
  requireUser: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => null,
  UnauthorizedError,
};
const navigation = {
  notFound: () => {
    throw new Error("NOT_FOUND_CALLED");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT_CALLED ${to}`);
  },
  permanentRedirect: (to: string) => {
    throw new Error(`REDIRECT_CALLED ${to}`);
  },
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => "/settings/lead-capture",
  useSearchParams: () => new URLSearchParams(),
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
// Never a real email.
const email = { sendEmailNotification: async () => {} };
const viewMode = { getViewMode: async () => "list" as const, setViewMode: async () => {} };
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["next/navigation", navigation],
  ["@/lib/session", session],
  ["@/lib/email", email],
  ["@/actions/view-mode", viewMode],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("next/navigation"), navigation],
  [load.resolve("../src/lib/session"), session],
  [load.resolve("../src/lib/email"), email],
  [load.resolve("../src/actions/view-mode"), viewMode],
]);
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (byName.has(request)) return byName.get(request);
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved !== null && byFile.has(resolved)) return byFile.get(resolved);
  return realLoad.call(this, request, parent, isMain);
};

/** Awaits every async server component in a tree, so a static render can take it. */
async function resolveAsync(node: unknown): Promise<unknown> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveAsync));
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<{ children?: unknown }>;
  if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") {
    return resolveAsync(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
  }
  if (el.props && "children" in el.props) {
    const kids = await resolveAsync(el.props.children);
    return Array.isArray(kids) ? cloneElement(el, undefined, ...(kids as ReactNode[])) : cloneElement(el, undefined, kids as ReactNode);
  }
  return el;
}
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");

// ── The pure part ───────────────────────────────────────────────────────────────────────────────

const def = (over: Partial<CustomFieldDef> & Pick<CustomFieldDef, "key" | "type">): CustomFieldDef => ({
  label: over.key,
  options: [],
  required: false,
  helpText: null,
  group: null,
  restricted: false,
  archived: false,
  ...over,
});

/** A question as the builder sends it. */
const question = (key: string, type: string, extra: Record<string, unknown> = {}) => ({
  key,
  label: key,
  type,
  required: false,
  options: [] as string[],
  placeholder: null,
  help: null,
  ...extra,
});
const NAME_AND_EMAIL = [question("name", "TEXT", { required: true }), question("email", "EMAIL", { required: true })];

function pure() {
  const defs: CustomFieldDef[] = [
    def({ key: "tower", type: "TEXT", label: "Tower", required: true }),
    def({ key: "floor", type: "NUMBER", label: "Floor" }),
    def({
      key: "band",
      type: "SELECT",
      label: "Budget band",
      options: [
        { value: "low", label: "Under 5 lakh" },
        { value: "high", label: "5 to 25 lakh" },
        { value: "old", label: "Old band", archived: true },
      ],
    }),
    def({ key: "regions", type: "MULTI_SELECT", label: "Regions", options: [{ value: "north", label: "North" }, { value: "south", label: "South" }] }),
    def({ key: "demo", type: "CHECKBOX", label: "Demo wanted" }),
    def({ key: "score", type: "TEXT", label: "Internal score", restricted: true, required: true }),
    def({ key: "manager", type: "USER", label: "Account manager", required: true }),
    def({ key: "legacy", type: "TEXT", label: "Legacy code", archived: true }),
  ];

  section("Which fields can be filled from outside");
  ok("everything but a retired field, a restricted one and a person field", outsideDefs(defs).map((d) => d.key).join(",") === "tower,floor,band,regions,demo");

  section("Each value checked on its own");
  const applied = applyOutsideInput(defs, {
    tower: "B",
    floor: "1,250",
    band: "5 TO 25 LAKH",
    regions: "North; south",
    demo: "yes",
    score: "9",
    manager: "abcdefgh12",
    legacy: "L-1",
    nosuch: "x",
    empty: "",
    blank: "  ",
  });
  ok(
    "usable values stored as their fields store them: a number, an option's value, a list, yes",
    sameJson(applied.values, { tower: "B", floor: 1250, band: "high", regions: ["north", "south"], demo: true }),
    JSON.stringify(applied.values),
  );
  const asideKeys = applied.skipped.map((s) => s.key).sort().join(",");
  ok("  a restricted, a person, a retired and an unknown key set aside; empty values passed over", asideKeys === "legacy,manager,nosuch,score", asideKeys);
  ok(
    "  all four with the one answer, saying nothing about which is which",
    applied.skipped.every((s) => s.reason === NOT_FILLABLE && s.label === undefined && s.value === undefined),
    JSON.stringify(applied.skipped),
  );
  const bad = applyOutsideInput(defs, { band: "Platinum", floor: "twelve", tower: "C", regions: ["North", "West"] });
  const reasonFor = (key: string) => bad.skipped.find((s) => s.key === key);
  ok(
    "an option that isn't one, a word for a number, a pick that isn't offered: set aside with the reason, the rest kept",
    sameJson(bad.values, { tower: "C" }) &&
      reasonFor("band")?.reason.includes("Platinum") === true &&
      reasonFor("floor")?.reason === "Floor should be a number." &&
      reasonFor("floor")?.value === "twelve" &&
      reasonFor("regions")?.reason.includes("West") === true,
    JSON.stringify(bad.skipped),
  );
  ok("  a retired option can't be chosen from outside", applyOutsideInput(defs, { band: "old" }).values.band === undefined);
  ok("  and nothing at all from something that isn't an object", Object.keys(applyOutsideInput(defs, "tower=B").values).length === 0 && applyOutsideInput(defs, ["tower"]).skipped.length === 0);

  section("Still to fill in");
  ok("the required fields left empty, by label — a restricted one never named", stillToFill(defs, { floor: 2 }).join(",") === "Tower,Account manager", stillToFill(defs, { floor: 2 }).join(","));
  ok(
    "  a line for each record that has some",
    JSON.stringify(stillToFillLines({ LEAD: ["Tower", "Floor"], COMPANY: ["Region"], CONTACT: [] })) ===
      JSON.stringify(["Still to fill in: Tower, Floor", "Still to fill in on the company: Region"]),
  );

  section("A question that saves its answer to a field");
  const mapping = Object.entries(QUESTION_TYPE_FOR).map(([k, v]) => `${k}=${v}`).join(" ");
  ok(
    "each kind of field is asked as the brief says; a person field not at all",
    mapping ===
      "TEXT=TEXT LONG_TEXT=TEXTAREA NUMBER=NUMBER MONEY=NUMBER DATE=DATE SELECT=SELECT MULTI_SELECT=MULTISELECT CHECKBOX=CHECKBOX EMAIL=EMAIL PHONE=PHONE URL=TEXT USER=null",
    mapping,
  );
  ok(
    "a question is required as its field is — but a yes-or-no isn't, or only a tick would do",
    targetFor("LEAD", defs[0]!)?.required === true &&
      targetFor("LEAD", def({ key: "gst", type: "CHECKBOX", label: "GST registered", required: true }))?.required === false &&
      targetFor("LEAD", defs[6]!) === null,
  );
  ok(
    "a link is a lead, company or contact field by its key — nothing else reads as one",
    readSaveTo({ entity: "LEAD", key: "tower" })?.key === "tower" && readSaveTo({ entity: "ORDER", key: "x" }) === null && readSaveTo({ entity: "LEAD", key: "Bad Key" }) === null && readSaveTo("LEAD:tower") === null,
  );
  const linked = (key: string, type: string, entity: string, field: string, extra: Record<string, unknown> = {}) =>
    question(key, type, { saveTo: { entity, key: field }, ...extra });
  const good = checkFieldsForSave([...NAME_AND_EMAIL, linked("which", "TEXT", "LEAD", "tower"), linked("bandQ", "SELECT", "LEAD", "band", { options: ["Only one"] })]);
  ok("questions saved to fields pass the builder's check — a field's choice of one included", good.ok, good.ok ? "" : good.error);
  ok("  and read back unchanged", good.ok && JSON.stringify(parseFields(good.fields)) === JSON.stringify(good.fields));
  const refusal = (fields: unknown[]) => {
    const r = checkFieldsForSave(fields);
    return r.ok ? null : r.error;
  };
  const onCompany = refusal([...NAME_AND_EMAIL, linked("companyName", "TEXT", "COMPANY", "industry")]);
  ok("not the company question — it fills in the company already", onCompany !== null && onCompany.includes("company"), onCompany);
  const onEmail = refusal([question("name", "TEXT"), linked("email", "EMAIL", "CONTACT", "alt")]);
  const onPhone = refusal([...NAME_AND_EMAIL, linked("phone", "PHONE", "CONTACT", "alt")]);
  ok("  nor the email or phone question — they fill in the contact", !!onEmail?.includes("contact") && !!onPhone?.includes("contact"), `${onEmail} / ${onPhone}`);
  ok("  nor a heading", refusal([...NAME_AND_EMAIL, { key: "about", type: "HEADING", label: "About you", saveTo: { entity: "LEAD", key: "tower" } }]) !== null);
  const twice = refusal([...NAME_AND_EMAIL, linked("a", "TEXT", "LEAD", "tower"), linked("b", "TEXT", "LEAD", "tower")]);
  ok("  nor two questions to one field", twice !== null && twice.includes("same field"), twice);
  ok("  nor something that isn't a field", refusal([...NAME_AND_EMAIL, linked("a", "TEXT", "ORDER", "tower")]) !== null);
  ok("a choice typed in still needs two options", refusal([...NAME_AND_EMAIL, question("pick", "SELECT", { options: ["Only one"] })]) !== null);
  const tolerant = parseFields([...NAME_AND_EMAIL, linked("companyName", "TEXT", "COMPANY", "industry"), linked("a", "TEXT", "LEAD", "tower"), linked("b", "TEXT", "LEAD", "tower")]);
  const by = (fields: { key: string; saveTo?: unknown }[], key: string) => fields.find((f) => f.key === key);
  ok(
    "the reader drops what the check would refuse: a link on the company question, a second link to one field",
    !by(tolerant, "companyName")?.saveTo && !!by(tolerant, "a")?.saveTo && !by(tolerant, "b")?.saveTo,
  );

  const records = { LEAD: defs, COMPANY: [], CONTACT: [def({ key: "alt", type: "PHONE", label: "Alternate phone" })] };
  const asked = linkQuestions(
    parseFields([
      ...NAME_AND_EMAIL,
      linked("bandQ", "TEXT", "LEAD", "band"),
      linked("legacyQ", "TEXT", "LEAD", "legacy"),
      linked("scoreQ", "TEXT", "LEAD", "score"),
      linked("managerQ", "TEXT", "LEAD", "manager"),
      linked("goneQ", "TEXT", "LEAD", "gone"),
    ]),
    records,
  );
  const bandQ = asked.find((f) => f.key === "bandQ");
  ok(
    "a linked question is asked as its field is today: a dropdown of the options on offer",
    bandQ?.type === "SELECT" && JSON.stringify(bandQ.options) === JSON.stringify(["Under 5 lakh", "5 to 25 lakh"]) && !!bandQ.saveTo,
    JSON.stringify(bandQ),
  );
  ok(
    "  one whose field is retired, restricted, a person or gone is a plain question",
    ["legacyQ", "scoreQ", "managerQ", "goneQ"].every((k) => {
      const f = asked.find((x) => x.key === k);
      return !!f && !f.saveTo && f.type === "TEXT";
    }),
  );

  const form = linkQuestions(
    parseFields([
      ...NAME_AND_EMAIL,
      linked("which", "TEXT", "LEAD", "tower"),
      linked("regionsQ", "MULTISELECT", "LEAD", "regions", { options: ["North", "South"] }),
      linked("demoQ", "CHECKBOX", "LEAD", "demo"),
      { ...linked("mobile", "PHONE", "CONTACT", "alt"), label: "Your mobile" },
      question("notes", "TEXTAREA", { label: "Anything else" }),
    ]),
    records,
  );
  const answers = { name: "Asha", email: "asha@acme.example", which: "B", regionsQ: joinPicks(["North", "South"]), demoQ: "yes", mobile: "+91 98765 43210", notes: "Call after 5" };
  const saved = linkedAnswers(form, answers, records);
  ok(
    "answers as their fields store them: picks as a list, a tick as yes, on the record each field is on",
    sameJson(saved.values, { LEAD: { tower: "B", regions: ["north", "south"], demo: true }, COMPANY: {}, CONTACT: { alt: "+91 98765 43210" } }) &&
      Object.keys(saved.errors).length === 0,
    JSON.stringify(saved),
  );
  const wrongPhone = linkedAnswers(form, { ...answers, mobile: "call me" }, records);
  ok("an answer its field can't take is refused in the question's own words", wrongPhone.errors.mobile === "Your mobile should be a phone number.", JSON.stringify(wrongPhone.errors));
  const summary = summariseAnswers(form, answers, { except: savedToLead(form, saved.values.LEAD) });
  ok(
    "the lead's description leaves out what went into its own fields, and keeps the rest",
    !summary.includes("which:") && !summary.includes("regionsQ:") && summary.includes("Your mobile: +91 98765 43210") && summary.includes("Anything else: Call after 5"),
    summary,
  );

  section("The lead capture API's documentation");
  ok(
    "custom_fields, company_fields and contact_fields are documented",
    ["custom_fields", "company_fields", "contact_fields"].every((name) => LEAD_FIELDS.some((f) => f.name === name)),
  );
  const md = renderMarkdown("https://crm.example.com", [
    { name: "custom_fields", record: "the lead", fields: [ownFieldDoc(defs[2]!), ownFieldDoc(defs[0]!)] },
    { name: "company_fields", record: "the company, when the enquiry creates it", fields: [] },
    { name: "contact_fields", record: "the contact, when the enquiry creates it", fields: [] },
  ]);
  ok(
    "the download lists the workspace's own fields: each key, the value it takes, its options by value and label",
    md.includes("| `band` | Budget band |") && md.includes("`high` (5 to 25 lakh)") && md.includes("one option, by its value or its label") && md.includes("| `tower` | Tower (required in the CRM) |"),
  );
  ok("  never a retired option", !md.includes("Old band"));
  ok("  and how a form sends them, and what not_saved is", md.includes("custom_fields[tower]") && md.includes('"not_saved"') && md.includes("custom_fields.floor"));
}

// ── The scratch database ────────────────────────────────────────────────────────────────────────

/** The intake's own pure parts — required, not imported, because the module also reaches the database. */
function intakeRules() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { readFormBody, ACCEPTED_FIELDS } = require("../src/lib/lead-capture/intake") as typeof import("../src/lib/lead-capture/intake");
  /* eslint-enable @typescript-eslint/no-require-imports */
  section("The API's validator");
  const documented = LEAD_FIELDS.map((f) => f.name).sort();
  const accepted = [...ACCEPTED_FIELDS].sort();
  ok("the documentation is still the validator, field for field", JSON.stringify(documented) === JSON.stringify(accepted), `${accepted.length} fields`);

  section("A plain HTML form's body");
  const body = readFormBody(
    "name=Asha&custom_fields%5Btower%5D=B&custom_fields[regions][]=north&custom_fields[regions][]=south&company_fields%5Bindustry%5D=pharma&contact_fields[birthday]=1990-05-01&contact_fields[birthday]=1990-05-02&products=SKU-1,%20SKU-2&name=Asha%20R",
  );
  ok(
    "custom_fields[key] read into objects; [] and a name sent twice are lists; products split; a later plain value wins",
    sameJson(body, {
      name: "Asha R",
      products: ["SKU-1", "SKU-2"],
      custom_fields: { tower: "B", regions: ["north", "south"] },
      company_fields: { industry: "pharma" },
      contact_fields: { birthday: ["1990-05-01", "1990-05-02"] },
    }),
    JSON.stringify(body),
  );
}

async function main() {
  pure();

  const realUrl = process.env.DATABASE_URL;
  if (!realUrl) throw new Error("DATABASE_URL is not set.");
  const host = new URL(realUrl).hostname;
  const realName = new URL(realUrl).pathname.slice(1);

  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratchName = `${realName}_cfintake`;
  const scratchUrl = withDatabase(realUrl, scratchName);
  ok("  and it is not the real one", scratchName !== realName, scratchName);

  const real = directClient(realUrl, { max: 1 });
  const realBefore = await snapshot(real);

  const admin = directClient(withDatabase(realUrl, "postgres"), { max: 1 });
  let closeAll: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
    const started = Date.now();
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60 * 1000 });
    ok("built from the migrations", true, `${Math.round((Date.now() - started) / 1000)} s`);

    process.env.DATABASE_URL = scratchUrl;
    process.env.CONTROL_DATABASE_URL = "";

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    closeAll = () => db.$disconnect();
    /* eslint-enable @typescript-eslint/no-require-imports */
    intakeRules();
    await run(scratchUrl);
  } finally {
    await closeAll?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`).catch(() => {});
    const gone = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratchName}'`);
    ok("the scratch database is dropped", Number(gone[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  section("The real workspace was not touched");
  const realAfter = await snapshot(real);
  await real.$disconnect();
  ok("its field definitions, API keys and forms are as they were", realAfter.counts === realBefore.counts, realAfter.counts);
  ok("  and nothing of this suite's is in it — no company, lead, key, form or person", realAfter.tagged === 0 && realBefore.tagged === 0, realAfter.tagged);

  console.log(failures === 0 ? `\nAll ${passes} custom-field intake checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/**
 * What the suite must never change in the real workspace. Read-only. Companies and leads are found by
 * this suite's names rather than counted: other suites may be adding and removing their own meanwhile.
 */
async function snapshot(client: PrismaClient) {
  const [definitions, keys, forms, ...tagged] = await Promise.all([
    client.customFieldDefinition.count(),
    client.leadCaptureKey.count(),
    client.inboundForm.count(),
    client.company.count({ where: { name: { startsWith: TAG } } }),
    client.lead.count({ where: { title: { contains: TAG } } }),
    client.leadCaptureKey.count({ where: { name: { startsWith: TAG } } }),
    client.inboundForm.count({ where: { name: { startsWith: TAG } } }),
    client.user.count({ where: { email: { startsWith: "zzintake-" } } }),
  ]);
  return { counts: JSON.stringify({ definitions, keys, forms }), tagged: tagged.reduce((a, b) => a + b, 0) };
}

// ── The suite ───────────────────────────────────────────────────────────────────────────────────

async function run(scratchUrl: string) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
  const settings = require("../src/actions/custom-fields") as typeof import("../src/actions/custom-fields");
  const keys = require("../src/actions/lead-capture") as typeof import("../src/actions/lead-capture");
  const route = require("../src/app/api/v1/leads/route") as typeof import("../src/app/api/v1/leads/route");
  const forms = require("../src/actions/forms") as typeof import("../src/actions/forms");
  const publicForms = require("../src/actions/marketing-public") as typeof import("../src/actions/marketing-public");
  const { FormBuilder } = require("../src/components/forms/form-builder") as typeof import("../src/components/forms/form-builder");
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  const LeadCapturePage = (require("../src/app/(dashboard)/settings/lead-capture/page") as { default: () => Promise<ReactElement> }).default;
  /* eslint-enable @typescript-eslint/no-require-imports */

  const tenant = {
    id: randomUUID(),
    slug: "zzcfintake",
    name: "zzcfintake",
    status: "ACTIVE" as const,
    dbUrl: scratchUrl,
    primaryHost: "zzcfintake.localhost",
    hosts: ["zzcfintake.localhost"],
    source: "env" as const,
    isDefault: false,
    keyBundleCipher: null,
    country: "IN",
    entitlements: { v: 1 as const, all: true, modules: [], seats: null, copilotTokens: null, customDomains: null, plans: [] },
    holdReason: null,
  };

  await runAsTenant(tenant, async () => {
    // ── Fixture ────────────────────────────────────────────────────────────────────────────────
    section("Fixture");
    const owner = await db.user.create({
      data: { name: `${TAG} Owner`, email: "zzintake-owner@example.test", passwordHash: "!", role: "ADMIN", isSuperAdmin: true },
      select: { id: true, name: true, email: true, role: true },
    });
    actor = owner;

    const field = (over: Record<string, unknown>) => ({
      entity: "LEAD",
      label: "",
      type: "TEXT",
      options: [],
      required: false,
      helpText: "",
      group: "",
      restricted: false,
      showInList: false,
      ...over,
    });
    const idOf = (r: { ok: boolean; data?: unknown; error?: string }) => {
      if (!r.ok) throw new Error(`refused: ${r.error}`);
      return (r.data as { id: string }).id;
    };
    const add = async (over: Record<string, unknown>) => idOf(await settings.saveCustomFieldDefinition(field(over)));
    await add({ label: "Tower", required: true });
    const floorId = await add({ label: "Floor", type: "NUMBER" });
    const bandId = await add({ label: "Budget band", type: "SELECT", options: [{ label: "Under 5 lakh" }, { label: "5 to 25 lakh" }] });
    await add({ label: "Regions", type: "MULTI_SELECT", options: [{ label: "North" }, { label: "South" }, { label: "East" }] });
    await add({ label: "Demo wanted", type: "CHECKBOX" });
    await add({ label: "Internal score", restricted: true });
    await add({ label: "Account manager", type: "USER", required: true });
    const legacyId = await add({ label: "Legacy code" });
    await settings.archiveCustomFieldDefinition(legacyId);
    await add({ entity: "COMPANY", label: "Industry", type: "SELECT", options: [{ label: "Pharma" }, { label: "Retail" }] });
    await add({ entity: "COMPANY", label: "Region", type: "SELECT", options: [{ label: "North" }, { label: "South" }], required: true });
    await add({ entity: "COMPANY", label: "Internal rating", restricted: true });
    await add({ entity: "CONTACT", label: "Alternate phone", type: "PHONE" });
    await add({ entity: "CONTACT", label: "Birthday", type: "DATE" });
    const stored = await db.customFieldDefinition.findMany({ orderBy: [{ entity: "asc" }, { sortOrder: "asc" }], select: { entity: true, key: true, archivedAt: true } });
    const listed = stored.map((d) => `${d.entity}:${d.key}${d.archivedAt ? "(retired)" : ""}`).join(" ");
    ok(
      "lead, company and contact fields — a restricted one, a person one and a retired one among them",
      listed ===
        "COMPANY:industry COMPANY:region COMPANY:internal_rating CONTACT:alternate_phone CONTACT:birthday LEAD:tower LEAD:floor LEAD:budget_band LEAD:regions LEAD:demo_wanted LEAD:internal_score LEAD:account_manager LEAD:legacy_code(retired)",
      listed,
    );

    // ── The API ────────────────────────────────────────────────────────────────────────────────
    section("The API: a new lead, company and contact with their own fields");
    const made = await keys.createCaptureKey({ name: `${TAG} site`, sourceLabel: "zzintake.example" });
    if (!made.ok) throw new Error(made.error);
    const auth = `Basic ${Buffer.from(`${made.data.keyId}:${made.data.secret}`).toString("base64")}`;
    const URL_ = "http://zzcfintake.localhost/api/v1/leads";
    const post = (payload: string, type = "application/json") =>
      route.POST(new Request(URL_, { method: "POST", headers: { authorization: auth, "content-type": type }, body: payload }));
    const postJson = (payload: Record<string, unknown>) => post(JSON.stringify(payload));
    type Answer = { ok: boolean; lead?: { id: string }; not_saved?: { field: string; reason: string }[]; fields?: Record<string, string>; duplicate?: boolean };
    const leadOf = (id: string) =>
      db.lead.findUniqueOrThrow({
        where: { id },
        select: {
          description: true,
          customFields: true,
          companyId: true,
          contactId: true,
          company: { select: { customFields: true } },
          contact: { select: { customFields: true } },
        },
      });

    const first = await postJson({
      name: "Zz Priya",
      email: "priya@zzintake-acme.example",
      company: `${TAG} Acme`,
      state: "Maharashtra",
      custom_fields: { tower: "B", floor: "3", budget_band: "5 to 25 lakh", regions: "North; south", demo_wanted: "yes" },
      company_fields: { industry: "Pharma", region: "north" },
      contact_fields: { alternate_phone: "+91 98765 43210", birthday: "1990-05-01" },
      external_id: "zz-1",
    });
    const firstBody = (await first.json()) as Answer;
    ok("201, and not_saved there and empty", first.status === 201 && Array.isArray(firstBody.not_saved) && firstBody.not_saved.length === 0, `${first.status} ${JSON.stringify(firstBody)}`);
    const l1 = await leadOf(firstBody.lead!.id);
    ok(
      "  the lead's own fields, stored as the fields store them",
      sameJson(l1.customFields, { tower: "B", floor: 3, budget_band: "f_5_to_25_lakh", regions: ["north", "south"], demo_wanted: true }),
      JSON.stringify(l1.customFields),
    );
    ok("  the new company's", sameJson(l1.company.customFields, { industry: "pharma", region: "north" }), JSON.stringify(l1.company.customFields));
    ok("  the new contact's", sameJson(l1.contact?.customFields, { alternate_phone: "+91 98765 43210", birthday: "1990-05-01" }), JSON.stringify(l1.contact?.customFields));
    ok(
      "  and the lead says what is still to fill in — the person field, which a website can't",
      /Still to fill in: Account manager/.test(l1.description ?? "") && !/Tower/.test(l1.description ?? ""),
      l1.description,
    );

    section("The API: a company or contact already on file is left as it was");
    const second = await postJson({
      name: "Zz Ravi",
      email: "ravi@zzintake-acme.example",
      company: `${TAG} Acme`,
      custom_fields: { tower: "A" },
      company_fields: { industry: "Retail", region: "south" },
      contact_fields: { birthday: "1985-07-07" },
      external_id: "zz-2",
    });
    const l2 = await leadOf(((await second.json()) as Answer).lead!.id);
    ok(
      "the company the enquiry matched keeps its own values",
      second.status === 201 && l2.companyId === l1.companyId && sameJson(l2.company.customFields, { industry: "pharma", region: "north" }),
      JSON.stringify(l2.company.customFields),
    );
    ok(
      "  what was sent for it is noted on the lead instead",
      /already on file/.test(l2.description ?? "") && (l2.description ?? "").includes("Industry: Retail") && (l2.description ?? "").includes("Region: South"),
      l2.description,
    );
    ok("  the new contact there takes its own", l2.contactId !== l1.contactId && sameJson(l2.contact?.customFields, { birthday: "1985-07-07" }), JSON.stringify(l2.contact?.customFields));
    const third = await postJson({ name: "Zz Priya", email: "priya@zzintake-acme.example", company: `${TAG} Acme`, custom_fields: { tower: "A" }, contact_fields: { birthday: "2000-01-01" }, external_id: "zz-3" });
    const l3 = await leadOf(((await third.json()) as Answer).lead!.id);
    ok(
      "a contact matched by email keeps hers too, and the lead notes what was sent",
      l3.contactId === l1.contactId && sameJson(l3.contact?.customFields, { alternate_phone: "+91 98765 43210", birthday: "1990-05-01" }) && (l3.description ?? "").includes("Sent for the contact"),
      `${JSON.stringify(l3.contact?.customFields)} ${l3.description}`,
    );

    section("The API: required fields don't stop a lead");
    const bare = await postJson({ name: "Zz Meera", email: "meera@zzintake-north.example", company: `${TAG} Northwind`, external_id: "zz-4" });
    const l4 = await leadOf(((await bare.json()) as Answer).lead!.id);
    ok(
      "made without any, and the lead says what is still to fill in — on the new company too",
      bare.status === 201 && (l4.description ?? "").includes("Still to fill in: Tower, Account manager") && (l4.description ?? "").includes("Still to fill in on the company: Region"),
      l4.description,
    );
    ok("  with nothing to write, nothing written", sameJson(l4.customFields, {}) && sameJson(l4.company.customFields, {}) && sameJson(l4.contact?.customFields, {}));

    section("The API: keys a website can't fill are set aside, all alike");
    const odd = await postJson({
      name: "Zz Odd",
      email: "odd@zzintake-odd.example",
      company: `${TAG} Oddco`,
      custom_fields: { tower: "Q", internal_score: "97", account_manager: owner.id, legacy_code: "L-1", no_such_field: "x" },
      company_fields: { internal_rating: "A", region: "north" },
      external_id: "zz-5",
    });
    const oddBody = (await odd.json()) as Answer;
    const aside = (oddBody.not_saved ?? []).map((n) => n.field).sort();
    ok(
      "the lead is made; restricted, person, retired and unknown keys come back in not_saved",
      odd.status === 201 &&
        JSON.stringify(aside) ===
          JSON.stringify(["company_fields.internal_rating", "custom_fields.account_manager", "custom_fields.internal_score", "custom_fields.legacy_code", "custom_fields.no_such_field"]),
      JSON.stringify(oddBody.not_saved),
    );
    ok(
      "  every one with the same reason, so the answer never says a restricted field exists",
      new Set((oddBody.not_saved ?? []).map((n) => n.reason)).size === 1 && oddBody.not_saved?.[0]?.reason === NOT_FILLABLE,
    );
    const l5 = await leadOf(oddBody.lead!.id);
    ok("  none of them stored", sameJson(l5.customFields, { tower: "Q" }) && sameJson(l5.company.customFields, { region: "north" }), `${JSON.stringify(l5.customFields)} ${JSON.stringify(l5.company.customFields)}`);
    ok(
      "  each one noted on the lead by its key — and not a value sent for one",
      aside.every((f) => (l5.description ?? "").includes(f)) && !(l5.description ?? "").includes("97") && !(l5.description ?? "").includes(owner.id),
      l5.description,
    );

    section("The API: a value its field can't take never costs the lead");
    const wrong = await postJson({
      name: "Zz Wrong",
      email: "wrong@zzintake-wrong.example",
      company: `${TAG} Wrongco`,
      custom_fields: { tower: "C", budget_band: "Platinum", floor: "twelve" },
      company_fields: { region: "South" },
      contact_fields: { birthday: "31/02/1990" },
      external_id: "zz-6",
    });
    const wrongBody = (await wrong.json()) as Answer;
    const why = (f: string) => wrongBody.not_saved?.find((n) => n.field === f)?.reason ?? "";
    ok(
      "201, with an option that isn't one, a word for a number and a date that isn't one in not_saved, each saying why",
      wrong.status === 201 && why("custom_fields.budget_band").includes("Platinum") && why("custom_fields.floor") === "Floor should be a number." && why("contact_fields.birthday") === "Birthday should be a date.",
      JSON.stringify(wrongBody.not_saved),
    );
    const l6 = await leadOf(wrongBody.lead!.id);
    ok("  what could be used is", sameJson(l6.customFields, { tower: "C" }) && sameJson(l6.company.customFields, { region: "south" }) && sameJson(l6.contact?.customFields, {}));
    ok(
      "  and the lead says what wasn't, with what was sent",
      (l6.description ?? "").includes("“Platinum” isn't one of the options for Budget band") &&
        (l6.description ?? "").includes("Floor should be a number. It was “twelve”.") &&
        (l6.description ?? "").includes("For the contact: Birthday should be a date. It was “31/02/1990”."),
      l6.description,
    );

    section("The API: a plain HTML form, and a malformed request");
    const form = await post(
      new URLSearchParams([
        ["name", "Zz Form"],
        ["email", "form@zzintake-form.example"],
        ["company", `${TAG} Formco`],
        ["custom_fields[tower]", "D"],
        ["custom_fields[regions][]", "north"],
        ["custom_fields[regions][]", "east"],
        ["company_fields[industry]", "retail"],
        ["company_fields[region]", "South"],
        ["contact_fields[birthday]", "1980-01-31"],
        ["external_id", "zz-7"],
      ]).toString(),
      "application/x-www-form-urlencoded",
    );
    const formBody = (await form.json()) as Answer;
    const l7 = form.status === 201 ? await leadOf(formBody.lead!.id) : null;
    ok(
      "custom_fields[tower]=D from a form: the lead, the new company and contact all take theirs",
      !!l7 &&
        sameJson(l7.customFields, { tower: "D", regions: ["north", "east"] }) &&
        sameJson(l7.company.customFields, { industry: "retail", region: "south" }) &&
        sameJson(l7.contact?.customFields, { birthday: "1980-01-31" }),
      `${form.status} ${JSON.stringify(formBody)} ${JSON.stringify(l7?.customFields)}`,
    );
    const leadsBefore = await db.lead.count();
    const notObject = await postJson({ name: "Zz Bad", email: "bad@zzintake-bad.example", custom_fields: "tower=B" });
    const notObjectBody = (await notObject.json()) as Answer;
    ok("custom_fields that isn't an object is a 400 naming it, as any malformed field is", notObject.status === 400 && !!notObjectBody.fields?.custom_fields, JSON.stringify(notObjectBody));
    const tooMany = await postJson({ name: "Zz Bad", email: "bad@zzintake-bad.example", company_fields: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`f${i}`, "x"])) });
    ok("  and so is one naming more fields than a record can have", tooMany.status === 400 && (await db.lead.count()) === leadsBefore, tooMany.status);

    section("The API: a retry, and a reseller's customer");
    const retry = await postJson({ name: "Zz Priya", email: "priya@zzintake-acme.example", company: `${TAG} Acme`, custom_fields: { tower: "Z" }, external_id: "zz-1" });
    const retryBody = (await retry.json()) as Answer;
    ok(
      "the same external_id again answers with the first lead and writes nothing",
      retry.status === 200 && retryBody.duplicate === true && retryBody.lead?.id === firstBody.lead!.id && (await leadOf(firstBody.lead!.id)).customFields !== null && sameJson((await leadOf(firstBody.lead!.id)).customFields, l1.customFields),
    );
    const reseller = await db.company.create({
      data: { name: `${TAG} Channel`, normalizedName: `${TAG} channel`.toLowerCase(), relationshipType: "RESELLER", createdById: owner.id, ownerUserId: owner.id },
      select: { id: true },
    });
    const endCustomer = await db.company.create({
      data: { name: `${TAG} EndCustomer`, normalizedName: `${TAG} endcustomer`.toLowerCase(), createdById: owner.id, managedByResellerId: reseller.id },
      select: { id: true },
    });
    const routed = await postJson({ name: "Zz End", email: "end@zzintake-end.example", company: `${TAG} EndCustomer`, company_fields: { industry: "Retail" }, external_id: "zz-8" });
    const endNow = await db.company.findUniqueOrThrow({ where: { id: endCustomer.id }, select: { customFields: true } });
    ok("a reseller's customer: 202, and nothing written to the company", routed.status === 202 && sameJson(endNow.customFields, {}), `${routed.status} ${JSON.stringify(endNow.customFields)}`);

    // ── Settings ───────────────────────────────────────────────────────────────────────────────
    section("Settings → Lead capture: the fields a website can fill");
    const guide = await keys.captureFieldGuide();
    const keysIn = (name: string) => guide.find((g) => g.name === name)?.fields.map((f) => f.key).join(",");
    ok(
      "the lead's, the company's and the contact's, in their order — no restricted, person or retired one",
      keysIn("custom_fields") === "tower,floor,budget_band,regions,demo_wanted" && keysIn("company_fields") === "industry,region" && keysIn("contact_fields") === "alternate_phone,birthday",
      guide.map((g) => `${g.name}: ${g.fields.map((f) => f.key).join(",")}`).join(" | "),
    );
    ok(
      "  each one's options by value and label",
      sameJson(guide.find((g) => g.name === "custom_fields")?.fields.find((f) => f.key === "budget_band")?.options, [
        { value: "under_5_lakh", label: "Under 5 lakh" },
        { value: "f_5_to_25_lakh", label: "5 to 25 lakh" },
      ]),
    );
    const page = textOf(renderToStaticMarkup((await resolveAsync(await LeadCapturePage())) as ReactElement));
    ok(
      "  and the page shows them to a developer: the keys, the value each takes, the options",
      page.includes("Your own fields") && page.includes("budget_band") && page.includes("f_5_to_25_lakh") && page.includes("one option, by its value or its label") && page.includes("alternate_phone"),
    );
    ok("  never a restricted, person or retired one", !page.includes("internal_score") && !page.includes("account_manager") && !page.includes("legacy_code") && !page.includes("internal_rating"));

    // ── Forms ──────────────────────────────────────────────────────────────────────────────────
    section("Forms: the fields a question can save to");
    const targets = await forms.formFieldTargets();
    const tid = (t: { entity: string; key: string }) => `${t.entity}:${t.key}`;
    ok(
      "the builder offers the fields a form can fill",
      targets.map(tid).join(" ") === "LEAD:tower LEAD:floor LEAD:budget_band LEAD:regions LEAD:demo_wanted COMPANY:industry COMPANY:region CONTACT:alternate_phone CONTACT:birthday",
      targets.map(tid).join(" "),
    );
    const target = (id: string): FieldTarget => {
      const found = targets.find((t) => tid(t) === id);
      if (!found) throw new Error(`no target ${id}`);
      return found;
    };
    ok(
      "  each as the question it is asked as: a dropdown of its labels, multiple choice, a tick box, a date, a phone",
      target("LEAD:budget_band").type === "SELECT" &&
        JSON.stringify(target("LEAD:budget_band").options) === JSON.stringify(["Under 5 lakh", "5 to 25 lakh"]) &&
        target("LEAD:regions").type === "MULTISELECT" &&
        target("LEAD:demo_wanted").type === "CHECKBOX" &&
        target("LEAD:floor").type === "NUMBER" &&
        target("CONTACT:birthday").type === "DATE" &&
        target("CONTACT:alternate_phone").type === "PHONE" &&
        target("LEAD:tower").required,
    );

    section("Forms: building one whose answers are saved");
    const ask = (key: string, label: string, to: string, extra: Record<string, unknown> = {}) => {
      const t = target(to);
      return { key, label, type: t.type, required: false, options: t.options, placeholder: null, help: null, saveTo: { entity: t.entity, key: t.key }, ...extra };
    };
    const plain = (key: string, label: string, type: string, required = false) => ({ key, label, type, required, options: [], placeholder: null, help: null });
    const who = [plain("name", "Your name", "TEXT", true), plain("email", "Work email", "EMAIL", true), plain("companyName", "Company", "TEXT")];
    const questions = [
      ...who,
      ask("whichTower", "Which tower?", "LEAD:tower"),
      ask("budget", "Budget", "LEAD:budget_band"),
      ask("whereQ", "Where are you?", "LEAD:regions"),
      ask("demo", "Want a demo?", "LEAD:demo_wanted"),
      ask("floorQ", "Which floor?", "LEAD:floor"),
      ask("industryQ", "Your industry", "COMPANY:industry"),
      ask("mobile", "Your mobile", "CONTACT:alternate_phone"),
      plain("notes", "Anything else", "TEXTAREA"),
    ];
    const SLUG = "zzintake-enquiry";
    const formInput = {
      name: `${TAG} Enquiry`,
      slug: SLUG,
      category: "ENQUIRY",
      fillMode: "BOTH",
      createsLead: true,
      topic: "OFFERS",
      assignToUserId: owner.id,
      fields: questions,
    } as unknown as Parameters<typeof forms.saveForm>[0];
    const saved = await forms.saveForm(formInput);
    ok("a form with questions saved to the lead, the company and the contact saves", saved.ok, errorOf(saved));
    const formId = saved.ok ? saved.data.id : "";
    const other = (fields: unknown[]) => forms.saveForm({ ...formInput, name: `${TAG} Other`, slug: "zzintake-other", fields });
    const restricted = await other([...who, { ...plain("score", "Score", "TEXT"), saveTo: { entity: "LEAD", key: "internal_score" } }]);
    ok("saveForm refuses a question saved to a restricted field", !restricted.ok, errorOf(restricted));
    const person = await other([...who, { ...plain("am", "Your account manager", "TEXT"), saveTo: { entity: "LEAD", key: "account_manager" } }]);
    ok("  to a person field", !person.ok, errorOf(person));
    const retiredLink = await other([...who, { ...plain("lc", "Legacy code", "TEXT"), saveTo: { entity: "LEAD", key: "legacy_code" } }]);
    ok("  to a retired field", !retiredLink.ok, errorOf(retiredLink));
    const wrongType = await other([...who, { ...ask("budget", "Budget", "LEAD:budget_band"), type: "TEXT", options: [] }]);
    ok("  as a question its field isn't asked as", !wrongType.ok && wrongType.error.includes("has to be asked as dropdown"), errorOf(wrongType));
    const companyLinked = await other([plain("name", "Your name", "TEXT", true), plain("email", "Work email", "EMAIL", true), { ...plain("companyName", "Company", "TEXT"), saveTo: { entity: "COMPANY", key: "industry" } }]);
    ok("  on the company question", !companyLinked.ok, errorOf(companyLinked));
    const sameTwice = await other([...who, ask("a", "Tower", "LEAD:tower"), ask("b", "Which tower?", "LEAD:tower")]);
    ok("  and two questions to one field", !sameTwice.ok, errorOf(sameTwice));
    ok("  none of which made a form", (await db.inboundForm.count({ where: { slug: "zzintake-other" } })) === 0);

    section("Forms: the public page");
    const shown = await publicForms.getForm(SLUG);
    const shownQ = (key: string) => shown?.fields.find((f) => f.key === key);
    ok(
      "asks a linked question as its field is, and doesn't say where any answer goes",
      shownQ("budget")?.type === "SELECT" && JSON.stringify(shownQ("budget")?.options) === JSON.stringify(["Under 5 lakh", "5 to 25 lakh"]) && !!shown && shown.fields.every((f) => !("saveTo" in f)),
      JSON.stringify(shownQ("budget")),
    );
    await settings.saveCustomFieldDefinition(
      field({ id: bandId, label: "Budget band", type: "SELECT", options: [{ value: "under_5_lakh", label: "Below 5 lakh" }, { value: "f_5_to_25_lakh", label: "5 to 25 lakh" }] }),
    );
    const renamed = await publicForms.getForm(SLUG);
    ok(
      "  an option renamed in Settings since the form was built is offered as it is now",
      JSON.stringify(renamed?.fields.find((f) => f.key === "budget")?.options) === JSON.stringify(["Below 5 lakh", "5 to 25 lakh"]),
      JSON.stringify(renamed?.fields.find((f) => f.key === "budget")?.options),
    );

    section("Forms: a stranger's answers");
    const answers = {
      name: "Zz Asha",
      email: "asha@zzintake-forms.example",
      companyName: `${TAG} Formhouse`,
      whichTower: "B",
      budget: "Below 5 lakh",
      whereQ: joinPicks(["North", "East"]),
      demo: "yes",
      floorQ: "12",
      industryQ: "Pharma",
      mobile: "+91 90000 11111",
      notes: "Call after 5",
    };
    const submissionOf = (emailAddress: string) =>
      db.formSubmission.findFirstOrThrow({
        where: { formId, email: emailAddress },
        select: {
          payload: true,
          companyId: true,
          contactId: true,
          lead: { select: { customFields: true, description: true } },
          company: { select: { customFields: true } },
          contact: { select: { customFields: true } },
        },
      });
    const sent = await publicForms.submitForm({ slug: SLUG, values: answers, elapsedMs: 5000 });
    ok("thanked", sent.ok, errorOf(sent));
    const s1 = await submissionOf("asha@zzintake-forms.example");
    ok(
      "  the lead's fields from the answers saved to them",
      sameJson(s1.lead?.customFields, { tower: "B", budget_band: "under_5_lakh", regions: ["north", "east"], demo_wanted: true, floor: 12 }),
      JSON.stringify(s1.lead?.customFields),
    );
    ok(
      "  the company and contact the answer created take theirs",
      sameJson(s1.company?.customFields, { industry: "pharma" }) && sameJson(s1.contact?.customFields, { alternate_phone: "+91 90000 11111" }),
      `${JSON.stringify(s1.company?.customFields)} ${JSON.stringify(s1.contact?.customFields)}`,
    );
    const payload = (s1.payload ?? {}) as Record<string, string>;
    ok("  every answer kept on the submission as it was given", payload.budget === "Below 5 lakh" && payload.whereQ === "North\nEast" && payload.mobile === "+91 90000 11111" && payload.floorQ === "12");
    const d1 = s1.lead?.description ?? "";
    ok(
      "  the lead's description: the answers not saved to it, and what is still to fill in",
      d1.includes("Anything else: Call after 5") && d1.includes("Your industry: Pharma") && !d1.includes("Which tower?") && d1.includes("Still to fill in: Account manager") && d1.includes("Still to fill in on the company: Region"),
      d1,
    );

    const again = await publicForms.submitForm({
      slug: SLUG,
      values: { ...answers, name: "Zz Ben", email: "ben@zzintake-forms.example", industryQ: "Retail", mobile: "+91 90000 22222" },
      elapsedMs: 5000,
    });
    const s2 = await submissionOf("ben@zzintake-forms.example");
    ok(
      "a second answer naming the same company leaves the company on file as it was",
      again.ok && s2.companyId === s1.companyId && sameJson(s2.company?.customFields, { industry: "pharma" }) && !(s2.lead?.description ?? "").includes("on the company"),
      `${errorOf(again)} ${JSON.stringify(s2.company?.customFields)}`,
    );
    ok("  the new contact there takes the mobile", s2.contactId !== s1.contactId && sameJson(s2.contact?.customFields, { alternate_phone: "+91 90000 22222" }));

    const badPhone = await publicForms.submitForm({ slug: SLUG, values: { ...answers, email: "carl@zzintake-forms.example", mobile: "call me" }, elapsedMs: 5000 });
    ok(
      "an answer its field can't take is refused in the question's own words — and nothing is made",
      !badPhone.ok && badPhone.error === "Your mobile should be a phone number." && (await db.formSubmission.count({ where: { email: "carl@zzintake-forms.example" } })) === 0,
      errorOf(badPhone),
    );

    section("Forms: a field retired since the form was built");
    await settings.archiveCustomFieldDefinition(floorId);
    const afterRetire = await publicForms.getForm(SLUG);
    ok("its question is still asked, as a plain one", afterRetire?.fields.find((f) => f.key === "floorQ")?.type === "NUMBER");
    const late = await publicForms.submitForm({ slug: SLUG, values: { ...answers, email: "dev@zzintake-forms.example", floorQ: "7" }, elapsedMs: 5000 });
    const s3 = await submissionOf("dev@zzintake-forms.example");
    ok(
      "  its answer stays with the form — on the submission and in the lead's description, not in the retired field",
      late.ok && !Object.prototype.hasOwnProperty.call(s3.lead?.customFields ?? {}, "floor") && ((s3.payload ?? {}) as Record<string, string>).floorQ === "7" && (s3.lead?.description ?? "").includes("Which floor?: 7"),
      `${errorOf(late)} ${JSON.stringify(s3.lead?.customFields)} ${s3.lead?.description}`,
    );
    const resave = await forms.saveForm({ ...formInput, id: formId });
    ok("  and the builder's next save asks for the link to go", !resave.ok && resave.error.includes("Which floor?"), errorOf(resave));

    section("Forms: an invitation writes to its lead only");
    const asha = await db.contact.findFirstOrThrow({ where: { email: "asha@zzintake-forms.example" }, select: { id: true, companyId: true } });
    const invite = await db.formInvite.create({
      data: { formId, token: randomBytes(24).toString("base64url"), contactId: asha.id, companyId: asha.companyId, email: "asha@zzintake-forms.example", invitedById: owner.id },
      select: { id: true, token: true },
    });
    const invited = await publicForms.submitForm({
      slug: SLUG,
      values: { ...answers, whichTower: "Z", industryQ: "Retail", mobile: "+91 90000 33333" },
      inviteToken: invite.token,
    });
    const viaInvite = await db.formSubmission.findUniqueOrThrow({ where: { inviteId: invite.id }, select: { lead: { select: { customFields: true } } } });
    const invitedLead = (viaInvite.lead?.customFields ?? {}) as Record<string, unknown>;
    ok("the new lead takes the answers saved to it", invited.ok && invitedLead.tower === "Z", `${errorOf(invited)} ${JSON.stringify(invitedLead)}`);
    const companyNow = await db.company.findUniqueOrThrow({ where: { id: asha.companyId }, select: { customFields: true } });
    const contactNow = await db.contact.findUniqueOrThrow({ where: { id: asha.id }, select: { customFields: true } });
    ok(
      "  the company and contact it was sent to keep their own",
      sameJson(companyNow.customFields, { industry: "pharma" }) && sameJson(contactNow.customFields, { alternate_phone: "+91 90000 11111" }),
      `${JSON.stringify(companyNow.customFields)} ${JSON.stringify(contactNow.customFields)}`,
    );

    section("Forms: the builder");
    const storedForm = await db.inboundForm.findUniqueOrThrow({ where: { id: formId }, select: { fields: true } });
    const html = renderToStaticMarkup(
      createElement(FormBuilder, {
        formId,
        initialFields: parseFields(storedForm.fields),
        users: [],
        initial: {
          name: `${TAG} Enquiry`,
          slug: SLUG,
          headline: "",
          intro: "",
          thankYouText: "",
          category: "ENQUIRY",
          fillMode: "BOTH",
          createsLead: true,
          topic: "OFFERS",
          assignToUserId: owner.id,
          closesAt: "",
          eventStartsAt: "",
          eventEndsAt: "",
          venue: "",
          capacity: "",
          active: true,
        },
      }),
    );
    ok("a question saved to a field says so, each with its own labelled choice", (html.match(/Save the answer to/g) ?? []).length === 7, (html.match(/Save the answer to/g) ?? []).length);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * check:custom-fields — the workspace's own fields on companies, contacts, leads, orders and products
 * (owner, 2 Oct 2026): src/lib/custom-fields, src/actions/custom-fields.ts, and every place a value is
 * entered, shown, exported or imported.
 *
 * The pure part needs no database: keys, every type's checking and storing, what a person without
 * `fields.seeRestricted` can and can't change, retired fields and options, and how values read.
 *
 * The rest builds a scratch workspace database beside the real one (as check:rebates does), drives the
 * real actions as a workspace pointed at it (`runAsTenant`), and drops it at the end, pass or fail:
 *
 *   · settings: only `fields.manage` shapes fields; the type is fixed; a renamed option keeps its value
 *     and a removed one is retired; reordering, retiring, restoring, and deleting only what's unused;
 *   · products, end to end: the create form's required field, values stored as the rules say, a
 *     restricted field nobody without the permission can see or set, the "More details" card and its
 *     edit action, list columns, the item page rendered for each person;
 *   · Settings → Data: custom columns exported and imported back with nothing changed, a changed cell
 *     reported and written, an unknown option refused, a blank cell leaving a value alone, a label that
 *     clashes with a built-in column headed "(custom)"; the products CSV the same way;
 *   · companies, contacts, leads and orders: each create form's required field, each record's edit
 *     action refusing somebody outside the account, the search box finding a record by its own fields
 *     (and the company list's category filter still applying beside it), a company merge keeping the
 *     staying company's answers and filling its gaps from the duplicate, and a reseller's end-customer
 *     contact whose hidden contact fields are left alone — even a required one — by somebody who can't
 *     see them, as are its built-in email and phone (an edit used to save the blanks the form showed),
 *     which Settings → Data then neither exports nor shows or changes on import for that person;
 *   · and the real workspace untouched.
 *
 *   npm run check:custom-fields
 *   TZ=UTC npm run check:custom-fields      (from PowerShell: $env:TZ = "UTC"; npm run check:custom-fields)
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import type { PrismaClient } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";
import {
  applyInput,
  coerceValue,
  exportValue,
  formValues,
  formatValue,
  groupDefs,
  keyFromLabel,
  readValues,
  visibleDefs,
  visibleValues,
  type CustomFieldDef,
} from "../src/lib/custom-fields/rules";

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

const TAG = "ZZCUSTOM";

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
  usePathname: () => "/items",
  useSearchParams: () => new URLSearchParams(),
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
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
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

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

function pure() {
  section("Keys");
  ok(
    "a key from a label: lower case, underscores, a letter first, never one already taken",
    keyFromLabel("Batch no.", []) === "batch_no" &&
      keyFromLabel("Batch no.", ["batch_no"]) === "batch_no_2" &&
      keyFromLabel("Batch no.", ["batch_no", "batch_no_2"]) === "batch_no_3" &&
      keyFromLabel("2nd contact", []) === "f_2nd_contact" &&
      keyFromLabel("Café", []) === "cafe" &&
      keyFromLabel("!!!", []) === "field",
  );
  ok("  and at most 40 characters", keyFromLabel("A".repeat(80), []).length <= 40);

  section("Each type checked and stored");
  const c = (d: CustomFieldDef, input: unknown, existing?: string | string[]) => coerceValue(d, input, existing);
  const n = def({ key: "qty", type: "NUMBER" });
  const m = def({ key: "deal", type: "MONEY" });
  ok("a number, with Indian commas and spaces", (c(n, "1,23,456.5") as { value: unknown }).value === 123456.5);
  ok("  an amount to the paisa, with or without ₹", (c(m, "₹ 1,250.456") as { value: unknown }).value === 1250.46);
  ok("  not a word", !c(n, "twelve").ok && !c(n, "1e400").ok);
  const d = def({ key: "expiry", type: "DATE" });
  ok("a date as a calendar day, never one that doesn't exist", (c(d, "2026-02-28") as { value: unknown }).value === "2026-02-28" && !c(d, "2026-02-30").ok && !c(d, "28/02/2026").ok);
  const s = def({
    key: "tier",
    type: "SELECT",
    options: [
      { value: "gold", label: "Gold" },
      { value: "silver", label: "Silver" },
      { value: "bronze", label: "Bronze", archived: true },
    ],
  });
  ok("a dropdown by its stored value or its label in any case", (c(s, "gold") as { value: unknown }).value === "gold" && (c(s, "SILVER") as { value: unknown }).value === "silver");
  ok("  a retired option kept where held, never newly chosen", (c(s, "bronze", "bronze") as { value: unknown }).value === "bronze" && !c(s, "bronze").ok);
  ok("  anything else refused, naming it", !c(s, "Platinum").ok && (c(s, "Platinum") as { error: string }).error.includes("Platinum"));
  const ms = def({ key: "regions", type: "MULTI_SELECT", options: [{ value: "north", label: "North" }, { value: "south", label: "South" }] });
  ok(
    "a multi-select from a list or from text split on ; , |",
    JSON.stringify((c(ms, ["north"]) as { value: unknown }).value) === '["north"]' &&
      JSON.stringify((c(ms, "North; south|NORTH") as { value: unknown }).value) === '["north","south"]',
  );
  const yn = def({ key: "gst_registered", type: "CHECKBOX" });
  ok("yes or no from a tick or from words", (c(yn, true) as { value: unknown }).value === true && (c(yn, "No") as { value: unknown }).value === false && !c(yn, "maybe").ok);
  ok(
    "an email, lower-cased; a phone; a web address completed with https://",
    (c(def({ key: "e", type: "EMAIL" }), "Ops@Acme.IN") as { value: unknown }).value === "ops@acme.in" &&
      c(def({ key: "p", type: "PHONE" }), "+91 98765 43210").ok &&
      (c(def({ key: "u", type: "URL" }), "acme.in/careers") as { value: unknown }).value === "https://acme.in/careers",
  );
  ok(
    "  never javascript:, data: or an address with a password",
    !c(def({ key: "u", type: "URL" }), "javascript:alert(1)").ok &&
      !c(def({ key: "u", type: "URL" }), "data:text/html,x").ok &&
      !c(def({ key: "u", type: "URL" }), "https://a:b@acme.in").ok,
  );
  ok(
    "short text on one line, long text up to its limit",
    (c(def({ key: "t", type: "TEXT" }), "Tower A\nFloor 3") as { value: unknown }).value === "Tower A Floor 3" &&
      !c(def({ key: "t", type: "TEXT" }), "x".repeat(256)).ok &&
      c(def({ key: "l", type: "LONG_TEXT" }), "x".repeat(5000)).ok,
  );
  ok("empty is empty, whatever the type", (c(n, "") as { value: unknown }).value === null && (c(ms, []) as { value: unknown }).value === null);

  section("Saving: what a person may change");
  const defs: CustomFieldDef[] = [
    def({ key: "tower", type: "TEXT", label: "Tower", required: true }),
    def({ key: "cost", type: "MONEY", label: "Cost price", restricted: true }),
    def({ key: "legacy", type: "TEXT", label: "Legacy code", archived: true }),
  ];
  const existing = { cost: 900, legacy: "L-1", orphan: "kept" };
  const missing = applyInput({ defs, input: { tower: "" }, existing, canSeeRestricted: false });
  ok("a required field left empty is refused, by name", !missing.ok && missing.errors[0]!.message === "Enter Tower.");
  const dotted = applyInput({ defs: [def({ key: "batch_no", type: "TEXT", label: "Batch no.", required: true })], input: { batch_no: "" }, canSeeRestricted: false });
  ok("  a label that ends in a full stop gets no second one", !dotted.ok && dotted.errors[0]!.message === "Enter Batch no.");
  const exec = applyInput({ defs, input: { tower: "A", cost: "1", legacy: "X" }, existing, canSeeRestricted: false });
  ok(
    "without the permission: the restricted value stays as it was, the retired one too, unknown keys kept",
    exec.ok && exec.values.tower === "A" && exec.values.cost === 900 && exec.values.legacy === "L-1" && exec.values.orphan === "kept",
    JSON.stringify(exec.ok ? exec.values : exec.errors),
  );
  const mgr = applyInput({ defs, input: { tower: "A", cost: "" }, existing, canSeeRestricted: true });
  ok("  with it: the restricted value can be cleared", mgr.ok && !("cost" in mgr.values));
  const absent = applyInput({ defs, input: {}, existing: { tower: "B" }, canSeeRestricted: true });
  const absentNew = applyInput({ defs, input: {}, existing: {}, canSeeRestricted: true });
  ok(
    "a field not sent at all keeps its value; a required one with no value is still refused",
    absent.ok && absent.values.tower === "B" && !absentNew.ok && absentNew.errors[0]!.key === "tower",
  );
  const onlySome = applyInput({ defs, input: { cost: "5" }, existing: { tower: "B" }, canSeeRestricted: true, only: ["cost"], checkRequired: false });
  ok("only the fields named are set — an import's mapped columns", onlySome.ok && onlySome.values.tower === "B" && onlySome.values.cost === 5);
  ok("readValues keeps only plain values under real keys", JSON.stringify(readValues({ ok: "x", n: 2, Bad: "y", obj: { a: 1 }, list: ["a", 2] })) === '{"ok":"x","n":2}');
  ok(
    "a person without the permission is never sent a restricted value",
    JSON.stringify(visibleValues(defs, { tower: "A", cost: 9 }, false)) === '{"tower":"A"}' && visibleDefs(defs, false).length === 1,
  );

  section("How values read");
  const day = def({ key: "expiry", type: "DATE" });
  ok(
    "dates, amounts, options and yes/no in words; empty is blank",
    formatValue(day, "2026-03-12") === "12 Mar 2026" &&
      formatValue(m, 4500) === "₹4,500.00" &&
      formatValue(ms, ["north", "south"]) === "North, South" &&
      formatValue(yn, true) === "Yes" &&
      formatValue(n, undefined) === "",
  );
  ok("a person by name, or said to be gone", formatValue(def({ key: "who", type: "USER" }), "u1", (id) => (id === "u1" ? "Asha" : null)) === "Asha" && formatValue(def({ key: "who", type: "USER" }), "u2") === "Someone no longer here");
  ok("an export writes dates as yyyy-mm-dd and lists with ;", exportValue(day, "2026-03-12") === "2026-03-12" && exportValue(ms, ["north", "south"]) === "North; South");
  ok(
    "a form starts from the stored values, as its inputs hold them",
    JSON.stringify(formValues([n, yn, ms], { qty: 3 })) === '{"qty":"3","gst_registered":false,"regions":[]}',
  );
  ok(
    "fields grouped under their headings, in order of first appearance",
    groupDefs([def({ key: "a", type: "TEXT", group: "Compliance" }), def({ key: "b", type: "TEXT" }), def({ key: "c", type: "TEXT", group: "Compliance" })])
      .map((g) => `${g.group || "-"}:${g.fields.map((f) => f.key).join("")}`)
      .join(" ") === "Compliance:ac -:b",
  );
}

// ── The scratch database ────────────────────────────────────────────────────────────────────────

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
  const scratchName = `${realName}_customfields`;
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
  ok("its field definitions, companies and items are as they were", realAfter.counts === realBefore.counts, realAfter.counts);
  ok("  and nothing of this suite's is in it", realAfter.tagged === 0 && realBefore.tagged === 0, realAfter.tagged);

  console.log(failures === 0 ? `\nAll ${passes} custom-fields checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/** What the suite must never change in the real workspace. Read-only. */
async function snapshot(client: PrismaClient) {
  const [definitions, companies, items, tagged] = await Promise.all([
    client.customFieldDefinition.count(),
    client.company.count(),
    client.item.count(),
    client.item.count({ where: { name: { startsWith: TAG } } }),
  ]);
  return { counts: JSON.stringify({ definitions, companies, items }), tagged };
}

// ── The suite ───────────────────────────────────────────────────────────────────────────────────

async function run(scratchUrl: string) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
  const settings = require("../src/actions/custom-fields") as typeof import("../src/actions/custom-fields");
  const items = require("../src/actions/item") as typeof import("../src/actions/item");
  const server = require("../src/lib/custom-fields/server") as typeof import("../src/lib/custom-fields/server");
  const { itemsExporter } = require("../src/lib/portability/exporters/trade") as typeof import("../src/lib/portability/exporters/trade");
  const { contactsExporter } = require("../src/lib/portability/exporters/crm") as typeof import("../src/lib/portability/exporters/crm");
  const portability = require("../src/lib/portability/import") as typeof import("../src/lib/portability/import");
  const { accountBundle } = require("../src/lib/portability/export") as typeof import("../src/lib/portability/export");
  const { formatItemId } = require("../src/lib/order-id") as typeof import("../src/lib/order-id");
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  const ItemPage = (require("../src/app/(dashboard)/items/[id]/page") as { default: (p: unknown) => Promise<ReactElement> }).default;
  /* eslint-enable @typescript-eslint/no-require-imports */

  const tenant = {
    id: randomUUID(),
    slug: "zzcustom",
    name: "zzcustom",
    status: "ACTIVE" as const,
    dbUrl: scratchUrl,
    primaryHost: "zzcustom.localhost",
    hosts: ["zzcustom.localhost"],
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
    const user = (key: string, grants: Record<string, boolean>, extra: { isSuperAdmin?: boolean; role?: string } = {}) =>
      db.user.create({
        data: {
          name: `${TAG} ${key}`,
          email: `${TAG.toLowerCase()}-${key.toLowerCase()}@example.test`,
          passwordHash: "!",
          role: extra.role ?? "PROFILE",
          isSuperAdmin: extra.isSuperAdmin ?? false,
          permissionGrants: { create: Object.entries(grants).map(([permission, allowed]) => ({ permission, allowed, reason: TAG })) },
        },
        select: { id: true, name: true, email: true, role: true },
      });
    const base = { "fields.manage": false, "fields.seeRestricted": false, "leads.view": true, "contacts.view": true, "orders.view": true };
    const owner = await user("Owner", {}, { isSuperAdmin: true, role: "ADMIN" });
    const admin = await user("Admin", { ...base, "fields.manage": true, "fields.seeRestricted": true, "companies.viewAll": true });
    const exec = await user("Executive", { ...base, "companies.viewAll": false, "contacts.viewRestricted": false });
    // Sees the CRM, but none of the executive's accounts.
    const outsider = await user("Outsider", { ...base, "companies.viewAll": false, "orders.process": false, "orders.approve": false });
    const as = (u: { id: string; name: string; email: string; role: string }) => {
      actor = u;
    };
    ok("an administrator who manages fields and sees restricted ones, an executive who does neither, and an outsider", !!owner && !!outsider);

    // ── Settings ───────────────────────────────────────────────────────────────────────────────
    section("Settings: shaping the fields");
    const field = (over: Record<string, unknown>) => ({
      entity: "ITEM",
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
    as(exec);
    const refused = await settings.saveCustomFieldDefinition(field({ label: "Batch no." }));
    ok("an executive can't add a field", !refused.ok, errorOf(refused));
    ok("  nor list them for managing", (await settings.listCustomFieldsForManage()) === null);
    as(admin);
    const idOf = (r: { ok: boolean; data?: unknown; error?: string }) => {
      if (!r.ok) throw new Error(`refused: ${r.error}`);
      return (r.data as { id: string }).id;
    };
    const batch = idOf(await settings.saveCustomFieldDefinition(field({ label: "Batch no.", required: true, group: "Traceability", showInList: true, helpText: "As printed on the box" })));
    const grade = idOf(
      await settings.saveCustomFieldDefinition(field({ label: "Grade", type: "SELECT", options: [{ label: "Gold" }, { label: "Silver" }], showInList: true })),
    );
    const cost = idOf(await settings.saveCustomFieldDefinition(field({ label: "Landed cost", type: "MONEY", restricted: true, showInList: true })));
    const expiry = idOf(await settings.saveCustomFieldDefinition(field({ label: "Licence expiry", type: "DATE", group: "Traceability" })));
    const priceClash = idOf(await settings.saveCustomFieldDefinition(field({ label: "Price", type: "NUMBER" })));
    const stored = await db.customFieldDefinition.findMany({ where: { entity: "ITEM" }, orderBy: { sortOrder: "asc" } });
    ok(
      "five fields added, keyed from their labels, in the order they were added",
      stored.map((d) => d.key).join(",") === "batch_no,grade,landed_cost,licence_expiry,price",
      stored.map((d) => d.key).join(","),
    );
    const gradeRow = stored.find((d) => d.id === grade)!;
    ok("  a dropdown's options keyed too", sameJson(gradeRow.options, [{ value: "gold", label: "Gold" }, { value: "silver", label: "Silver" }]), JSON.stringify(gradeRow.options));
    const dup = await settings.saveCustomFieldDefinition(field({ label: "batch NO." }));
    ok("a second field with the same name is refused", !dup.ok, errorOf(dup));
    const retype = await settings.saveCustomFieldDefinition(field({ id: batch, label: "Batch no.", type: "NUMBER" }));
    ok("a field's type can't change", !retype.ok && retype.error.includes("type"), errorOf(retype));
    const renamed = await settings.saveCustomFieldDefinition(
      field({ id: grade, label: "Quality grade", type: "SELECT", options: [{ value: "gold", label: "Gold plus" }, { label: "Bronze" }], showInList: true }),
    );
    const gradeAfter = await db.customFieldDefinition.findUniqueOrThrow({ where: { id: grade } });
    ok(
      "renaming keeps the key; a renamed option keeps its value; a removed one is retired; a new one added",
      renamed.ok &&
        gradeAfter.key === "grade" &&
        sameJson(gradeAfter.options, [{ value: "gold", label: "Gold plus" }, { value: "bronze", label: "Bronze" }, { value: "silver", label: "Silver", archived: true }]),
      JSON.stringify(gradeAfter.options),
    );
    const noOptions = await settings.saveCustomFieldDefinition(field({ label: "Colour", type: "SELECT", options: [] }));
    ok("a dropdown with nothing to choose is refused", !noOptions.ok, errorOf(noOptions));
    await settings.moveCustomFieldDefinition(expiry, "up");
    const order = (await db.customFieldDefinition.findMany({ where: { entity: "ITEM", archivedAt: null }, orderBy: { sortOrder: "asc" } })).map((d) => d.key);
    ok("moving a field up swaps it with the one above", order.join(",") === "batch_no,grade,licence_expiry,landed_cost,price", order.join(","));
    const unused = await settings.deleteCustomFieldDefinition(priceClash);
    ok("an unused field can be deleted", unused.ok, errorOf(unused));
    const priceAgain = idOf(await settings.saveCustomFieldDefinition(field({ label: "Price", type: "NUMBER" })));
    ok("  (and added again for the spreadsheet checks)", !!priceAgain);

    // ── Products, end to end ───────────────────────────────────────────────────────────────────
    section("Products: the create form and the stored values");
    const product = (sku: string, extra: Record<string, unknown> = {}) =>
      items.createItem({ name: `${TAG} ${sku}`, sku: `${TAG}-${sku}`, type: "SERVICE", sellingPrice: 1000, ...extra });
    as(admin);
    const noBatch = await product("A1", { customFields: { grade: "gold" } });
    ok("a product without its required batch number is refused, by name", !noBatch.ok && noBatch.error.includes("Batch no."), errorOf(noBatch));
    const badGrade = await product("A1", { customFields: { batch_no: "B-1", grade: "platinum" } });
    ok("  and with an option that isn't one", !badGrade.ok && badGrade.error.includes("platinum"), errorOf(badGrade));
    const a1 = idOf(
      await product("A1", { customFields: { batch_no: "B-1", grade: "Gold plus", landed_cost: "1,250.50", licence_expiry: "2027-03-31", price: "7", junk: "x" } }),
    );
    const a1Row = await db.item.findUniqueOrThrow({ where: { id: a1 }, select: { customFields: true } });
    ok(
      "stored as the rules say: the option's value, the amount as a number, the day as text, nothing unknown",
      sameJson(a1Row.customFields, { batch_no: "B-1", grade: "gold", landed_cost: 1250.5, licence_expiry: "2027-03-31", price: 7 }),
      JSON.stringify(a1Row.customFields),
    );
    const plain = await db.item.findUniqueOrThrow({ where: { id: a1 } });
    ok("a read without naming the column doesn't carry it (NOT_YET_EVERYWHERE)", !("customFields" in plain) || plain.customFields === undefined);
    as(exec);
    const a2 = idOf(await product("A2", { customFields: { batch_no: "B-2", landed_cost: "999" } }));
    const a2Row = await db.item.findUniqueOrThrow({ where: { id: a2 }, select: { customFields: true } });
    ok("an executive's restricted value is not taken", sameJson(a2Row.customFields, { batch_no: "B-2" }), JSON.stringify(a2Row.customFields));

    section("Products: the More details card and its edit");
    as(exec);
    const cleared = await items.updateItemCustomFields(a1, { batch_no: "B-1A", grade: "", licence_expiry: "2027-03-31" });
    const a1After = await server.valuesFor("ITEM", a1);
    ok(
      "the executive edits what they see; the restricted cost they can't see stays",
      cleared.ok && a1After.batch_no === "B-1A" && !("grade" in a1After) && a1After.landed_cost === 1250.5,
      `${errorOf(cleared)} ${JSON.stringify(a1After)}`,
    );
    ok("  a field the save didn't send keeps its value", a1After.price === 7, JSON.stringify(a1After));
    const audit = await db.auditLog.findFirst({ where: { entityId: a1, entityType: "Item" }, orderBy: { createdAt: "desc" } });
    ok("  audited with the fields that changed", !!audit && audit.entityLabel.includes("Batch no.") && audit.entityLabel.includes("Quality grade"), audit?.entityLabel);
    const emptied = await items.updateItemCustomFields(a1, { batch_no: "" });
    ok("  a required field can't be emptied", !emptied.ok && emptied.error.includes("Batch no."), errorOf(emptied));
    const execShown = await server.displayFields("ITEM", exec.id, a1After);
    const adminShown = await server.displayFields("ITEM", admin.id, a1After);
    const labels = (g: typeof execShown) => g.flatMap((x) => x.fields.map((f) => `${f.label}=${f.text}`)).join("|");
    ok(
      "the card for the executive: no restricted field, under its headings",
      !labels(execShown).includes("Landed cost") && execShown[0]?.group === "Traceability" && labels(execShown).includes("Licence expiry=31 Mar 2027"),
      labels(execShown),
    );
    ok("  for the administrator: the cost too, in rupees", labels(adminShown).includes("Landed cost=₹1,250.50"), labels(adminShown));

    section("Products: list columns and the item page");
    // The products list has no column picker, so it asks for the marked fields only (`listedOnly`).
    const execCols = await server.listColumns("ITEM", exec.id, [a1, a2], { listedOnly: true });
    const adminCols = await server.listColumns("ITEM", admin.id, [a1, a2], { listedOnly: true });
    ok(
      "the list's columns are the fields marked for it, restricted ones only for those who may see them",
      execCols.columns.map((c) => c.label).join(",") === "Batch no.,Quality grade" &&
        adminCols.columns.map((c) => c.label).join(",") === "Batch no.,Quality grade,Landed cost" &&
        adminCols.texts[a1]?.landed_cost === "₹1,250.50" &&
        execCols.texts[a2]?.batch_no === "B-2",
      `${execCols.columns.map((c) => c.label)} / ${adminCols.columns.map((c) => c.label)}`,
    );
    // A list with a picker is offered every field, each with its default (check:custom-field-filters).
    const choosable = await server.listColumns("ITEM", exec.id, [a1, a2]);
    ok(
      "  for a list with a column picker, every field the person sees, the marked ones on by default",
      choosable.columns.map((c) => `${c.label}:${c.default}`).join(",") === "Batch no.:true,Quality grade:true,Licence expiry:false,Price:false",
      choosable.columns.map((c) => `${c.label}:${c.default}`).join(","),
    );
    const seq = (await db.item.findUniqueOrThrow({ where: { id: a1 }, select: { itemSeq: true } })).itemSeq;
    const page = async (who: typeof exec) => {
      as(who);
      const el = await ItemPage({ params: Promise.resolve({ id: formatItemId(seq) }), searchParams: Promise.resolve({}) });
      return textOf(renderToStaticMarkup((await resolveAsync(el)) as ReactElement));
    };
    const execPage = await page(exec);
    const adminPage = await page(admin);
    ok("the item page shows More details with the executive's fields", execPage.includes("More details") && execPage.includes("B-1A") && !execPage.includes("Landed cost"));
    ok("  and the administrator's, the cost included", adminPage.includes("Landed cost") && adminPage.includes("₹1,250.50"));

    // ── Spreadsheets ───────────────────────────────────────────────────────────────────────────
    section("Settings → Data: exported and imported back");
    as(admin);
    const exported = (await itemsExporter({ userId: admin.id, ownerUserIds: null })) as Record<string, unknown>[];
    const row1 = exported.find((r) => r.SKU === `${TAG}-A1`)!;
    ok(
      "every visible field is a column, empty or not; one named like a built-in column is headed “(custom)”",
      row1["Batch no."] === "B-1A" && row1["Quality grade"] === "" && row1["Landed cost"] === 1250.5 && row1["Licence expiry"] === "2027-03-31" && row1["Price (custom)"] === 7,
      JSON.stringify(row1),
    );
    const execExport = (await itemsExporter({ userId: exec.id, ownerUserIds: null })) as Record<string, unknown>[];
    ok("  an executive's export has no restricted column", !("Landed cost" in execExport[0]!));
    const asStrings = exported.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === null || v === undefined ? "" : String(v)])));
    const again = await portability.plan("items", asStrings, admin.id);
    ok(
      "the export imported straight back changes nothing, and has no unknown columns",
      again.updates === 0 && again.errors === 0 && again.unknownColumns.length === 0,
      `${again.updates} updates, ${again.errors} errors, unknown: ${again.unknownColumns.join(",")} ${JSON.stringify(again.rows.filter((r) => r.action !== "skip").slice(0, 2))}`,
    );
    const edited = asStrings.map((r) => (r.SKU === `${TAG}-A1` ? { ...r, "Quality grade": "Bronze", "Landed cost": "" } : r));
    const editPlan = await portability.plan("items", edited, admin.id);
    const a1Planned = editPlan.rows.find((r) => r.label.includes("A1"));
    ok(
      "a changed cell is reported as one change; a blank cell leaves the value alone",
      editPlan.updates === 1 && a1Planned?.changes.length === 1 && a1Planned.changes[0]!.field === "Quality grade" && a1Planned.changes[0]!.to === "Bronze",
      JSON.stringify(a1Planned?.changes),
    );
    await portability.apply("items", edited, admin.id);
    const afterImport = await server.valuesFor("ITEM", a1);
    ok("  and written", afterImport.grade === "bronze" && afterImport.landed_cost === 1250.5, JSON.stringify(afterImport));
    const badPlan = await portability.plan("items", edited.map((r) => (r.SKU === `${TAG}-A2` ? { ...r, "Quality grade": "Platinum" } : r)), admin.id);
    ok("an option that isn't one makes that row an error, naming it", badPlan.errors === 1 && (badPlan.rows.find((r) => r.action === "error")?.error ?? "").includes("Platinum"));
    const template = await portability.templateColumnsFor("items", admin.id);
    ok("the template offers the custom columns after the built-in ones", template.slice(-5).join("|") === "Batch no.|Quality grade|Licence expiry|Landed cost|Price (custom)", template.join("|"));

    section("The products CSV: exported and imported back");
    // A negative amount: the CSV guard must leave numbers alone, or "-5" comes back as text.
    await items.updateItemCustomFields(a2, { price: "-5" });
    const csv = await items.exportItemsCsv();
    const header = csv.ok ? csv.data.csv.split(/\r?\n/)[0]! : "";
    ok("custom columns after the built-in ones, a clashing label headed “(custom)”", header.endsWith("Batch no.,Quality grade,Licence expiry,Landed cost,Price (custom)"), header);
    const form = new FormData();
    const changed = csv.ok ? csv.data.csv.replace(/B-2(?=,)/, "B-2X") : "";
    form.set("file", new File([changed], "items.csv", { type: "text/csv" }));
    const imported = await items.importItems(form);
    const a2Final = await server.valuesFor("ITEM", a2);
    ok(
      "re-imported with one batch number changed: that one written, nothing else touched",
      imported.ok && imported.data.errors.length === 0 && a2Final.batch_no === "B-2X" && a2Final.price === -5 && (await server.valuesFor("ITEM", a1)).grade === "bronze",
      `${imported.ok ? JSON.stringify(imported.data.errors) : imported.error} ${JSON.stringify(a2Final)}`,
    );

    section("JSON filters on this engine (what search and list filters will rely on)");
    const found = await db.item.findMany({ where: { customFields: { path: ["batch_no"], string_contains: "b-2", mode: "insensitive" } }, select: { id: true } });
    ok("text inside a field, ignoring case", found.length === 1 && found[0]!.id === a2, found.map((f) => f.id).join(","));
    const ranged = await db.item.findMany({ where: { customFields: { path: ["landed_cost"], gte: 1000 } }, select: { id: true } });
    ok("a number range", ranged.length === 1 && ranged[0]!.id === a1, ranged.map((f) => f.id).join(","));
    const exact = await db.item.findMany({ where: { customFields: { path: ["grade"], equals: "bronze" } }, select: { id: true } });
    ok("an option by its stored value", exact.length === 1 && exact[0]!.id === a1);
    await db.item.update({ where: { id: a2 }, data: { customFields: { batch_no: "B-2X", regions: ["north", "south"] } } });
    const inList = await db.item.findMany({ where: { customFields: { path: ["regions"], array_contains: ["south"] } }, select: { id: true } });
    ok("a value in a multi-select's list", inList.length === 1 && inList[0]!.id === a2);
    const day = await db.item.findMany({ where: { customFields: { path: ["licence_expiry"], string_starts_with: "2027-03" } }, select: { id: true } });
    ok("a date's month by its text", day.length === 1 && day[0]!.id === a1);
    await db.item.update({ where: { id: a2 }, data: { customFields: { batch_no: "B-2X" } } });

    section("Searching the products list by a custom field");
    const searchIds = async (who: typeof exec, q: string) => {
      as(who);
      return (await items.listItems({ search: q })).items.map((i) => i.id);
    };
    ok("a batch number finds its product", JSON.stringify(await searchIds(exec, "b-1a")) === JSON.stringify([a1]));
    ok("  a dropdown option by its label", JSON.stringify(await searchIds(exec, "bronze")) === JSON.stringify([a1]));
    ok("a restricted amount finds nothing for somebody who can't see it", (await searchIds(exec, "1250.5")).length === 0);
    ok("  and finds the product for somebody who can", JSON.stringify(await searchIds(admin, "1250.5")) === JSON.stringify([a1]));
    as(admin);

    section("Retiring and deleting");
    const inUse = await settings.deleteCustomFieldDefinition(batch);
    ok("a field records hold values in can't be deleted — it says to retire it", !inUse.ok && inUse.error.includes("retire"), errorOf(inUse));
    await settings.archiveCustomFieldDefinition(cost);
    const afterRetire = await server.displayFields("ITEM", admin.id, await server.valuesFor("ITEM", a1));
    ok("a retired field is off the record's card", !afterRetire.flatMap((g) => g.fields).some((f) => f.label === "Landed cost"));
    ok("  its values kept", (await server.valuesFor("ITEM", a1)).landed_cost === 1250.5);
    const keepRetired = await items.updateItemCustomFields(a1, { batch_no: "B-1A", landed_cost: "1" });
    ok("  and untouched by a save that names it", keepRetired.ok && (await server.valuesFor("ITEM", a1)).landed_cost === 1250.5);
    await settings.restoreCustomFieldDefinition(cost);
    ok("restored, it is back with its value", (await server.displayFields("ITEM", admin.id, await server.valuesFor("ITEM", a1))).flatMap((g) => g.fields).some((f) => f.text === "₹1,250.50"));
    const managed = await settings.listCustomFieldsForManage();
    const itemTab = managed?.entities.find((e) => e.entity === "ITEM");
    ok(
      "the settings screen counts the records using each field",
      itemTab?.fields.find((f) => f.key === "batch_no")?.inUse === 2 && itemTab.fields.find((f) => f.key === "landed_cost")?.inUse === 1,
      JSON.stringify(itemTab?.fields.map((f) => [f.key, f.inUse])),
    );

    // ── Companies and contacts ─────────────────────────────────────────────────────────────────
    section("Companies: the create form, the edit, the list and the search");
    /* eslint-disable @typescript-eslint/no-require-imports */
    const companies = require("../src/actions/company") as typeof import("../src/actions/company");
    const contacts = require("../src/actions/contact") as typeof import("../src/actions/contact");
    const leads = require("../src/actions/lead") as typeof import("../src/actions/lead");
    const orders = require("../src/actions/order") as typeof import("../src/actions/order");
    const { executeMerge } = require("../src/lib/companies/merge") as typeof import("../src/lib/companies/merge");
    /* eslint-enable @typescript-eslint/no-require-imports */
    as(admin);
    idOf(
      await settings.saveCustomFieldDefinition(
        field({ entity: "COMPANY", label: "Region", type: "SELECT", options: [{ label: "North" }, { label: "South" }], required: true, showInList: true }),
      ),
    );
    idOf(await settings.saveCustomFieldDefinition(field({ entity: "COMPANY", label: "Internal rating", restricted: true })));
    const newCompany = (name: string, customFields?: Record<string, unknown>) =>
      companies.createCompany({
        name: `${TAG} ${name}`,
        source: "LINKEDIN",
        location: { label: "Head Office", country: "India", gstTreatment: "UNREGISTERED" },
        contacts: [],
        ...(customFields ? { customFields } : {}),
      });
    as(exec);
    const noRegion = await newCompany("Northwind");
    ok("a company without its required region is refused, by name", !noRegion.ok && noRegion.error.includes("Region"), errorOf(noRegion));
    const northwind = idOf(await newCompany("Northwind", { region: "North", internal_rating: "A" }));
    const nwValues = await server.valuesFor("COMPANY", northwind);
    ok("created with the region; the executive's restricted rating not taken", sameJson(nwValues, { region: "north" }), JSON.stringify(nwValues));
    as(outsider);
    const outsiderEdit = await companies.updateCompanyCustomFields(northwind, { region: "South" });
    ok("somebody outside the account can't change its fields", !outsiderEdit.ok, errorOf(outsiderEdit));
    as(owner);
    const rated = await companies.updateCompanyCustomFields(northwind, { region: "north", internal_rating: "" });
    ok("  the owner can, and an empty restricted field stays empty", rated.ok, errorOf(rated));
    as(exec);
    const companySearch = async (q: string, extra: Record<string, unknown> = {}) =>
      (await companies.listCompaniesPaged({ search: q, page: 1, pageSize: 20, relationshipType: "CLIENT", ...extra })).rows.map((r) => r.id);
    ok("the company list's search finds it by its region's label", (await companySearch("North")).includes(northwind));
    ok(
      "  and with the category filter beside it — both apply, neither drops the other",
      (await companySearch("North", { categoryId: "none" })).includes(northwind) && !(await companySearch("Zzzz", { categoryId: "none" })).includes(northwind),
    );
    const companyCols = await server.listColumns("COMPANY", exec.id, [northwind]);
    ok("its list shows the region column", companyCols.columns.map((c) => c.label).join(",") === "Region" && companyCols.texts[northwind]?.region === "North");

    section("Company merge: the staying company's answers, its gaps filled from the duplicate");
    as(exec);
    const duplicate = idOf(await newCompany("Northwind Duplicate", { region: "South" }));
    as(owner);
    await companies.updateCompanyCustomFields(duplicate, { region: "south", internal_rating: "B" });
    await executeMerge({ keepId: northwind, dropId: duplicate, choices: {}, combine: [], userId: owner.id });
    const merged = await server.valuesFor("COMPANY", northwind);
    ok(
      "after the merge: the staying company's region kept, the duplicate's rating filled in",
      merged.region === "north" && merged.internal_rating === "B",
      JSON.stringify(merged),
    );

    section("Contacts: the add form, the edit, and the search");
    as(admin);
    const altPhone = idOf(await settings.saveCustomFieldDefinition(field({ entity: "CONTACT", label: "Alternate phone", type: "PHONE" })));
    idOf(await settings.saveCustomFieldDefinition(field({ entity: "CONTACT", label: "Birthday", type: "DATE" })));
    as(exec);
    const asha = await companies.addContact(northwind, { name: "Asha Rao", designation: "OTHER", email: "", phone: "", customFields: { birthday: "1990-05-01" } });
    const ashaId = asha.ok ? (asha.data as { id: string }).id : "";
    ok("a contact added with a birthday", asha.ok && (await server.valuesFor("CONTACT", ashaId)).birthday === "1990-05-01", errorOf(asha));
    as(outsider);
    const outsiderContact = await companies.updateContactCustomFields(ashaId, { birthday: "2000-01-01" });
    ok("somebody outside the account can't change a contact's fields", !outsiderContact.ok, errorOf(outsiderContact));
    as(exec);
    const contactHits = (await contacts.listAllContactsPaged({ search: "1990-05", page: 1, pageSize: 20 })).rows.map((r) => r.id);
    ok("the contacts list's search finds her by the birthday's month", contactHits.includes(ashaId));

    section("A reseller's end customer: hidden contact fields left alone");
    const resellerCo = await db.company.create({
      data: { name: `${TAG} Reseller`, normalizedName: `${TAG} reseller`.toLowerCase(), createdById: owner.id, ownerUserId: exec.id, relationshipType: "RESELLER" },
      select: { id: true },
    });
    const endCustomer = await db.company.create({
      data: {
        name: `${TAG} End Customer`,
        normalizedName: `${TAG} end customer`.toLowerCase(),
        createdById: owner.id,
        ownerUserId: exec.id,
        relationshipType: "CLIENT",
        managedByResellerId: resellerCo.id,
      },
      select: { id: true },
    });
    const hidden = await db.contact.create({
      data: { companyId: endCustomer.id, name: "Ravi Kumar", designation: "OTHER", createdByUserId: owner.id, customFields: { alternate_phone: "+91 90000 00000" } },
      select: { id: true },
    });
    const bare = await db.contact.create({ data: { companyId: endCustomer.id, name: "Meera Iyer", designation: "OTHER", createdByUserId: owner.id }, select: { id: true } });
    as(admin);
    await settings.saveCustomFieldDefinition(field({ id: altPhone, entity: "CONTACT", label: "Alternate phone", type: "PHONE", required: true }));
    as(exec);
    const keptHidden = await companies.updateContactCustomFields(hidden.id, { birthday: "1985-07-07", alternate_phone: "" });
    const ravi = await server.valuesFor("CONTACT", hidden.id);
    ok(
      "the executive's save leaves the hidden alternate phone as it was, whatever the form sent",
      keptHidden.ok && ravi.alternate_phone === "+91 90000 00000" && ravi.birthday === "1985-07-07",
      `${errorOf(keptHidden)} ${JSON.stringify(ravi)}`,
    );
    const requiredHidden = await companies.updateContactCustomFields(bare.id, { birthday: "1992-02-02" });
    ok("  and a required one they can't see doesn't stop the save", requiredHidden.ok, errorOf(requiredHidden));
    const ownCompanyContact = await companies.updateContactCustomFields(ashaId, { birthday: "1990-05-01" });
    ok("on an ordinary account the required alternate phone is asked for", !ownCompanyContact.ok && ownCompanyContact.error.includes("Alternate phone"), errorOf(ownCompanyContact));
    as(admin);
    await settings.saveCustomFieldDefinition(field({ id: altPhone, entity: "CONTACT", label: "Alternate phone", type: "PHONE", required: false }));

    section("A reseller's end customer: an edit keeps the email and phone it couldn't show");
    const kiran = await db.contact.create({
      data: { companyId: endCustomer.id, name: "Kiran Shah", designation: "OTHER", email: "kiran@endcustomer.example", phone: "+91 98000 11111", createdByUserId: owner.id },
      select: { id: true },
    });
    const kiranNow = () => db.contact.findUniqueOrThrow({ where: { id: kiran.id }, select: { designation: true, email: true, phone: true } });
    const contactEdit = (over: Record<string, unknown>) => companies.updateContact({ id: kiran.id, name: "Kiran Shah", designation: "DIRECTOR", ...over });
    as(exec);
    const asExecSees = (await companies.getCompany(endCustomer.id))?.contacts.find((c) => c.id === kiran.id);
    ok("the executive sees her email and phone hidden", asExecSees?.detailsRedacted === true && asExecSees.email === null && asExecSees.phone === null, JSON.stringify(asExecSees ?? null));
    // Saved as the form shows her to them: email and phone blank.
    const blindEdit = await contactEdit({ email: "", phone: "" });
    const afterBlind = await kiranNow();
    ok(
      "their edit changes the designation and leaves the email and phone as they were",
      blindEdit.ok && afterBlind.designation === "DIRECTOR" && afterBlind.email === "kiran@endcustomer.example" && afterBlind.phone === "+91 98000 11111",
      `${errorOf(blindEdit)} ${JSON.stringify(afterBlind)}`,
    );
    const overwrite = await contactEdit({ email: "someone@elsewhere.example", phone: "+91 90000 99999" });
    const afterOverwrite = await kiranNow();
    ok(
      "  nor can they replace what they can't see",
      overwrite.ok && afterOverwrite.email === "kiran@endcustomer.example" && afterOverwrite.phone === "+91 98000 11111",
      `${errorOf(overwrite)} ${JSON.stringify(afterOverwrite)}`,
    );
    as(owner);
    const seenEdit = await contactEdit({ email: "kiran.shah@endcustomer.example", phone: "" });
    const afterSeen = await kiranNow();
    ok(
      "somebody who may see them changes the email and clears the phone",
      seenEdit.ok && afterSeen.email === "kiran.shah@endcustomer.example" && afterSeen.phone === null,
      `${errorOf(seenEdit)} ${JSON.stringify(afterSeen)}`,
    );
    as(exec);
    const ashaEdit = (email: string, phone: string) => companies.updateContact({ id: ashaId, name: "Asha Rao", designation: "OTHER", email, phone });
    const ashaNow = () => db.contact.findUniqueOrThrow({ where: { id: ashaId }, select: { email: true, phone: true } });
    const ashaSet = await ashaEdit("asha@northwind.example", "+91 98111 22222");
    const ashaAfterSet = await ashaNow();
    ok(
      "on an ordinary account the executive still sets them",
      ashaSet.ok && ashaAfterSet.email === "asha@northwind.example" && ashaAfterSet.phone === "+91 98111 22222",
      `${errorOf(ashaSet)} ${JSON.stringify(ashaAfterSet)}`,
    );
    const ashaCleared = await ashaEdit("", "");
    const ashaAfterClear = await ashaNow();
    ok("  and clears them", ashaCleared.ok && ashaAfterClear.email === null && ashaAfterClear.phone === null, `${errorOf(ashaCleared)} ${JSON.stringify(ashaAfterClear)}`);

    section("A reseller's end customer: Settings → Data neither exports nor imports the hidden details");
    const SUNIL = { email: "sunil@endcustomer.example", phone: "+91 98000 22222", alternate_phone: "+91 98000 33333" };
    const sunil = await db.contact.create({
      data: {
        companyId: endCustomer.id,
        name: "Sunil Menon",
        designation: "OTHER",
        email: SUNIL.email,
        phone: SUNIL.phone,
        emailStatus: "VALID",
        createdByUserId: owner.id,
        customFields: { alternate_phone: SUNIL.alternate_phone },
      },
      select: { id: true },
    });
    await db.contact.create({
      data: {
        companyId: northwind,
        name: "Nisha Rao",
        designation: "OTHER",
        email: "nisha@northwind.example",
        phone: "+91 98111 44444",
        createdByUserId: owner.id,
        customFields: { alternate_phone: "+91 98111 55555" },
      },
      select: { id: true },
    });
    const sunilNow = async () => ({
      ...(await db.contact.findUniqueOrThrow({ where: { id: sunil.id }, select: { designation: true, email: true, phone: true } })),
      alternate_phone: (await server.valuesFor("CONTACT", sunil.id)).alternate_phone,
    });
    const contactsFor = async (u: { id: string }) => (await contactsExporter({ userId: u.id, ownerUserIds: null })) as Record<string, unknown>[];
    const byName = (rows: Record<string, unknown>[], name: string) => rows.find((r) => r.Name === name);
    const execContacts = await contactsFor(exec);
    const execSunil = byName(execContacts, "Sunil Menon");
    ok(
      "the executive's export leaves her email, phone, email status and alternate phone blank",
      execSunil?.Email === "" && execSunil.Phone === "" && execSunil["Email status"] === "" && execSunil["Alternate phone"] === "",
      JSON.stringify(execSunil ?? null),
    );
    const execNisha = byName(execContacts, "Nisha Rao");
    ok(
      "  but not on an ordinary account's contact",
      execNisha?.Email === "nisha@northwind.example" && execNisha.Phone === "+91 98111 44444" && execNisha["Alternate phone"] === "+91 98111 55555",
      JSON.stringify(execNisha ?? null),
    );
    // The whole account's export: its Contacts sheet, Sunil's row.
    const bundleSunil = async (u: { id: string }) =>
      ((await accountBundle(u.id, endCustomer.id))?.sheets.find((sh) => sh.name === "Contacts")?.rows as Record<string, unknown>[] | undefined)?.find(
        (r) => r.Name === "Sunil Menon",
      );
    const execBundle = await bundleSunil(exec);
    ok(
      "  and so does their export of the whole account",
      execBundle?.Email === "" && execBundle.Phone === "" && execBundle["Email status"] === "",
      JSON.stringify(execBundle ?? null),
    );
    as(owner);
    const ownerSunil = byName(await contactsFor(owner), "Sunil Menon");
    ok(
      "somebody who may see them exports them",
      ownerSunil?.Email === SUNIL.email && ownerSunil.Phone === SUNIL.phone && ownerSunil["Email status"] === "VALID" && ownerSunil["Alternate phone"] === SUNIL.alternate_phone,
      JSON.stringify(ownerSunil ?? null),
    );
    const ownerBundle = await bundleSunil(owner);
    ok("  the whole account's too", ownerBundle?.Email === SUNIL.email && ownerBundle.Phone === SUNIL.phone, JSON.stringify(ownerBundle ?? null));
    as(exec);

    const sheet = (rows: Record<string, unknown>[]) =>
      rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === null || v === undefined ? "" : String(v)])));
    const execSheet = sheet(execContacts);
    const roundTrip = await portability.plan("contacts", execSheet, exec.id);
    const sunilLine = execSheet.findIndex((r) => r.Name === "Sunil Menon") + 2;
    ok(
      "the executive's export imported straight back changes nothing, and says nothing about her",
      roundTrip.updates === 0 && roundTrip.errors === 0 && roundTrip.notices.length === 0,
      `${roundTrip.updates} updates, ${roundTrip.errors} errors, ${JSON.stringify(roundTrip.notices)} ${JSON.stringify(roundTrip.rows.filter((r) => r.action !== "skip").slice(0, 2))}`,
    );
    const typedIn = execSheet.map((r) =>
      r.Name === "Sunil Menon" ? { ...r, Designation: "CEO", Email: "someone@elsewhere.example", Phone: "+91 90000 11111", "Alternate phone": "+91 90000 22222" } : r,
    );
    const typedPlan = await portability.plan("contacts", typedIn, exec.id);
    const sunilPlanned = typedPlan.rows.find((r) => r.line === sunilLine);
    ok(
      "  with her details typed in, only the designation changes",
      sunilPlanned?.action === "update" && sunilPlanned.changes.length === 1 && sunilPlanned.changes[0]!.field === "Designation",
      JSON.stringify(sunilPlanned ?? null),
    );
    const previewText = JSON.stringify(typedPlan);
    ok(
      "  the preview shows nothing of what is stored",
      !previewText.includes(SUNIL.email) && !previewText.includes(SUNIL.phone) && !previewText.includes(SUNIL.alternate_phone),
    );
    ok(
      "  and says those cells were left as they are, on her row",
      typedPlan.notices.length === 1 && typedPlan.notices[0]!.text.includes("hidden from you") && typedPlan.notices[0]!.lines.join() === String(sunilLine),
      JSON.stringify(typedPlan.notices),
    );
    await portability.apply("contacts", typedIn, exec.id);
    const sunilAfterImport = await sunilNow();
    ok(
      "  and the import changes the designation only",
      sunilAfterImport.designation === "CEO" &&
        sunilAfterImport.email === SUNIL.email &&
        sunilAfterImport.phone === SUNIL.phone &&
        sunilAfterImport.alternate_phone === SUNIL.alternate_phone,
      JSON.stringify(sunilAfterImport),
    );
    const byEmail = await portability.plan("contacts", [{ Name: "Sunil Menon", Company: `${TAG} End Customer`, Email: SUNIL.email }], exec.id);
    ok(
      "a row naming her by email still finds her rather than adding a second Sunil",
      byEmail.creates === 0 && byEmail.errors === 0 && byEmail.rows[0]?.action === "skip",
      JSON.stringify(byEmail.rows),
    );
    as(owner);
    const ownerPlan = await portability.plan("contacts", typedIn, owner.id);
    const ownerSunilPlanned = ownerPlan.rows.find((r) => r.line === sunilLine);
    ok(
      "somebody who may see them imports them, the old values shown",
      ownerPlan.notices.length === 0 &&
        ownerSunilPlanned?.changes.some((ch) => ch.field === "Email" && ch.from === SUNIL.email && ch.to === "someone@elsewhere.example") === true &&
        ownerSunilPlanned.changes.some((ch) => ch.field === "Alternate phone" && ch.to === "+91 90000 22222"),
      JSON.stringify(ownerSunilPlanned ?? null),
    );
    await portability.apply("contacts", typedIn, owner.id);
    const sunilAfterOwner = await sunilNow();
    ok(
      "  and writes them",
      sunilAfterOwner.email === "someone@elsewhere.example" && sunilAfterOwner.phone === "+91 90000 11111" && sunilAfterOwner.alternate_phone === "+91 90000 22222",
      JSON.stringify(sunilAfterOwner),
    );

    // ── Leads ──────────────────────────────────────────────────────────────────────────────────
    section("Leads: the create form, the edit, and the search");
    as(admin);
    idOf(
      await settings.saveCustomFieldDefinition(
        field({ entity: "LEAD", label: "Budget band", type: "SELECT", options: [{ label: "Under 5 lakh" }, { label: "5 to 25 lakh" }], required: true, showInList: true }),
      ),
    );
    as(exec);
    const noBand = await leads.createLead({ companyId: northwind, title: `${TAG} Laptops refresh` });
    ok("a lead without its required budget band is refused", !noBand.ok && noBand.error.includes("Budget band"), errorOf(noBand));
    const lead = await leads.createLead({ companyId: northwind, title: `${TAG} Laptops refresh`, customFields: { budget_band: "5 to 25 lakh" } });
    const leadId = lead.ok ? (lead.data as { id: string }).id : "";
    ok("created with its band", lead.ok && (await server.valuesFor("LEAD", leadId)).budget_band === "f_5_to_25_lakh", errorOf(lead));
    as(outsider);
    const outsiderLead = await leads.updateLeadCustomFields(leadId, { budget_band: "Under 5 lakh" });
    ok("somebody outside the account can't change it", !outsiderLead.ok, errorOf(outsiderLead));
    as(exec);
    const leadHits = (await leads.listLeadsPaged({ search: "25 lakh", page: 1, pageSize: 20 })).rows.map((r) => r.id);
    ok("the leads list's search finds it by the band's label", leadHits.includes(leadId));

    // ── Orders ─────────────────────────────────────────────────────────────────────────────────
    section("Orders: the punch form, the edit, and the search");
    as(admin);
    idOf(await settings.saveCustomFieldDefinition(field({ entity: "ORDER", label: "Site code", required: true, showInList: true })));
    // The location the company was created with.
    const location = await db.companyLocation.findFirstOrThrow({ where: { companyId: northwind }, select: { id: true } });
    const punch = (customFields?: Record<string, unknown>) =>
      orders.createOrder({
        companyId: northwind,
        locationId: location.id,
        itemId: a1,
        quantity: 1,
        unitPrice: 1000,
        businessType: "NEW",
        watcherUserIds: [],
        expenses: [],
        ...(customFields ? { customFields } : {}),
      });
    as(exec);
    const noSite = await punch();
    ok("an order without its required site code is refused", !noSite.ok && noSite.error.includes("Site code"), errorOf(noSite));
    const punched = await punch({ site_code: "SITE-9" });
    const orderId = punched.ok ? punched.data.id : "";
    ok("punched with its site code", punched.ok && (await server.valuesFor("ORDER", orderId)).site_code === "SITE-9", errorOf(punched));
    as(outsider);
    const outsiderOrder = await orders.updateOrderCustomFields(orderId, { site_code: "X" });
    ok("somebody outside the account can't change it", !outsiderOrder.ok, errorOf(outsiderOrder));
    as(exec);
    const ownOrder = await orders.updateOrderCustomFields(orderId, { site_code: "SITE-10" });
    ok("the salesperson who punched it can", ownOrder.ok && (await server.valuesFor("ORDER", orderId)).site_code === "SITE-10", errorOf(ownOrder));
    const orderHits = (await orders.listOrdersPaged({ search: "site-10", page: 1, pageSize: 20 })).rows.map((r) => r.id);
    const byCustomer = (await orders.listOrdersPaged({ search: "Northwind", page: 1, pageSize: 20 })).rows.map((r) => r.id);
    ok("the orders list's search finds it by its site code, and still by the customer's name", orderHits.includes(orderId) && byCustomer.includes(orderId));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

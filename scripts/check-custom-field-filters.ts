/**
 * check:custom-field-filters — the lists narrowed by the workspace's own fields, and those fields as
 * columns somebody chooses (owner, 2 Oct 2026): src/lib/custom-fields/filters.ts, the list actions that
 * take its clauses, the "Fields" panel (src/components/custom-fields/custom-field-filters.tsx), and the
 * column picker's field choices (src/lib/tables/registry.ts, src/components/ui/table-columns.tsx).
 *
 * The pure part needs no database: the stored column choices — `cf.<key>` shown, `-cf.<key>` hidden,
 * nothing stored for a field that follows its default — normalised and resolved, and a field added
 * after somebody customised a table arriving as its own default; the URL read; what each type of
 * filter means, and the clauses it becomes.
 *
 * The rest builds a scratch workspace database beside the real one (as check:custom-fields does),
 * drives the real list actions and pages as a workspace pointed at it, and drops it at the end, pass
 * or fail:
 *
 *   · the engine: a yes-or-no "no" that keeps the records nobody answered (and the plain NOT that
 *     loses them), a date range on yyyy-mm-dd text with both days in, % and _ taken as themselves;
 *   · companies: every type of filter; beside the category filter and the search, all applying;
 *     a restricted field's filter ignored for somebody who can't see it — the list as if unfiltered,
 *     neither empty nor narrowed — and honoured for somebody who can; an unknown or retired field
 *     ignored; the total always the rows' own;
 *   · customers, vendors with their onboarding count, commission parties, resellers with their
 *     end-customer tally, leads on the board and in the list, orders with the awaiting-approval
 *     badge, products, and contacts, where a contact-detail field's filter stays off a reseller's end
 *     customer for somebody who can't see those details;
 *   · the pages: each passes the filters on, links that rebuild their query keep them, the panel is
 *     there with its count, and what the panel writes reads back as what was asked;
 *   · the columns: every visible field with its default, the preference stored through the real
 *     action, a new field arriving for somebody who customised before, and the table and the picker
 *     drawn — the header, every row and the empty row's colSpan agreeing;
 *   · and the real workspace untouched.
 *
 *   npm run check:custom-field-filters
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createElement, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import type { PrismaClient } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";
import { normalizeCompanyName } from "../src/lib/company-name";
import { isDefaultSelection, normaliseSelection, resolveColumns, showsField } from "../src/lib/tables/registry";
import type { CustomFieldDef } from "../src/lib/custom-fields/rules";
import type { CustomFilterInput, CustomFilterInputs } from "../src/lib/custom-fields/filters";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const errorOf = (r: { ok: boolean; error?: string }) => (r.ok ? "ok" : r.error);
/** Two lists with the same members, in any order. */
const same = (a: Iterable<string>, b: Iterable<string>) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const json = (v: unknown) => JSON.stringify(v);

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

const TAG = "ZZCFF";

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
  usePathname: () => "/companies",
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

/** Every element of one type in a page's tree, as written — the page's own JSX, not what its children render. */
function findElements(node: ReactNode, type: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findElements(child as ReactNode, type, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  if (node.type === type) out.push(node);
  findElements((node.props as { children?: ReactNode }).children, type, out);
  return out;
}

/** Every element in a page's tree whose props pass `test` — links, by the shape of their `href`. */
function findByProps(node: ReactNode, test: (props: Record<string, unknown>) => boolean, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findByProps(child as ReactNode, test, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  if (test(node.props as Record<string, unknown>)) out.push(node);
  findByProps((node.props as { children?: ReactNode }).children, test, out);
  return out;
}

// ── The pure part: column choices ───────────────────────────────────────────────────────────────

function pureColumns() {
  section("Column choices: stored, normalised, resolved");
  const fields = [
    { key: "region", default: true },
    { key: "vip", default: false },
    { key: "notes", default: false },
  ];
  const builtIn = resolveColumns("companies", null);
  ok(
    "never customised: the registry's defaults, then the fields marked for the list",
    json(resolveColumns("companies", null, fields)) === json([...builtIn, "cf.region"]),
    json(resolveColumns("companies", null, fields)),
  );
  const stored = normaliseSelection("companies", [
    "select",
    "id",
    "company",
    "status",
    "cf.vip",
    "-cf.region",
    "cf.vip",
    "junk",
    "cf.Bad",
    "cf.",
    "-cf.notes",
    "cf.notes",
    42 as unknown as string,
  ]);
  ok(
    "normalised: the table's own keys (required ones implied), one choice per field — the later — and nothing else",
    json(stored) === json(["id", "status", "cf.vip", "-cf.region", "cf.notes"]),
    json(stored),
  );
  ok(
    "resolved: the choices made, the required columns, in the registry's order then the workspace's",
    json(resolveColumns("companies", stored, fields)) === json(["select", "id", "company", "status", "cf.vip", "cf.notes"]),
    json(resolveColumns("companies", stored, fields)),
  );
  const later = [...fields, { key: "segment", default: true }, { key: "extra", default: false }];
  ok(
    "a field added after somebody customised arrives as its own default — shown when marked for the list, not otherwise",
    resolveColumns("companies", stored, later).includes("cf.segment") && !resolveColumns("companies", stored, later).includes("cf.extra"),
    json(resolveColumns("companies", stored, later)),
  );
  ok(
    "a field's choice read alone: theirs when made, the default when not, the default for somebody who never chose",
    showsField(stored, "vip", false) && !showsField(stored, "region", true) && showsField(stored, "segment", true) && showsField(null, "x", true) && !showsField(null, "x", false),
  );
  const defaultsWritten = [...builtIn.filter((k) => !["select", "company"].includes(k)), "cf.region"];
  ok(
    "Reset is offered only when something differs: choices that match the defaults are still the defaults",
    isDefaultSelection("companies", null, fields) &&
      isDefaultSelection("companies", defaultsWritten, fields) &&
      !isDefaultSelection("companies", [...defaultsWritten, "-cf.region"], fields) &&
      !isDefaultSelection("companies", [...defaultsWritten, "cf.vip"], fields),
  );
  ok(
    "a table that shows no fields keeps no choices about them, and offers none",
    json(normaliseSelection("renewals", ["company", "cf.vip", "-cf.region"])) === json(["company"]) &&
      !resolveColumns("renewals", null, fields).some((k) => k.startsWith("cf.")),
    json(normaliseSelection("renewals", ["company", "cf.vip"])),
  );
  ok("a table the registry doesn't know has no columns at all", resolveColumns("nope", null, fields).length === 0);
}

// ── The scratch database ────────────────────────────────────────────────────────────────────────

async function main() {
  pureColumns();

  const realUrl = process.env.DATABASE_URL;
  if (!realUrl) throw new Error("DATABASE_URL is not set.");
  const host = new URL(realUrl).hostname;
  const realName = new URL(realUrl).pathname.slice(1);

  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratchName = `${realName}_cffilters`;
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
  ok("its field definitions, records and column preferences are as they were", realAfter.counts === realBefore.counts, realAfter.counts);
  ok("  and nothing of this suite's is in it", realAfter.tagged === 0 && realBefore.tagged === 0, realAfter.tagged);

  console.log(failures === 0 ? `\nAll ${passes} custom-field-filters checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/** What the suite must never change in the real workspace. Read-only. */
async function snapshot(client: PrismaClient) {
  const [definitions, companies, contacts, leads, orders, items, preferences, tagged] = await Promise.all([
    client.customFieldDefinition.count(),
    client.company.count(),
    client.contact.count(),
    client.lead.count(),
    client.companyProduct.count(),
    client.item.count(),
    client.tablePreference.count(),
    client.company.count({ where: { name: { startsWith: TAG } } }),
  ]);
  return { counts: JSON.stringify({ definitions, companies, contacts, leads, orders, items, preferences }), tagged };
}

// ── The suite ───────────────────────────────────────────────────────────────────────────────────

async function run(scratchUrl: string) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { Prisma } = require("@prisma/client") as typeof import("@prisma/client");
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
  const filters = require("../src/lib/custom-fields/filters") as typeof import("../src/lib/custom-fields/filters");
  const server = require("../src/lib/custom-fields/server") as typeof import("../src/lib/custom-fields/server");
  const settings = require("../src/actions/custom-fields") as typeof import("../src/actions/custom-fields");
  const companies = require("../src/actions/company") as typeof import("../src/actions/company");
  const contacts = require("../src/actions/contact") as typeof import("../src/actions/contact");
  const leads = require("../src/actions/lead") as typeof import("../src/actions/lead");
  const orders = require("../src/actions/order") as typeof import("../src/actions/order");
  const items = require("../src/actions/item") as typeof import("../src/actions/item");
  const preferences = require("../src/actions/table-preference") as typeof import("../src/actions/table-preference");
  const { filterQuery, CustomFieldFilters } = require("../src/components/custom-fields/custom-field-filters") as typeof import("../src/components/custom-fields/custom-field-filters");
  const { TableColumnsProvider, ColumnPicker } = require("../src/components/ui/table-columns") as typeof import("../src/components/ui/table-columns");
  const { CompaniesTable } = require("../src/components/companies/companies-table") as typeof import("../src/components/companies/companies-table");
  const { ResellersTable } = require("../src/components/resellers/resellers-table") as typeof import("../src/components/resellers/resellers-table");
  const { ContactsTable } = require("../src/components/contacts/contacts-table") as typeof import("../src/components/contacts/contacts-table");
  const { LeadsListTable } = require("../src/components/leads/leads-list-table") as typeof import("../src/components/leads/leads-list-table");
  const { LeadsBoard } = require("../src/components/leads/leads-board") as typeof import("../src/components/leads/leads-board");
  const { ViewToggle } = require("../src/components/leads/view-toggle") as typeof import("../src/components/leads/view-toggle");
  const { OrdersTable } = require("../src/components/orders/orders-table") as typeof import("../src/components/orders/orders-table");
  const { ItemsTable } = require("../src/components/items/items-table") as typeof import("../src/components/items/items-table");
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  type Page = (p: unknown) => Promise<ReactElement>;
  const page = (path: string) => (require(`../src/app/(dashboard)/${path}/page`) as { default: Page }).default;
  /* eslint-enable @typescript-eslint/no-require-imports */

  pureFilters(filters, Prisma);

  const tenant = {
    id: randomUUID(),
    slug: "zzcffilters",
    name: "zzcffilters",
    status: "ACTIVE" as const,
    dbUrl: scratchUrl,
    primaryHost: "zzcffilters.localhost",
    hosts: ["zzcffilters.localhost"],
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
    const base = { "companies.viewAll": true, "leads.view": true, "contacts.view": true, "orders.view": true, "fields.manage": false };
    const owner = await user("Owner", {}, { isSuperAdmin: true, role: "ADMIN" });
    const manager = await user("Manager", { ...base, "fields.manage": true, "fields.seeRestricted": true, "contacts.viewRestricted": true });
    const exec = await user("Executive", { ...base, "fields.seeRestricted": false, "contacts.viewRestricted": false });
    const as = (u: { id: string; name: string; email: string; role: string }) => {
      actor = u;
    };

    as(manager);
    const field = (over: Record<string, unknown>) => ({
      entity: "COMPANY",
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
    const define = async (over: Record<string, unknown>) => idOf(await settings.saveCustomFieldDefinition(field(over)));
    await define({ label: "Region", type: "SELECT", options: [{ label: "North" }, { label: "South" }, { label: "East" }], showInList: true });
    await define({ label: "Focus areas", type: "MULTI_SELECT", options: [{ label: "Cloud" }, { label: "Security" }, { label: "Hardware" }] });
    await define({ label: "VIP", type: "CHECKBOX" });
    await define({ label: "Account lead", type: "USER" });
    await define({ label: "Notes" });
    await define({ label: "Renewal due", type: "DATE" });
    await define({ label: "Credit limit", type: "MONEY" });
    await define({ label: "Internal rating", restricted: true, showInList: true });
    const legacy = await define({ label: "Legacy code" });
    await define({ entity: "LEAD", label: "Priority", type: "SELECT", options: [{ label: "High" }, { label: "Low" }], showInList: true });
    await define({ entity: "LEAD", label: "Decision date", type: "DATE" });
    await define({ entity: "ORDER", label: "Site code", showInList: true });
    await define({ entity: "ORDER", label: "Installed", type: "CHECKBOX" });
    await define({ entity: "ITEM", label: "Batch no.", showInList: true });
    await define({ entity: "ITEM", label: "Warranty months", type: "NUMBER" });
    await define({ entity: "ITEM", label: "Grade", type: "SELECT", options: [{ label: "Gold" }, { label: "Silver" }] });
    await define({ entity: "CONTACT", label: "Alternate email", type: "EMAIL" });
    await define({ entity: "CONTACT", label: "Birthday", type: "DATE" });
    const keys = (await db.customFieldDefinition.findMany({ orderBy: [{ entity: "asc" }, { sortOrder: "asc" }], select: { entity: true, key: true } }))
      .map((d) => `${d.entity}:${d.key}`)
      .join(",");
    ok(
      "fields on every record type, keyed from their labels",
      keys ===
        "COMPANY:region,COMPANY:focus_areas,COMPANY:vip,COMPANY:account_lead,COMPANY:notes,COMPANY:renewal_due,COMPANY:credit_limit,COMPANY:internal_rating,COMPANY:legacy_code," +
          "CONTACT:alternate_email,CONTACT:birthday,LEAD:priority,LEAD:decision_date,ORDER:site_code,ORDER:installed,ITEM:batch_no,ITEM:warranty_months,ITEM:grade",
      keys,
    );

    const strategic = await db.customerCategory.create({ data: { name: `${TAG} Strategic` }, select: { id: true } });
    const keyAccounts = await db.customerCategory.create({ data: { name: `${TAG} Key accounts`, parentId: strategic.id }, select: { id: true } });
    type CompanyExtras = {
      relationshipType?: "CLIENT" | "VENDOR" | "COMMISSION_PARTY" | "RESELLER";
      vendorStatus?: "ONBOARDING" | "ACTIVE";
      customerCategoryId?: string;
      managedByResellerId?: string;
    };
    const company = async (name: string, customFields: Record<string, unknown>, extra: CompanyExtras = {}) =>
      (
        await db.company.create({
          data: {
            name: `${TAG} ${name}`,
            normalizedName: normalizeCompanyName(`${TAG} ${name}`),
            createdById: owner.id,
            ownerUserId: exec.id,
            relationshipType: extra.relationshipType ?? "CLIENT",
            vendorStatus: extra.vendorStatus,
            customerCategoryId: extra.customerCategoryId,
            managedByResellerId: extra.managedByResellerId,
            customFields: customFields as never,
          },
          select: { id: true },
        })
      ).id;
    const A = await company(
      "Alpha",
      {
        region: "north",
        focus_areas: ["cloud", "security"],
        vip: true,
        account_lead: exec.id,
        notes: "Prefers 50% advance",
        renewal_due: "2026-03-15",
        credit_limit: 100000,
        internal_rating: "A+",
        legacy_code: "L1",
      },
      { customerCategoryId: strategic.id },
    );
    const B = await company("Beta", {
      region: "south",
      focus_areas: ["hardware"],
      vip: false,
      notes: "Pays a_b on time",
      renewal_due: "2026-03-31",
      credit_limit: 250000.5,
      internal_rating: "B",
    });
    // Never answered a thing.
    const C = await company("Gamma", {}, { customerCategoryId: keyAccounts.id });
    // A yes-or-no somebody's script set to null.
    const D = await company("Delta", { region: "north", notes: "axb", renewal_due: "2026-04-01", credit_limit: 500, vip: null });
    // And one set to the word rather than the answer — still not a yes.
    const E = await company("Epsilon", { region: "east", notes: "500 off", renewal_due: "2026-02-28", vip: "true" });
    const clients = [A, B, C, D, E];

    const V1 = await company("Vendor One", { region: "north" }, { relationshipType: "VENDOR", vendorStatus: "ONBOARDING" });
    const V2 = await company("Vendor Two", { region: "south" }, { relationshipType: "VENDOR", vendorStatus: "ACTIVE" });
    const V3 = await company("Vendor Three", { region: "south" }, { relationshipType: "VENDOR", vendorStatus: "ONBOARDING" });
    const P1 = await company("Agent One", { region: "north" }, { relationshipType: "COMMISSION_PARTY" });
    const P2 = await company("Agent Two", { region: "south" }, { relationshipType: "COMMISSION_PARTY" });
    const R1 = await company("Reseller One", { region: "north" }, { relationshipType: "RESELLER" });
    const R2 = await company("Reseller Two", { region: "south" }, { relationshipType: "RESELLER" });
    const EC1 = await company("End Customer One", { region: "north" }, { managedByResellerId: R1 });
    await company("End Customer Two", {}, { managedByResellerId: R1 });
    await company("End Customer Three", {}, { managedByResellerId: R2 });

    const item = async (sku: string, customFields: Record<string, unknown>) =>
      (
        await db.item.create({
          data: { name: `${TAG} ${sku}`, sku: `${TAG}-${sku}`, type: "SERVICE", sellingPrice: 1000, createdById: owner.id, customFields: customFields as never },
          select: { id: true },
        })
      ).id;
    const I1 = await item("I1", { batch_no: "B-1", warranty_months: 12, grade: "gold" });
    const I2 = await item("I2", { batch_no: "B-2", warranty_months: 24, grade: "silver" });
    const I3 = await item("I3", {});

    const location = async (companyId: string) => (await db.companyLocation.create({ data: { companyId, label: "Head Office" }, select: { id: true } })).id;
    const locA = await location(A);
    const locB = await location(B);
    const order = async (companyId: string, locationId: string, customFields: Record<string, unknown>) =>
      (await db.companyProduct.create({ data: { companyId, locationId, itemId: I1, quantity: 1, addedByUserId: exec.id, customFields: customFields as never }, select: { id: true } })).id;
    const O1 = await order(A, locA, { site_code: "SITE-9", installed: true });
    const O2 = await order(B, locB, { site_code: "SITE-10", installed: false });
    const O3 = await order(A, locA, {});

    const lead = async (companyId: string, title: string, customFields: Record<string, unknown>) =>
      (await db.lead.create({ data: { companyId, title: `${TAG} ${title}`, ownerUserId: exec.id, customFields: customFields as never }, select: { id: true } })).id;
    const L1 = await lead(A, "Laptops", { priority: "high", decision_date: "2026-05-10" });
    const L2 = await lead(B, "Servers", { priority: "low", decision_date: "2026-06-01" });
    const L3 = await lead(C, "Printers", {});

    const contact = async (companyId: string, name: string, customFields: Record<string, unknown>) =>
      (await db.contact.create({ data: { companyId, name, designation: "OTHER", createdByUserId: owner.id, customFields: customFields as never }, select: { id: true } })).id;
    const K1 = await contact(A, "Kavya Iyer", { alternate_email: "kavya@example.com", birthday: "1990-05-01" });
    // On a reseller's end customer: her contact details are hidden from the executive.
    const K2 = await contact(EC1, "Kabir Shah", { alternate_email: "kabir@example.com", birthday: "1991-05-01" });
    const K3 = await contact(B, "Karan Mehta", {});
    ok("companies, vendors, agents, resellers and their end customers, products, orders, leads and contacts, all answering differently", !!K3 && !!L3 && !!I3);

    const cf = (entries: CustomFilterInputs) => entries;
    const fixtureOnly = (ids: string[], among: string[]) => ids.filter((id) => among.includes(id));

    // ── The engine ─────────────────────────────────────────────────────────────────────────────
    section("The engine: what the clauses mean here");
    const among = async (where: Record<string, unknown>) =>
      fixtureOnly((await db.company.findMany({ where: { AND: [{ id: { in: clients } }, where] } as never, select: { id: true } })).map((c) => c.id), clients);
    const vipDef = (await server.definitionsFor("COMPANY")).find((d) => d.key === "vip")!;
    const noClause = filters.filterClauses(vipDef, { kind: "no" })[0]!;
    const plainNot = await among({ NOT: { customFields: { path: ["vip"], equals: true } } });
    ok(
      "a plain NOT loses the records nobody answered — a missing key is NULL, and NOT NULL is NULL",
      same(plainNot, [B, D, E]) && !plainNot.includes(C),
      `${plainNot.length} of 4`,
    );
    ok("  so “No” says “or never answered” too, and keeps them: false, never set, set to nothing, set to a word", same(await among(noClause), [B, C, D, E]));
    ok("  and “Yes” is a yes and nothing else", same(await among(filters.filterClauses(vipDef, { kind: "yes" })[0]!), [A]));
    const dueDef = (await server.definitionsFor("COMPANY")).find((d) => d.key === "renewal_due")!;
    const days = async (from: string | null, to: string | null) => among({ AND: filters.filterClauses(dueDef, { kind: "days", from, to }) });
    ok("a date range on the stored yyyy-mm-dd text, both days included", same(await days("2026-03-15", "2026-03-31"), [A, B]));
    ok("  from a day alone, and to a day alone", same(await days("2026-03-16", null), [B, D]) && same(await days(null, "2026-02-28"), [E]));
    const notesDef = (await server.definitionsFor("COMPANY")).find((d) => d.key === "notes")!;
    const words = async (text: string) => among(filters.filterClauses(notesDef, { kind: "text", text })[0]!);
    ok("% and _ typed into a filter mean themselves, not LIKE's wildcards", same(await words("50%"), [A]) && same(await words("a_b"), [B]), `${(await words("50%")).length} / ${(await words("a_b")).length}`);
    ok("  and the words are found in any case", same(await words("ADVANCE"), [A]));

    // ── Companies ──────────────────────────────────────────────────────────────────────────────
    section("Companies: each type of filter, through the list action");
    as(exec);
    const companyList = async (customFilters: CustomFilterInputs, extra: Record<string, unknown> = {}) => {
      const result = await companies.listCompaniesPaged({ page: 1, pageSize: 100, customFilters: cf(customFilters), ...extra });
      return { ids: fixtureOnly(result.rows.map((r) => r.id), clients), total: result.total, rows: result.rows.length };
    };
    const unfiltered = await companyList({});
    ok("unfiltered: the five clients, not the vendors, agents, resellers or end customers", same(unfiltered.ids, clients), unfiltered.ids.length);
    const expectList = async (label: string, customFilters: CustomFilterInputs, expected: string[], extra: Record<string, unknown> = {}) => {
      const got = await companyList(customFilters, extra);
      ok(label, same(got.ids, expected) && got.total === got.rows, `${got.ids.length} rows, total ${got.total}`);
    };
    await expectList("a dropdown, one option", { region: { value: "north" } }, [A, D]);
    await expectList("  any of several", { region: { value: "north,south" } }, [A, B, D]);
    await expectList("  an option the field doesn't have is no filter at all", { region: { value: "west" } }, clients);
    await expectList("a multi-select, any of the options", { focus_areas: { value: "security,hardware" } }, [A, B]);
    await expectList("yes", { vip: { value: "yes" } }, [A]);
    await expectList("no — the nobody-answered ones included", { vip: { value: "no" } }, [B, C, D, E]);
    await expectList("a person", { account_lead: { value: exec.id } }, [A]);
    await expectList("text, in any case, % meaning %", { notes: { value: "50%" } }, [A]);
    await expectList("a date range, both days in", { renewal_due: { from: "2026-03-15", to: "2026-03-31" } }, [A, B]);
    await expectList("an amount range, both ends in, typed the Indian way", { credit_limit: { min: "1,00,000", max: "2,50,000.50" } }, [A, B]);
    await expectList("several fields at once: every one applies", { region: { value: "north,south" }, vip: { value: "no" }, credit_limit: { min: "1000" } }, [B]);

    section("Companies: beside the list's own filters and the search");
    await expectList("the category filter alone takes in its sub-category", {}, [A, C], { categoryId: strategic.id });
    await expectList("  with a field filter beside it, both apply — neither drops the other", { region: { value: "north" } }, [A], { categoryId: strategic.id });
    await expectList("  a “No” beside it, its own OR and the category's both kept", { vip: { value: "no" } }, [C], { categoryId: strategic.id });
    await expectList("the search and a field filter together", { vip: { value: "no" } }, [B], { search: "South" });
    await expectList("  the search by name, narrowed by a field", { region: { value: "north" } }, [D], { search: `${TAG} Delta` });
    const paged = await companies.listCompaniesPaged({ page: 1, pageSize: 1, customFilters: cf({ region: { value: "north" } }) });
    ok("the pager's total counts the filtered list, not the page", paged.total === 2 && paged.rows.length === 1, `total ${paged.total}`);

    section("Companies: fields somebody can't see, doesn't have, or has retired");
    await expectList("a restricted field, for somebody who can't see it: ignored — the whole list, not an empty one", { internal_rating: { value: "A+" } }, clients);
    as(manager);
    await expectList("  for somebody who can: it narrows", { internal_rating: { value: "A+" } }, [A]);
    as(exec);
    await expectList("a field that doesn't exist: ignored", { no_such_field: { value: "x" } }, clients);
    await expectList("a retired field, before it was retired, narrowed", { legacy_code: { value: "L1" } }, [A]);
    as(manager);
    await settings.archiveCustomFieldDefinition(legacy);
    as(exec);
    await expectList("  and once retired, ignored", { legacy_code: { value: "L1" } }, clients);
    await expectList("garbage sent to the action: ignored, never an error", { region: "north" as unknown as CustomFilterInput, vip: { value: 7 as unknown as string } }, clients);
    const outright = await companies.listCompaniesPaged({ page: 1, pageSize: 100, customFilters: "x" as never });
    ok("  even no object at all", same(fixtureOnly(outright.rows.map((r) => r.id), clients), clients));

    section("Customers, vendors, commission parties and resellers");
    const customerIds = fixtureOnly((await companies.listCustomersPaged({ page: 1, pageSize: 100, customFilters: cf({ region: { value: "north" } }) })).rows.map((r) => r.id), clients);
    ok("customers: the ones with orders, narrowed by a field", same(customerIds, [A]), customerIds.length);
    const vendors = [V1, V2, V3];
    const vendorIds = fixtureOnly((await companies.listVendorsPaged({ page: 1, pageSize: 100, customFilters: cf({ region: { value: "north" } }) })).rows.map((r) => r.id), vendors);
    ok("vendors narrowed by a field", same(vendorIds, [V1]), vendorIds.length);
    const onboardingAll = await companies.countVendorsOnboarding({});
    const onboardingSouth = await companies.countVendorsOnboarding({ customFilters: cf({ region: { value: "south" } }) });
    ok("  and the onboarding count is of the same filtered list", onboardingAll - onboardingSouth === 1, `${onboardingAll} → ${onboardingSouth}`);
    const agentIds = fixtureOnly(
      (await companies.listVendorsPaged({ page: 1, pageSize: 100, relationshipType: "COMMISSION_PARTY", customFilters: cf({ region: { value: "south" } }) })).rows.map((r) => r.id),
      [P1, P2],
    );
    ok("commission parties narrowed by a field", same(agentIds, [P2]), agentIds.length);
    const resellersAll = await companies.listResellersPaged({ page: 1, pageSize: 100 });
    const resellersNorth = await companies.listResellersPaged({ page: 1, pageSize: 100, customFilters: cf({ region: { value: "north" } }) });
    ok("resellers narrowed by a field", same(fixtureOnly(resellersNorth.rows.map((r) => r.id), [R1, R2]), [R1]));
    ok(
      "  and the end-customer tally counts the filtered resellers' only",
      resellersAll.endCustomerTotal - resellersNorth.endCustomerTotal === 1,
      `${resellersAll.endCustomerTotal} → ${resellersNorth.endCustomerTotal}`,
    );

    // ── Leads, orders, products, contacts ──────────────────────────────────────────────────────
    section("Leads: the list and the board");
    const leadFixture = [L1, L2, L3];
    const leadList = await leads.listLeadsPaged({ page: 1, pageSize: 100, customFilters: cf({ priority: { value: "high" } }) });
    ok("the list narrowed by a dropdown, its total its own", same(fixtureOnly(leadList.rows.map((r) => r.id), leadFixture), [L1]) && leadList.total === leadList.rows.length);
    const board = await leads.listLeads({ customFilters: cf({ priority: { value: "high" } }) });
    ok("  the board by the same filter", same(fixtureOnly(board.map((r) => r.id), leadFixture), [L1]));
    const byDecision = await leads.listLeadsPaged({ page: 1, pageSize: 100, search: TAG, customFilters: cf({ decision_date: { to: "2026-05-31" } }) });
    ok("  and by a date, with the search beside it", same(fixtureOnly(byDecision.rows.map((r) => r.id), leadFixture), [L1]));

    section("Orders, with the awaiting-approval badge");
    const orderFixture = [O1, O2, O3];
    const notInstalled = await orders.listOrdersPaged({ page: 1, pageSize: 100, customFilters: cf({ installed: { value: "no" } }) });
    ok("“No” on a yes-or-no: the unticked and the never-answered", same(fixtureOnly(notInstalled.rows.map((r) => r.id), orderFixture), [O2, O3]));
    ok("  the total and the badge counted from the same filtered list", notInstalled.total === 2 && notInstalled.pendingApproval === 2, `${notInstalled.total} / ${notInstalled.pendingApproval}`);
    await db.companyProduct.update({ where: { id: O3 }, data: { orderStatus: "APPROVED" } });
    const afterApproval = await orders.listOrdersPaged({ page: 1, pageSize: 100, customFilters: cf({ installed: { value: "no" } }) });
    ok("  one approved: still in the list, out of the badge", afterApproval.total === 2 && afterApproval.pendingApproval === 1, `${afterApproval.total} / ${afterApproval.pendingApproval}`);
    const site = await orders.listOrdersPaged({ page: 1, pageSize: 100, customFilters: cf({ site_code: { value: "site-1" } }) });
    ok("text in a field", same(fixtureOnly(site.rows.map((r) => r.id), orderFixture), [O2]));

    section("Products");
    const itemFixture = [I1, I2, I3];
    const warranty = await items.listItems({ customFilters: cf({ warranty_months: { min: "13" } }) });
    ok("a number at least", same(fixtureOnly(warranty.items.map((i) => i.id), itemFixture), [I2]) && warranty.total === warranty.items.length);
    const gold = await items.listItems({ customFilters: cf({ grade: { value: "gold" } }), search: `${TAG}` });
    ok("  a dropdown, with the search beside it", same(fixtureOnly(gold.items.map((i) => i.id), itemFixture), [I1]));

    section("Contacts: a reseller's end customer's hidden details stay hidden");
    const contactFixture = [K1, K2, K3];
    const contactIds = async (customFilters: CustomFilterInputs) =>
      fixtureOnly((await contacts.listAllContactsPaged({ page: 1, pageSize: 100, customFilters: cf(customFilters) })).rows.map((r) => r.id), contactFixture);
    as(exec);
    ok(
      "a contact-detail field's filter never matches an end customer's contact for somebody who can't see those details",
      same(await contactIds({ alternate_email: { value: "example.com" } }), [K1]),
    );
    ok("  a field that isn't a contact detail still does", same(await contactIds({ birthday: { from: "1990-01-01" } }), [K1, K2]));
    as(manager);
    ok("  and for somebody who may see them, the end customer's contact matches too", same(await contactIds({ alternate_email: { value: "example.com" } }), [K1, K2]));
    as(exec);

    // ── The pages ──────────────────────────────────────────────────────────────────────────────
    section("The pages pass the filters on and keep them in their links");
    const query = (props: Record<string, unknown>) => (props.href as { query?: Record<string, string> } | undefined)?.query;
    const chips = (tree: ReactElement) => findByProps(tree, (p) => typeof p.href === "object" && p.href !== null && "query" in (p.href as object));
    const CompaniesPage = page("companies");
    const companiesTree = await CompaniesPage({ searchParams: Promise.resolve({ "cf.region": "north" }) });
    const table = findElements(companiesTree, CompaniesTable)[0]?.props as ComponentProps<typeof CompaniesTable> | undefined;
    ok("/companies: the table gets the filtered list", !!table && same(fixtureOnly(table.companies.map((c) => c.id), clients), [D]), json(table?.companies.map((c) => c.name)));
    const companyChips = chips(companiesTree);
    ok(
      "  every stage chip keeps the field filter",
      companyChips.length >= 5 && companyChips.every((c) => query(c.props as Record<string, unknown>)?.["cf.region"] === "north"),
      `${companyChips.length} chips`,
    );
    const panel = findElements(companiesTree, CustomFieldFilters)[0]?.props as ComponentProps<typeof CustomFieldFilters> | undefined;
    ok(
      "  the Fields panel is there, counting one filter, its field showing what was asked",
      panel?.setup.active === 1 && json(panel.setup.fields.find((f) => f.key === "region")?.current) === json({ values: ["north"] }),
      json(panel?.setup.fields.find((f) => f.key === "region")),
    );
    ok("  and offers the executive's fields — the restricted one and the retired one not among them", !!panel && !panel.setup.fields.some((f) => f.key === "internal_rating" || f.key === "legacy_code"));
    const picker = findElements(companiesTree, ColumnPicker)[0]?.props as ComponentProps<typeof ColumnPicker> | undefined;
    ok(
      "  the column picker is offered every field the executive sees, each with its default",
      json(picker?.customColumns?.map((c) => `${c.key}:${c.default}`)) ===
        json(["region:true", "focus_areas:false", "vip:false", "account_lead:false", "notes:false", "renewal_due:false", "credit_limit:false"]),
      json(picker?.customColumns?.map((c) => `${c.key}:${c.default}`)),
    );

    const customersTree = await page("customers")({ searchParams: Promise.resolve({ "cf.region": "north" }) });
    const customersTable = findElements(customersTree, CompaniesTable)[0]?.props as ComponentProps<typeof CompaniesTable> | undefined;
    ok("/customers: filtered", !!customersTable && same(fixtureOnly(customersTable.companies.map((c) => c.id), clients), [A]));
    const vendorsTree = await page("vendors")({ searchParams: Promise.resolve({ "cf.region": "south" }) });
    const vendorsTable = findElements(vendorsTree, CompaniesTable)[0]?.props as ComponentProps<typeof CompaniesTable> | undefined;
    ok("/vendors: filtered", !!vendorsTable && same(fixtureOnly(vendorsTable.companies.map((c) => c.id), vendors), [V2, V3]));
    const agentsTree = await page("commission-parties")({ searchParams: Promise.resolve({ "cf.region": "north" }) });
    const agentsTable = findElements(agentsTree, CompaniesTable)[0]?.props as ComponentProps<typeof CompaniesTable> | undefined;
    ok("/commission-parties: filtered", !!agentsTable && same(fixtureOnly(agentsTable.companies.map((c) => c.id), [P1, P2]), [P1]));
    const resellersTree = await page("resellers")({ searchParams: Promise.resolve({ "cf.region": "south" }) });
    const resellersTable = findElements(resellersTree, ResellersTable)[0]?.props as { resellers: { id: string }[] } | undefined;
    ok(
      "/resellers: filtered, with the panel",
      !!resellersTable && same(fixtureOnly(resellersTable.resellers.map((r) => r.id), [R1, R2]), [R2]) && findElements(resellersTree, CustomFieldFilters).length === 1,
    );
    const contactsTree = await page("contacts")({ searchParams: Promise.resolve({ "cf.birthday.from": "1990-01-01" }) });
    const contactsTable = findElements(contactsTree, ContactsTable)[0]?.props as ComponentProps<typeof ContactsTable> | undefined;
    ok("/contacts: filtered", !!contactsTable && same(fixtureOnly(contactsTable.contacts.map((c) => c.id), contactFixture), [K1, K2]));

    const LeadsPage = page("leads");
    const leadsTree = await LeadsPage({ searchParams: Promise.resolve({ view: "list", "cf.priority": "high" }) });
    const leadsTable = findElements(leadsTree, LeadsListTable)[0]?.props as ComponentProps<typeof LeadsListTable> | undefined;
    ok("/leads, the table: filtered", !!leadsTable && same(fixtureOnly(leadsTable.leads.map((l) => l.id), leadFixture), [L1]));
    const toggle = findElements(leadsTree, ViewToggle)[0]?.props as ComponentProps<typeof ViewToggle> | undefined;
    ok("  the board/table toggle carries the filter across", toggle?.otherParams["cf.priority"] === "high", json(toggle?.otherParams));
    const boardTree = await LeadsPage({ searchParams: Promise.resolve({ "cf.priority": "high" }) });
    const boardProps = findElements(boardTree, LeadsBoard)[0]?.props as { leads: { id: string }[] } | undefined;
    ok("  and the board is filtered too", !!boardProps && same(fixtureOnly(boardProps.leads.map((l) => l.id), leadFixture), [L1]));

    const ordersTree = await page("orders")({ searchParams: Promise.resolve({ "cf.installed": "no" }) });
    const ordersTable = findElements(ordersTree, OrdersTable)[0]?.props as ComponentProps<typeof OrdersTable> | undefined;
    ok("/orders: filtered", !!ordersTable && same(fixtureOnly(ordersTable.orders.map((o) => o.id), orderFixture), [O2, O3]));
    const orderChips = chips(ordersTree);
    ok(
      "  every status and hand-off chip keeps the field filter",
      orderChips.length >= 7 && orderChips.every((c) => query(c.props as Record<string, unknown>)?.["cf.installed"] === "no"),
      `${orderChips.length} chips`,
    );

    const itemsTree = await page("items")({ searchParams: Promise.resolve({ "cf.warranty_months.min": "13", q: TAG }) });
    const itemsTable = findElements(itemsTree, ItemsTable)[0]?.props as ComponentProps<typeof ItemsTable> | undefined;
    ok("/items: filtered", !!itemsTable && same(fixtureOnly(itemsTable.items.map((i) => i.id), itemFixture), [I2]));
    ok("  its columns are the fields marked for the list — it has no picker", json(itemsTable?.customColumns?.columns.map((c) => c.key)) === json(["batch_no"]));
    const hidden = findByProps(itemsTree, (p) => p.type === "hidden" && p.name === "cf.warranty_months.min");
    ok("  the search form carries the filter", hidden.length === 1 && (hidden[0]!.props as { value?: string }).value === "13");
    const typeChips = chips(itemsTree);
    ok("  and so does every type chip", typeChips.length >= 5 && typeChips.every((c) => query(c.props as Record<string, unknown>)?.["cf.warranty_months.min"] === "13"));

    section("The panel writes what the server reads");
    const setup = await filters.customFilterSetup("COMPANY", exec.id, filters.parseCustomFilters({ "cf.region": "north", "cf.credit_limit.min": "abc" }));
    ok("what the URL asks, understood: one filter, the amount that isn't one left out", setup.active === 1 && json(setup.fields.find((f) => f.key === "credit_limit")?.current) === json({}));
    const drafts = {
      region: { values: ["north", "south"] },
      vip: { value: "no" },
      renewal_due: { from: "2026-03-01", to: "2026-03-31" },
      credit_limit: { min: "1000" },
      notes: { value: "  advance  " },
      account_lead: { value: "" },
    };
    const written = filterQuery("q=zz&cf.region=north&cf.internal_rating=A&page=3&pageSize=50", setup, drafts);
    const back = new URLSearchParams(written);
    ok(
      "the rest of the URL kept, the page dropped, every field filter written afresh — one the panel doesn't own swept",
      back.get("q") === "zz" && back.get("pageSize") === "50" && !back.has("page") && !back.has("cf.internal_rating") && !back.has("cf.account_lead"),
      written,
    );
    const reread = await filters.customFilterSetup("COMPANY", exec.id, filters.parseCustomFilters(back));
    const current = Object.fromEntries(reread.fields.filter((f) => Object.keys(f.current).length > 0).map((f) => [f.key, f.current]));
    ok(
      "  and read back, it is what was asked",
      reread.active === 5 &&
        json(current) ===
          json({ region: { values: ["north", "south"] }, vip: { value: "no" }, notes: { value: "advance" }, renewal_due: { from: "2026-03-01", to: "2026-03-31" }, credit_limit: { min: "1000" } }),
      json(current),
    );
    const cleared = filterQuery(written, setup, {});
    ok("Clear takes every field filter off and leaves the rest", cleared === "q=zz&pageSize=50", cleared);

    // ── Columns ────────────────────────────────────────────────────────────────────────────────
    section("Columns: every field a person sees, each with its default");
    const execColumns = await server.listColumns("COMPANY", exec.id, [A, B]);
    const managerColumns = await server.listColumns("COMPANY", manager.id, [A, B]);
    ok(
      "every visible field is a column to choose, the marked ones on by default; restricted ones only for those who may see them",
      json(execColumns.columns.map((c) => `${c.key}:${c.default}`)) ===
        json(["region:true", "focus_areas:false", "vip:false", "account_lead:false", "notes:false", "renewal_due:false", "credit_limit:false"]) &&
        managerColumns.columns.some((c) => c.key === "internal_rating" && c.default),
      json(managerColumns.columns.map((c) => `${c.key}:${c.default}`)),
    );
    ok(
      "  every row's values in words, for the columns not shown yet too",
      execColumns.texts[A]?.region === "North" && execColumns.texts[A]?.credit_limit === "₹1,00,000.00" && execColumns.texts[A]?.vip === "Yes" && execColumns.texts[B]?.vip === "No",
      json(execColumns.texts[A]),
    );
    ok("  and none of a restricted field's for somebody who can't see it", !("internal_rating" in (execColumns.texts[A] ?? {})));
    const listed = await server.listColumns("COMPANY", manager.id, [A], { listedOnly: true });
    ok("for a table without a picker, only the marked ones", json(listed.columns.map((c) => c.key)) === json(["region", "internal_rating"]), json(listed.columns.map((c) => c.key)));
    const none = await server.listColumns("COMPANY", exec.id, []);
    ok("  no rows, no values — the columns all the same, for the picker", none.columns.length === execColumns.columns.length && Object.keys(none.texts).length === 0);

    section("Columns: the preference, through the real action");
    as(exec);
    const saved = await preferences.setTableColumns("companies", ["select", "id", "company", "status", "addedOn", "cf.vip", "-cf.region", "cf.no_such_field", "cf.Bad", "junk"]);
    const row = await db.tablePreference.findUnique({ where: { user_table: { userId: exec.id, tableKey: "companies" } }, select: { columns: true } });
    ok(
      "stored: the table's own keys, and the choices about fields the workspace has — an unknown one dropped",
      saved.ok && json(row?.columns) === json(["id", "status", "addedOn", "cf.vip", "-cf.region"]),
      `${errorOf(saved)} ${json(row?.columns)}`,
    );
    const prefs = await preferences.getTablePreferences();
    ok("  and read back with the rest of the person's preferences", json(prefs.companies) === json(row?.columns));
    await preferences.setTableColumns("companies", [...(row?.columns ?? []), "cf.legacy_code"]);
    const withRetired = await db.tablePreference.findUnique({ where: { user_table: { userId: exec.id, tableKey: "companies" } }, select: { columns: true } });
    ok("  a choice about a retired field is kept, for when it is restored", withRetired?.columns.includes("cf.legacy_code") === true, json(withRetired?.columns));
    await preferences.setTableColumns("renewals", ["company", "cf.vip"]);
    const renewalsRow = await db.tablePreference.findUnique({ where: { user_table: { userId: exec.id, tableKey: "renewals" } }, select: { columns: true } });
    ok("  a table that shows no fields stores no choices about them", json(renewalsRow?.columns) === json(["company"]), json(renewalsRow?.columns));
    const stored = withRetired?.columns ?? [];

    as(manager);
    await define({ label: "Segment", type: "SELECT", options: [{ label: "SMB" }, { label: "Enterprise" }], showInList: true });
    await define({ label: "Hidden extra" });
    as(exec);
    const laterColumns = await server.listColumns("COMPANY", exec.id, [A, B]);
    const resolved = resolveColumns("companies", stored, laterColumns.columns);
    ok(
      "a field added since the executive customised the table: on, as its default says; one not marked for the list, off",
      resolved.includes("cf.segment") && !resolved.includes("cf.hidden_extra") && resolved.includes("cf.vip") && !resolved.includes("cf.region"),
      json(resolved),
    );

    section("Columns: the table and the picker drawn");
    const rows = (await companies.listCompaniesPaged({ page: 1, pageSize: 100, customFilters: cf({ region: { value: "north,south" } }) })).rows;
    const draw = (stored: string[] | null, list: typeof rows, columns = laterColumns) =>
      renderToStaticMarkup(
        createElement(
          TableColumnsProvider,
          { initial: stored ? { companies: stored } : {} } as ComponentProps<typeof TableColumnsProvider>,
          createElement(CompaniesTable, {
            companies: list,
            assignableUsers: [],
            reassign: { show: false, canUnassign: false },
            mode: "companies",
            customColumns: columns,
          } as ComponentProps<typeof CompaniesTable>),
        ),
      );
    // `<th` and then a space or the end of the tag: `<thead` is not a header cell.
    const headers = (html: string) => [...(html.split("<tbody")[0] ?? "").matchAll(/<th(?:\s[^>]*)?>(.*?)<\/th>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, ""));
    const firstRowCells = (html: string) => {
      const body = html.split("<tbody")[1] ?? "";
      const tr = body.slice(body.indexOf("<tr"), body.indexOf("</tr>"));
      return (tr.match(/<td/g) ?? []).length;
    };
    const chosenHtml = draw(stored, rows);
    const heads = headers(chosenHtml);
    ok(
      "the executive's choices drawn: VIP on, Region off, the new Segment on by its default, Hidden extra off",
      heads.includes("VIP") && !heads.includes("Region") && heads.includes("Segment") && !heads.includes("Hidden extra") && !heads.includes("Notes"),
      json(heads),
    );
    ok("  every row has as many cells as the header", rows.length > 0 && firstRowCells(chosenHtml) === heads.length, `${firstRowCells(chosenHtml)} cells, ${heads.length} headers`);
    ok("  and a value in words where it has one", chosenHtml.includes(">Yes<"));
    const defaultHtml = draw(null, rows);
    ok(
      "somebody who never chose: the fields marked for the list, nothing else",
      headers(defaultHtml).includes("Region") && headers(defaultHtml).includes("Segment") && !headers(defaultHtml).includes("VIP") && firstRowCells(defaultHtml) === headers(defaultHtml).length,
      json(headers(defaultHtml)),
    );
    const emptyHtml = draw(stored, []);
    const span = Number(/colSpan="(\d+)"|colspan="(\d+)"/.exec(emptyHtml)?.slice(1).find(Boolean) ?? 0);
    ok("an empty list's one cell spans exactly the columns drawn", span > 0 && span === headers(emptyHtml).length, `colspan ${span}, ${headers(emptyHtml).length} headers`);
    const badge = (stored: string[] | null) =>
      Number(
        /bg-brand-subtle[^"]*">(\d+)<\/span>/.exec(
          renderToStaticMarkup(
            createElement(
              TableColumnsProvider,
              { initial: stored ? { companies: stored } : {} } as ComponentProps<typeof TableColumnsProvider>,
              createElement(ColumnPicker, { tableKey: "companies", customColumns: laterColumns.columns }),
            ),
          ),
        )?.[1] ?? 0,
      );
    const builtInHidden = (stored: string[] | null) =>
      ["select", "id", "company", "status", "relationship", "source", "contacts", "leads", "assigned", "portal", "addedBy", "addedOn"].filter(
        (k) => !resolveColumns("companies", stored).includes(k),
      ).length;
    const fieldsHidden = (stored: string[] | null) => laterColumns.columns.filter((c) => !showsField(stored, c.key, c.default)).length;
    ok(
      "the picker's count of hidden columns takes in the hidden fields",
      badge(null) === builtInHidden(null) + fieldsHidden(null) && badge(stored) === builtInHidden(stored) + fieldsHidden(stored) && badge(null) !== badge(stored),
      `${badge(null)} for nobody's choice, ${badge(stored)} for the executive's`,
    );
  });
}

/** The URL read, and each type's filter understood and made into clauses — no database. */
function pureFilters(filters: typeof import("../src/lib/custom-fields/filters"), Prisma: typeof import("@prisma/client").Prisma) {
  section("Reading the URL");
  const parsed = filters.parseCustomFilters({
    q: "acme",
    page: "2",
    "cf.region": "north,south",
    "cf.renewal_due.from": " 2026-03-01 ",
    "cf.renewal_due.to": "2026-03-31",
    "cf.credit_limit.min": ["1,000", "5"],
    "cf.": "x",
    "cf.Bad": "x",
    "cf.a.b.c": "x",
    "cf.notes.value": "x",
    "cf.notes.until": "x",
    "cf.constructor": "x",
    "cf.__proto__": "x",
    "cf.blank": "   ",
  });
  ok(
    "the field filters, by key — the page's own parameters and anything misshapen left out",
    json(parsed) === json({ region: { value: "north,south" }, renewal_due: { from: "2026-03-01", to: "2026-03-31" }, credit_limit: { min: "1,000" }, constructor: { value: "x" } }),
    json(parsed),
  );
  ok("  a key like “constructor” is an ordinary field, and nothing lands on every object", (Object.prototype as Record<string, unknown>).value === undefined && Object.getPrototypeOf(parsed) === Object.prototype);
  const fromUrl = filters.parseCustomFilters(new URLSearchParams("cf.region=north&cf.region=south&cf.vip=no&other=1"));
  ok("  from a URL, a parameter given twice counts once", json(fromUrl) === json({ region: { value: "north" }, vip: { value: "no" } }), json(fromUrl));
  const carried = filters.customFilterParams({ q: "x", "cf.region": "north", "cf.vip": ["no", "yes"], "cf.blank": "" });
  ok("the parameters a rebuilt link carries: the field filters as they stand, nothing else", json(carried) === json({ "cf.region": "north", "cf.vip": "no" }), json(carried));

  section("What each type of filter means");
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
  const options = [
    { value: "north", label: "North" },
    { value: "south", label: "South" },
    { value: "east", label: "East", archived: true },
  ];
  const region = def({ key: "region", type: "SELECT", options });
  const u = filters.understandFilter;
  ok(
    "a dropdown: the options it has — a retired one too — and nothing it doesn't",
    json(u(region, { value: "north, bogus,east,north" })) === json({ kind: "options", values: ["north", "east"] }) && u(region, { value: "bogus" }) === null,
  );
  const multi = def({ key: "areas", type: "MULTI_SELECT", options });
  ok("a multi-select the same", json(u(multi, { value: "south" })) === json({ kind: "options", values: ["south"] }));
  const yn = def({ key: "vip", type: "CHECKBOX" });
  ok("yes or no, in any case, and nothing else", u(yn, { value: "YES" })?.kind === "yes" && u(yn, { value: "no" })?.kind === "no" && u(yn, { value: "maybe" }) === null);
  const who = def({ key: "lead", type: "USER" });
  ok("a person by id, and not anything else", u(who, { value: "cm9abcdefgh12345" })?.kind === "person" && u(who, { value: "a b" }) === null && u(who, { value: "x" }) === null);
  const day = def({ key: "due", type: "DATE" });
  ok(
    "a date range: a day that doesn't exist is left out, the other end kept",
    json(u(day, { from: "2026-02-30", to: "2026-03-31" })) === json({ kind: "days", from: null, to: "2026-03-31" }) && u(day, { from: "31/03/2026" }) === null,
  );
  const money = def({ key: "limit", type: "MONEY" });
  ok(
    "an amount range, typed as people type amounts",
    json(u(money, { min: "₹ 1,25,000.50", max: "abc" })) === json({ kind: "numbers", min: 125000.5, max: null }) && u(money, { min: "1e3" }) === null,
  );
  const text = def({ key: "notes", type: "TEXT" });
  ok("text: the words", json(u(text, { value: "50%" })) === json({ kind: "text", text: "50%" }) && u(text, {}) === null);

  section("The clauses each becomes");
  const c = filters.filterClauses;
  ok("one option: a plain equals, not an OR of one", json(c(region, { kind: "options", values: ["north"] })) === json([{ customFields: { path: ["region"], equals: "north" } }]));
  ok(
    "several on a multi-select: any of them, each in the list",
    json(c(multi, { kind: "options", values: ["north", "south"] })) ===
      json([{ OR: [{ customFields: { path: ["areas"], array_contains: ["north"] } }, { customFields: { path: ["areas"], array_contains: ["south"] } }] }]),
  );
  const no = c(yn, { kind: "no" })[0] as { OR: [{ NOT: unknown }, { customFields: { equals: unknown } }] };
  ok("“No”: not yes, or never answered", Array.isArray(no.OR) && "NOT" in no.OR[0] && no.OR[1].customFields.equals === Prisma.AnyNull);
  ok("text: contains, any case, % and _ escaped", json(c(text, { kind: "text", text: "50%_x\\" })) === json([{ customFields: { path: ["notes"], string_contains: "50\\%\\_x\\\\", mode: "insensitive" } }]));
  ok(
    "a range: one clause an end, only the ends given",
    c(day, { kind: "days", from: null, to: "2026-03-31" }).length === 1 && c(money, { kind: "numbers", min: 1, max: 2 }).length === 2,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * check:custom-field-reports — the workspace's own fields in Reports (owner, 2 Oct 2026):
 * src/lib/analytics/custom.ts, the sources' loads in src/lib/analytics/sources.ts, and the actions,
 * CSV and printed sheet that use them (src/actions/analytics.ts, src/app/(dashboard)/reports/print).
 *
 * Builds a scratch workspace database beside the real one (as check:custom-fields does), drives the
 * real report actions as a workspace pointed at it (`runAsTenant`), and drops it at the end, pass or
 * fail:
 *
 *   · what the explorer offers: each source's fields under keys of their own, labelled with whose
 *     they are; long text, retired fields and numbers never as breakdowns; an amount or a number as
 *     a "Total …" measure, on the rows' own records only;
 *   · orders by the order's own dropdown (a retired option by its label), by the customer's region,
 *     filtered by it and across another field, by the product's batch number; leads by a lead field;
 *   · a multi-select counting a record in each of its buckets and saying so, the total still once;
 *     a date by its month, a box nobody ticked as "No", a person by name or as somebody gone;
 *   · an amount added up over India's September, and not a rupee of 1 October;
 *   · a restricted field: absent for somebody without `fields.seeRestricted`, present with it, and a
 *     request naming it anyway — breakdown, column, filter or measure — refused in the words any
 *     unknown key gets, with nothing of the field in the answer; nothing offered from accounts
 *     somebody can't see;
 *   · the CSV and the printed sheet headed with labels, not keys; the explorer's "Your fields";
 *   · a workspace whose orders don't have the column yet, and one with no fields table at all;
 *   · and the real workspace untouched.
 *
 *   npm run check:custom-field-reports
 *   TZ=UTC npm run check:custom-field-reports      (from PowerShell: $env:TZ = "UTC"; npm run check:custom-field-reports)
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createElement, type ReactElement } from "react";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { ReportRequest, SourceOption } from "../src/actions/analytics";
import type { ReportResult } from "../src/lib/analytics/run";
import type { CustomFieldEntityKey, CustomFieldOption, CustomFieldTypeKey } from "../src/lib/custom-fields/rules";
import { directClient } from "../src/lib/tenancy/direct-client";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
/** Two JSON values with the same content, whatever order their keys came in. */
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

const TAG = "ZZCFREPORTS";

/** A wall-clock time in India, offset spelled out — never the host's clock (src/lib/india-time.ts). */
const ist = (wallClock: string) => new Date(`${wallClock}:00+05:30`);

// ── Who the actions think is calling ────────────────────────────────────────────────────────────

type Actor = { id: string; name: string; email: string; role: string };
let actor: Actor | null = null;

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
  usePathname: () => "/reports",
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

const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

// ── The scratch database ────────────────────────────────────────────────────────────────────────

async function main() {
  const realUrl = process.env.DATABASE_URL;
  if (!realUrl) throw new Error("DATABASE_URL is not set.");
  const host = new URL(realUrl).hostname;
  const realName = new URL(realUrl).pathname.slice(1);

  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratchName = `${realName}_cfreports`;
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
    await run(scratchUrl, scratchName);
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
  ok("its field definitions, companies, orders and leads are as they were", realAfter.counts === realBefore.counts, realAfter.counts);
  ok("  and nothing of this suite's is in it", realAfter.tagged === 0 && realBefore.tagged === 0, realAfter.tagged);

  console.log(failures === 0 ? `\nAll ${passes} custom-field-reports checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/** What the suite must never change in the real workspace. Read-only. */
async function snapshot(client: PrismaClient) {
  const [definitions, companies, orders, leads, tagged] = await Promise.all([
    client.customFieldDefinition.count(),
    client.company.count(),
    client.companyProduct.count(),
    client.lead.count(),
    client.company.count({ where: { name: { startsWith: TAG } } }),
  ]);
  return { counts: JSON.stringify({ definitions, companies, orders, leads }), tagged };
}

// ── The suite ───────────────────────────────────────────────────────────────────────────────────

type Ran = { ok: true; data: ReportResult } | { ok: false; error: string };

async function run(scratchUrl: string, scratchName: string) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
  const analytics = require("../src/actions/analytics") as typeof import("../src/actions/analytics");
  const { effectiveSource } = require("../src/lib/analytics/custom") as typeof import("../src/lib/analytics/custom");
  const { getSource } = require("../src/lib/analytics/sources") as typeof import("../src/lib/analytics/sources");
  const { runReport } = require("../src/lib/analytics/run") as typeof import("../src/lib/analytics/run");
  const { NONE } = require("../src/lib/analytics/types") as typeof import("../src/lib/analytics/types");
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  const PrintPage = (require("../src/app/(dashboard)/reports/print/page") as { default: (p: unknown) => Promise<ReactElement> }).default;
  const { ReportExplorer } = require("../src/components/reports/report-explorer") as typeof import("../src/components/reports/report-explorer");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const tenant = {
    id: randomUUID(),
    slug: "zzcfreports",
    name: "zzcfreports",
    status: "ACTIVE" as const,
    dbUrl: scratchUrl,
    primaryHost: "zzcfreports.localhost",
    hosts: ["zzcfreports.localhost"],
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
    const user = (key: string, grants: Record<string, boolean>): Promise<Actor> =>
      db.user.create({
        data: {
          name: `${TAG} ${key}`,
          email: `${TAG.toLowerCase()}-${key.toLowerCase()}@example.test`,
          passwordHash: "!",
          role: "PROFILE",
          permissionGrants: { create: Object.entries(grants).map(([permission, allowed]) => ({ permission, allowed, reason: TAG })) },
        },
        select: { id: true, name: true, email: true, role: true },
      });
    // Every source's module theirs to see, and the CRM export, so what differs is only what is asked.
    const sees = {
      "orders.view": true,
      "leads.view": true,
      "documents.view": true,
      "payments.view": true,
      "tickets.view": true,
      "visits.view": true,
      "data.exportCrm": true,
    };
    const admin = await user("Admin", { ...sees, "companies.viewAll": true, "fields.seeRestricted": true });
    const exec = await user("Executive", { ...sees, "companies.viewAll": true, "fields.seeRestricted": false });
    // May see the restricted fields, but manages none of the accounts.
    const outsider = await user("Outsider", { ...sees, "companies.viewAll": false, "fields.seeRestricted": true });
    const as = (u: Actor) => {
      actor = u;
    };

    let sortOrder = 0;
    const define = (
      entity: CustomFieldEntityKey,
      key: string,
      label: string,
      type: CustomFieldTypeKey,
      extra: { options?: CustomFieldOption[]; restricted?: boolean; archived?: boolean } = {},
    ) =>
      db.customFieldDefinition.create({
        data: {
          entity,
          key,
          label,
          type,
          options: (extra.options ?? []) as Prisma.InputJsonValue,
          restricted: extra.restricted ?? false,
          archivedAt: extra.archived ? ist("2026-09-15T10:00") : null,
          sortOrder: sortOrder++,
          createdById: admin.id,
        },
        select: { id: true },
      });
    await define("ORDER", "site_code", "Site code", "TEXT");
    await define("ORDER", "install_type", "Install type", "SELECT", {
      options: [
        { value: "onsite", label: "On site" },
        { value: "remote", label: "Remote" },
        { value: "hybrid", label: "Hybrid", archived: true },
      ],
    });
    await define("ORDER", "go_live", "Go-live date", "DATE");
    await define("ORDER", "priority_support", "Priority support", "CHECKBOX");
    await define("ORDER", "implementer", "Implementer", "USER");
    await define("ORDER", "installation_charge", "Installation charge", "MONEY");
    await define("ORDER", "seats", "Seats", "NUMBER");
    await define("ORDER", "internal_margin", "Internal margin", "MONEY", { restricted: true });
    await define("ORDER", "handover_notes", "Handover notes", "LONG_TEXT");
    await define("ORDER", "old_code", "Old code", "TEXT", { archived: true });
    await define("COMPANY", "region", "Region", "SELECT", {
      options: [
        { value: "north", label: "North" },
        { value: "south", label: "South" },
        { value: "west", label: "West" },
      ],
    });
    await define("COMPANY", "segments", "Segments", "MULTI_SELECT", {
      options: [
        { value: "smb", label: "SMB" },
        { value: "government", label: "Government" },
        { value: "education", label: "Education" },
      ],
    });
    await define("COMPANY", "internal_rating", "Internal rating", "SELECT", {
      restricted: true,
      options: [
        { value: "strategic", label: "Strategic" },
        { value: "standard", label: "Standard" },
      ],
    });
    await define("COMPANY", "credit_limit", "Credit limit", "MONEY");
    await define("ITEM", "batch_no", "Batch no.", "TEXT");
    await define("LEAD", "budget_band", "Budget band", "SELECT", {
      options: [
        { value: "under_5_lakh", label: "Under 5 lakh" },
        { value: "f_5_to_25_lakh", label: "5 to 25 lakh" },
      ],
    });

    const company = async (name: string, values: Record<string, unknown>) => {
      const row = await db.company.create({
        data: {
          name: `${TAG} ${name}`,
          normalizedName: `${TAG} ${name}`.toLowerCase(),
          createdById: admin.id,
          ownerUserId: admin.id,
          relationshipType: "CLIENT",
          customFields: values as Prisma.InputJsonValue,
          locations: { create: { label: "Head Office", isPrimary: true } },
        },
        select: { id: true, locations: { select: { id: true } } },
      });
      return { id: row.id, locationId: row.locations[0]!.id };
    };
    const north = await company("Northwind", { region: "north", segments: ["smb", "government"], internal_rating: "strategic", credit_limit: 500000 });
    const south = await company("Southwind", { region: "south", segments: ["smb"], internal_rating: "standard", credit_limit: 200000 });
    const plain = await company("Plainfield", {});

    const item = async (sku: string, values: Record<string, unknown>) =>
      (
        await db.item.create({
          data: { name: `${TAG} ${sku}`, sku: `${TAG}-${sku}`, type: "GOOD", sellingPrice: 1000, createdById: admin.id, customFields: values as Prisma.InputJsonValue },
          select: { id: true },
        })
      ).id;
    const laptop = await item("LAPTOP", { batch_no: "B-100" });
    const support = await item("SUPPORT", {});

    // Somebody a value names who has since gone from the workspace altogether.
    const GONE = "cl0gone0person0000000000";

    type Order = { ref: string; company: { id: string; locationId: string }; item: string; quantity: number; unitPrice: number; at: Date; fields: Record<string, unknown> };
    const ORDERS: Order[] = [
      {
        ref: "O1",
        company: north,
        item: laptop,
        quantity: 2,
        unitPrice: 50_000,
        at: ist("2026-09-05T10:00"),
        fields: {
          site_code: "PUNE-01",
          install_type: "onsite",
          go_live: "2026-10-15",
          priority_support: true,
          implementer: exec.id,
          installation_charge: 2500,
          seats: 10,
          internal_margin: 9000,
          handover_notes: "Keys are with the facilities desk.",
          old_code: "X-1",
        },
      },
      {
        ref: "O2",
        company: north,
        item: support,
        quantity: 1,
        unitPrice: 20_000,
        at: ist("2026-09-12T15:30"),
        fields: { site_code: "PUNE-02", install_type: "remote", go_live: "2026-11-01", priority_support: false, implementer: GONE, installation_charge: 1500.5 },
      },
      // 00:30 on 1 September in India — still 31 August in UTC, and in the window.
      { ref: "O3", company: south, item: laptop, quantity: 1, unitPrice: 30_000, at: ist("2026-09-01T00:30"), fields: { install_type: "hybrid", go_live: "2026-10-03", internal_margin: 4000 } },
      { ref: "O4", company: plain, item: support, quantity: 3, unitPrice: 1_000, at: ist("2026-09-20T11:00"), fields: {} },
      // 01:30 on 1 October in India — still 30 September in UTC, and outside the window.
      { ref: "O5", company: north, item: laptop, quantity: 1, unitPrice: 99_000, at: ist("2026-10-01T01:30"), fields: { install_type: "onsite", installation_charge: 99_999, seats: 500 } },
    ];
    for (const o of ORDERS) {
      await db.companyProduct.create({
        data: {
          companyId: o.company.id,
          locationId: o.company.locationId,
          itemId: o.item,
          addedByUserId: exec.id,
          quantity: o.quantity,
          unitPrice: o.unitPrice,
          createdAt: o.at,
          customFields: o.fields as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
    }
    type Lead = { title: string; company: { id: string }; value: number; at: Date; fields: Record<string, unknown> };
    const LEADS: Lead[] = [
      { title: "Laptop refresh", company: north, value: 400_000, at: ist("2026-09-10T12:00"), fields: { budget_band: "under_5_lakh" } },
      { title: "Campus network", company: south, value: 1_500_000, at: ist("2026-09-18T16:45"), fields: { budget_band: "f_5_to_25_lakh" } },
      { title: "Printers", company: plain, value: 50_000, at: ist("2026-09-25T09:15"), fields: {} },
    ];
    for (const l of LEADS) {
      await db.lead.create({
        data: { companyId: l.company.id, title: `${TAG} ${l.title}`, estimatedValue: l.value, createdAt: l.at, customFields: l.fields as Prisma.InputJsonValue },
        select: { id: true },
      });
    }
    ok("fields on orders, customers, products and leads; five orders, three leads; three people", ORDERS.length === 5 && LEADS.length === 3);

    // What the fixture says the answers are — so every expectation below is read off it, not typed in.
    const SEPTEMBER = ["O1", "O2", "O3", "O4"];
    const valueOf = (...refs: string[]) => ORDERS.filter((o) => refs.includes(o.ref)).reduce((t, o) => t + o.quantity * o.unitPrice, 0);
    const fieldTotal = (key: string, refs: string[]) =>
      ORDERS.filter((o) => refs.includes(o.ref)).reduce((t, o) => t + (typeof o.fields[key] === "number" ? (o.fields[key] as number) : 0), 0);

    const window = { grain: "month" as const, dateField: "createdAt", from: "2026-09-01", to: "2026-09-30" };
    const ordersBy = (dimension: string, extra: Partial<ReportRequest> = {}): ReportRequest => ({ source: "orders", measure: "value", dimension, ...window, ...extra });
    const leadsBy = (dimension: string, extra: Partial<ReportRequest> = {}): ReportRequest => ({ source: "leads", measure: "value", dimension, ...window, ...extra });
    const report = async (who: Actor, request: ReportRequest): Promise<Ran> => {
      as(who);
      return analytics.runAnalyticsReport(request);
    };
    /** Each row's total by its label — the table as somebody reads it. */
    const totals = (r: Ran) => (r.ok ? Object.fromEntries(r.data.rows.map((row) => [row.label, row.total])) : { refused: r.error });
    const shown = (r: Ran) => JSON.stringify(totals(r));

    // ── What is offered ────────────────────────────────────────────────────────────────────────
    section("What the explorer offers");
    as(admin);
    const adminOptions = await analytics.reportOptions();
    as(exec);
    const execOptions = await analytics.reportOptions();
    const sourceIn = (o: { sources: SourceOption[] }, key: string) => o.sources.find((s) => s.key === key);
    const dimLabel = (s: SourceOption | undefined, key: string) => s?.dimensions.find((d) => d.key === key)?.label;
    const measureLabel = (s: SourceOption | undefined, key: string) => s?.measures.find((m) => m.key === key)?.label;
    const customKeys = (s: SourceOption | undefined) => [...(s?.dimensions ?? []), ...(s?.measures ?? [])].filter((x) => x.key.startsWith("cf:")).map((x) => x.key);
    const adminOrders = sourceIn(adminOptions, "orders");
    const execOrders = sourceIn(execOptions, "orders");
    const adminLeads = sourceIn(adminOptions, "leads");

    ok(
      "orders offer the order's own fields, labelled as the order's",
      dimLabel(adminOrders, "cf:order:site_code") === "Order · Site code" &&
        dimLabel(adminOrders, "cf:order:install_type") === "Order · Install type" &&
        dimLabel(adminOrders, "cf:order:go_live") === "Order · Go-live date" &&
        dimLabel(adminOrders, "cf:order:priority_support") === "Order · Priority support" &&
        dimLabel(adminOrders, "cf:order:implementer") === "Order · Implementer",
      customKeys(adminOrders).join(", "),
    );
    ok(
      "  and the customer's and the product's, labelled as theirs",
      dimLabel(adminOrders, "cf:company:region") === "Customer · Region" &&
        dimLabel(adminOrders, "cf:company:segments") === "Customer · Segments" &&
        dimLabel(adminOrders, "cf:item:batch_no") === "Product · Batch no.",
    );
    ok(
      "  after every built-in breakdown, which are as they were",
      adminOrders?.dimensions[0]?.key === "salesperson" &&
        adminOrders.dimensions.findIndex((d) => d.key.startsWith("cf:")) === adminOrders.dimensions.filter((d) => !d.key.startsWith("cf:")).length,
    );
    ok(
      "  each marked as the workspace's own and no built-in one is; the multi-select multi-valued",
      !!adminOrders &&
        adminOrders.dimensions.every((d) => (d.custom === true) === d.key.startsWith("cf:")) &&
        adminOrders.measures.every((m) => (m.custom === true) === m.key.startsWith("cf:")) &&
        adminOrders.dimensions.find((d) => d.key === "cf:company:segments")?.multi === true &&
        adminOrders.dimensions.find((d) => d.key === "cf:company:region")?.multi !== true,
    );
    ok(
      "long text, a retired field, and numbers are not breakdowns",
      !!adminOrders &&
        ["cf:order:handover_notes", "cf:order:old_code", "cf:order:installation_charge", "cf:order:seats", "cf:company:credit_limit"].every((k) => !dimLabel(adminOrders, k)),
    );
    ok(
      "an amount and a number on the order are measures, “Total …”",
      measureLabel(adminOrders, "cf:order:installation_charge") === "Total Installation charge" && measureLabel(adminOrders, "cf:order:seats") === "Total Seats",
      adminOrders?.measures.map((m) => m.label).join(", "),
    );
    ok(
      "  but the customer's amount is not — over the orders it would count a credit limit once per order",
      !measureLabel(adminOrders, "cf:company:credit_limit") && !customKeys(adminOrders).includes("cf:order:old_code"),
    );
    ok(
      "leads offer the lead's own fields and the company's, as the leads report names it",
      dimLabel(adminLeads, "cf:lead:budget_band") === "Lead · Budget band" &&
        dimLabel(adminLeads, "cf:company:region") === "Company · Region" &&
        !customKeys(adminLeads).some((k) => k.startsWith("cf:order:") || k.startsWith("cf:item:")),
      customKeys(adminLeads).join(", "),
    );
    const others = adminOptions.sources.filter((s) => s.key !== "orders" && s.key !== "leads");
    ok(
      "every other source offers the customer's fields, and nobody else's",
      others.length === 4 &&
        others.every((s) => dimLabel(s, "cf:company:region") === "Customer · Region" && customKeys(s).every((k) => k.startsWith("cf:company:"))),
      others.map((s) => `${s.key}: ${customKeys(s).length}`).join(", "),
    );
    const everyKey = adminOptions.sources.flatMap((s) => [...s.dimensions.map((d) => `${s.key}/${d.key}`), ...s.measures.map((m) => `${s.key}/m/${m.key}`)]);
    const fieldKeys = adminOptions.sources.flatMap((s) => customKeys(s));
    ok(
      "every key namespaced, none twice in a source, none “time”, all within the Copilot's 60 characters",
      new Set(everyKey).size === everyKey.length && fieldKeys.every((k) => /^cf:(order|company|item|lead):[a-z][a-z0-9_]{0,39}$/.test(k) && k.length <= 60) && !everyKey.some((k) => k.endsWith("/time")),
      `${fieldKeys.length} field keys`,
    );

    // ── Orders ─────────────────────────────────────────────────────────────────────────────────
    section("Orders by the order's own fields");
    const install = await report(exec, ordersBy("cf:order:install_type"));
    ok(
      "by the order's dropdown, each option by its label — a retired one too",
      sameJson(totals(install), { "On site": valueOf("O1"), Remote: valueOf("O2"), Hybrid: valueOf("O3"), [NONE]: valueOf("O4") }),
      shown(install),
    );
    ok(
      "  over India's September: 00:30 on the 1st in, 01:30 on 1 October out",
      install.ok && install.data.grandTotal === valueOf(...SEPTEMBER) && install.data.rowCount === SEPTEMBER.length,
      install.ok ? `${install.data.rowCount} orders, ${install.data.grandTotal}` : install.error,
    );
    const site = await report(exec, ordersBy("cf:order:site_code"));
    ok("by short text, as itself; an order without one under —", sameJson(totals(site), { "PUNE-01": valueOf("O1"), "PUNE-02": valueOf("O2"), [NONE]: valueOf("O3", "O4") }), shown(site));
    const goLive = await report(exec, ordersBy("cf:order:go_live"));
    ok("by a date, as its month", sameJson(totals(goLive), { "2026-10": valueOf("O1", "O3"), "2026-11": valueOf("O2"), [NONE]: valueOf("O4") }), shown(goLive));
    const priority = await report(exec, ordersBy("cf:order:priority_support"));
    ok("by a yes/no: a box nobody ticked is No, never a blank", sameJson(totals(priority), { Yes: valueOf("O1"), No: valueOf("O2", "O3", "O4") }), shown(priority));
    const implementer = await report(exec, ordersBy("cf:order:implementer"));
    ok(
      "by a person: by name, somebody since gone as such, nobody under —",
      sameJson(totals(implementer), { [exec.name]: valueOf("O1"), "Someone no longer here": valueOf("O2"), [NONE]: valueOf("O3", "O4") }),
      shown(implementer),
    );

    section("Orders by the customer's field, filtered by it, and across another");
    const region = await report(exec, ordersBy("cf:company:region"));
    ok("by the customer's region", sameJson(totals(region), { North: valueOf("O1", "O2"), South: valueOf("O3"), [NONE]: valueOf("O4") }), shown(region));
    const northOnly = await report(exec, ordersBy("item", { filters: { "cf:company:region": ["North"] } }));
    ok(
      "filtered to the North, by product: the North's orders only, and the total with them",
      northOnly.ok &&
        northOnly.data.rowCount === 2 &&
        northOnly.data.filteredOut === 2 &&
        northOnly.data.grandTotal === valueOf("O1", "O2") &&
        sameJson(totals(northOnly), { [`${TAG} LAPTOP`]: valueOf("O1"), [`${TAG} SUPPORT`]: valueOf("O2") }),
      shown(northOnly),
    );
    const noRegion = await report(exec, ordersBy("item", { filters: { "cf:company:region": [NONE] } }));
    ok("  and to the orders of customers with no region, by asking for —", noRegion.ok && noRegion.data.grandTotal === valueOf("O4") && noRegion.data.rowCount === 1, shown(noRegion));
    const cross = await report(exec, ordersBy("cf:company:region", { column: "cf:order:install_type" }));
    const northRow = cross.ok ? cross.data.rows.find((r) => r.label === "North") : undefined;
    ok(
      "the customer's field down the side, the order's across the top",
      cross.ok &&
        northRow?.cells["On site"] === valueOf("O1") &&
        northRow.cells["Remote"] === valueOf("O2") &&
        cross.data.columns.map((c) => c.label).sort().join(",") === ["Hybrid", "On site", "Remote", NONE].sort().join(","),
      cross.ok ? cross.data.columns.map((c) => c.label).join(" | ") : cross.error,
    );
    const batch = await report(exec, ordersBy("cf:item:batch_no"));
    ok("by the product's batch number", sameJson(totals(batch), { "B-100": valueOf("O1", "O3"), [NONE]: valueOf("O2", "O4") }), shown(batch));

    section("A multi-select");
    const segments = await report(exec, ordersBy("cf:company:segments"));
    ok(
      "puts an order in each of its customer's segments",
      sameJson(totals(segments), { SMB: valueOf("O1", "O2", "O3"), Government: valueOf("O1", "O2"), [NONE]: valueOf("O4") }),
      shown(segments),
    );
    ok("  says the rows add up to more than the total", segments.ok && segments.data.doubleCounted);
    ok("  and counts each order once in the total itself", segments.ok && segments.data.grandTotal === valueOf(...SEPTEMBER), segments.ok ? segments.data.grandTotal : segments.error);
    ok("  while a single-valued field raises no such flag", region.ok && !region.data.doubleCounted);

    section("Amounts added up");
    const charges = await report(exec, ordersBy("cf:company:region", { measure: "cf:order:installation_charge" }));
    ok(
      "an amount on the order, totalled in rupees, by the customer's region",
      charges.ok &&
        charges.data.unit === "currency" &&
        sameJson(totals(charges), { North: fieldTotal("installation_charge", ["O1", "O2"]), South: 0, [NONE]: 0 }),
      shown(charges),
    );
    ok(
      "  over September only — not a rupee of the order punched at 01:30 on 1 October",
      charges.ok && charges.data.grandTotal === fieldTotal("installation_charge", SEPTEMBER) && charges.data.grandTotal !== fieldTotal("installation_charge", [...SEPTEMBER, "O5"]),
      charges.ok ? charges.data.grandTotal : charges.error,
    );
    const seats = await report(exec, ordersBy("time", { measure: "cf:order:seats" }));
    ok("a number totalled as a number", seats.ok && seats.data.unit === "number" && seats.data.grandTotal === fieldTotal("seats", SEPTEMBER), seats.ok ? `${seats.data.unit} ${seats.data.grandTotal}` : seats.error);

    section("Leads by their own field and their company's");
    const band = await report(exec, leadsBy("cf:lead:budget_band"));
    ok("by the lead's budget band", sameJson(totals(band), { "Under 5 lakh": LEADS[0]!.value, "5 to 25 lakh": LEADS[1]!.value, [NONE]: LEADS[2]!.value }), shown(band));
    const leadRegion = await report(exec, leadsBy("cf:company:region", { measure: "count" }));
    ok("  and by the region of the company each is for", sameJson(totals(leadRegion), { North: 1, South: 1, [NONE]: 1 }), shown(leadRegion));

    // ── Restricted ─────────────────────────────────────────────────────────────────────────────
    section("A restricted field");
    const leaks = (r: unknown) => ["Internal rating", "Internal margin", "Strategic", "Standard"].filter((w) => (typeof r === "string" ? r : JSON.stringify(r)).includes(w));
    ok(
      "somebody without fields.seeRestricted is offered neither the restricted breakdown nor the restricted amount",
      !!execOrders && !dimLabel(execOrders, "cf:company:internal_rating") && !measureLabel(execOrders, "cf:order:internal_margin") && leaks(execOptions).length === 0,
      leaks(execOptions).join(", "),
    );
    ok(
      "  somebody with it is offered both",
      dimLabel(adminOrders, "cf:company:internal_rating") === "Customer · Internal rating" && measureLabel(adminOrders, "cf:order:internal_margin") === "Total Internal margin",
    );
    const byRating = await report(admin, ordersBy("cf:company:internal_rating"));
    ok("  and gets the orders by it", sameJson(totals(byRating), { Strategic: valueOf("O1", "O2"), Standard: valueOf("O3"), [NONE]: valueOf("O4") }), shown(byRating));
    const margins = await report(admin, ordersBy("cf:company:region", { measure: "cf:order:internal_margin" }));
    ok("  and the restricted amount totalled", margins.ok && margins.data.grandTotal === fieldTotal("internal_margin", SEPTEMBER), shown(margins));

    const asBreakdown = await report(exec, ordersBy("cf:company:internal_rating"));
    const asColumn = await report(exec, ordersBy("cf:company:region", { column: "cf:company:internal_rating" }));
    const asFilter = await report(exec, ordersBy("cf:company:region", { filters: { "cf:company:internal_rating": ["Strategic"] } }));
    const asMeasure = await report(exec, ordersBy("cf:company:region", { measure: "cf:order:internal_margin" }));
    const named = [asBreakdown, asColumn, asFilter, asMeasure];
    ok(
      "a request naming it anyway — as the breakdown, the columns, a filter or the measure — is refused",
      named.every((r) => !r.ok),
      named.map((r) => (r.ok ? "ran" : "refused")).join(", "),
    );
    ok("  and the refusal says nothing of the field: not its name, its options, or a figure", named.every((r) => leaks(r).length === 0), named.map((r) => leaks(r).join("+")).join(" | "));
    const never = await report(exec, ordersBy("cf:company:no_such_field"));
    const wording = (r: Ran, key: string) => (r.ok ? "ran" : r.error.replace(key, "<key>"));
    ok(
      "  in the very words a key that never existed gets",
      !never.ok && wording(asBreakdown, "cf:company:internal_rating") === wording(never, "cf:company:no_such_field"),
      wording(asBreakdown, "cf:company:internal_rating"),
    );
    // Beneath the action, the engine itself: their source has no function for the key, so there is
    // nothing to bucket by and nothing to filter on — whatever the field holds, the answer is the same.
    as(exec);
    const execSource = await effectiveSource(getSource("orders")!, exec.id);
    const execRows = await execSource.load({ userId: exec.id, from: ist("2026-09-01T00:00"), to: ist("2026-10-01T00:00"), dateColumn: "createdAt" });
    const direct = (dimensionKey: string, filters?: Record<string, string[]>) =>
      runReport({ source: execSource, rows: execRows, measureKey: "value", dimensionKey, grain: "month", dateKey: "createdAt", scopeNote: "check", filters });
    const directBy = direct("cf:company:internal_rating");
    const directFiltered = direct("item", { "cf:company:internal_rating": ["Strategic"] });
    ok(
      "  and the engine beneath it, asked directly, puts every order in one Total and keeps none for a filter on it",
      directBy.rows.length === 1 &&
        directBy.rows[0]!.label === "Total" &&
        directBy.grandTotal === valueOf(...SEPTEMBER) &&
        directFiltered.rowCount === 0 &&
        directFiltered.filteredOut === SEPTEMBER.length &&
        leaks(directBy).length === 0 &&
        leaks(directFiltered).length === 0,
      `${directBy.rows.map((r) => `${r.label} ${r.total}`).join(", ")}; filtered ${directFiltered.rowCount} of ${execRows.length}`,
    );
    as(exec);
    const execPanel = await analytics.reportFilterOptions({ source: "orders", from: window.from, to: window.to, dateField: "createdAt" });
    ok(
      "their reports and their filter panel carry no value of it either",
      region.ok && execPanel.ok && !("cf:company:internal_rating" in region.data.values) && !("cf:company:internal_rating" in execPanel.data.values) && leaks(region).length === 0 && leaks(execPanel).length === 0,
      execPanel.ok ? Object.keys(execPanel.data.values).filter((k) => k.startsWith("cf:")).join(", ") : execPanel.error,
    );
    as(admin);
    const adminPanel = await analytics.reportFilterOptions({ source: "orders", from: window.from, to: window.to, dateField: "createdAt" });
    ok(
      "  while the panel offers its values to somebody who may see them",
      adminPanel.ok && sameJson(adminPanel.data.values["cf:company:internal_rating"], [NONE, "Standard", "Strategic"]),
      adminPanel.ok ? JSON.stringify(adminPanel.data.values["cf:company:internal_rating"]) : adminPanel.error,
    );

    section("Nothing from accounts somebody can't see");
    const outsiderRun = await report(outsider, ordersBy("cf:company:internal_rating"));
    ok("somebody who manages none of these accounts gets none of their orders", outsiderRun.ok && outsiderRun.data.rowCount === 0, shown(outsiderRun));
    as(outsider);
    const outsiderPanel = await analytics.reportFilterOptions({ source: "orders", from: window.from, to: window.to, dateField: "createdAt" });
    ok(
      "  and the filter panel offers them no value of any field — a restricted one they may see included",
      outsiderPanel.ok &&
        Object.entries(outsiderPanel.data.values)
          .filter(([k]) => k.startsWith("cf:"))
          .every(([, values]) => values.length === 0) &&
        !JSON.stringify(outsiderPanel).includes("North") &&
        leaks(outsiderPanel).length === 0,
      outsiderPanel.ok ? JSON.stringify(outsiderPanel.data.values["cf:company:region"]) : outsiderPanel.error,
    );

    // ── Files and pages ────────────────────────────────────────────────────────────────────────
    section("The CSV");
    as(exec);
    const csv = await analytics.exportReportCsv(ordersBy("cf:company:region", { filters: { "cf:order:install_type": ["On site", "Remote"] } }));
    const lines = csv.ok ? csv.data.csv.split("\n") : [];
    const header = lines[lines.indexOf("") + 1] ?? "";
    ok("the header names the field by its label, not its key", header === '"Customer · Region","Total"', csv.ok ? header : csv.error);
    ok(
      "  the lines above it say what the report is of and what it was filtered to, in labels",
      lines.includes('"Report","Order value by Customer · Region"') && lines.includes('"Filtered to","Order · Install type: On site, Remote"'),
      lines.slice(0, 8).join(" | "),
    );
    ok("  and the rows are the report's", lines.slice(lines.indexOf("") + 2).join("|") === `"North","${valueOf("O1", "O2")}"`, lines.slice(lines.indexOf("") + 2).join("|"));
    ok(
      "  under a file name every machine will take",
      csv.ok && csv.data.filename === "orders-by-cf-company-region-2026-09-01-to-2026-09-30.csv",
      csv.ok ? csv.data.filename : csv.error,
    );
    const segmentsCsv = await analytics.exportReportCsv(ordersBy("cf:company:segments"));
    ok("a multi-select's file carries the warning that its rows add up to more", segmentsCsv.ok && segmentsCsv.data.csv.includes("A record can fall in more than one row"));
    const refusedCsv = await analytics.exportReportCsv(ordersBy("cf:company:internal_rating"));
    ok("  and a file of a restricted field is refused like the report", !refusedCsv.ok && leaks(refusedCsv).length === 0, refusedCsv.ok ? "exported" : refusedCsv.error);

    section("The printed sheet");
    const sheet = async (who: Actor, request: ReportRequest) => {
      as(who);
      const el = await PrintPage({ searchParams: Promise.resolve({ r: JSON.stringify(request) }) });
      return textOf(renderToStaticMarkup(el));
    };
    const printed = await sheet(admin, ordersBy("cf:company:region", { column: "cf:order:install_type", filters: { "cf:company:segments": ["SMB"] } }));
    ok(
      "is titled and headed in labels",
      printed.includes("Order value by customer · region") &&
        printed.includes("across Order · Install type") &&
        printed.includes("Customer · Region Hybrid On site Remote Total"),
      printed.slice(0, 260),
    );
    ok("  says what it was filtered to", printed.includes("Customer · Segments: SMB"), printed.slice(0, 400));
    ok("  and carries the rows", printed.includes(" North ") && printed.includes(" South "));
    const refusedSheet = await sheet(exec, ordersBy("cf:company:internal_rating"));
    ok(
      "an old link naming a restricted field prints the refusal for somebody who may not see it, and nothing of the field",
      refusedSheet.includes("isn't something you can report orders by") && leaks(refusedSheet).length === 0,
      refusedSheet.trim().slice(0, 200),
    );

    section("The explorer");
    const explorer = renderToStaticMarkup(
      createElement(ReportExplorer, { sources: adminOptions.sources, grains: adminOptions.grains, filterOptions: {} as never, today: "2026-09-30", monthStart: "2026-09-01" }),
    );
    const select = (label: string) => explorer.match(new RegExp(`<select[^>]*aria-label="${label.replace(/[()]/g, "\\$&")}"[^>]*>([\\s\\S]*?)</select>`))?.[1] ?? "";
    const grouped = (html: string, builtIn: string, field: string) => {
      const heading = html.indexOf('<optgroup label="Your fields">');
      return heading > 0 && html.indexOf(builtIn) >= 0 && html.indexOf(builtIn) < heading && html.indexOf(field) > heading;
    };
    ok("“Break down by” lists the built-in breakdowns, then the workspace's under “Your fields”", grouped(select("Break down by"), ">Salesperson<", ">Customer · Region<"), select("Break down by").slice(0, 120));
    // Not Salesperson: the rows start broken down by it, and "Across" never offers the rows' own breakdown.
    ok("  so does “Across”", grouped(select("Across (optional)"), ">Team / department<", ">Order · Install type<"), select("Across (optional)").slice(0, 120));
    ok("  and “Measure”, the field's total among them", grouped(select("Measure"), ">Order value<", ">Total Installation charge<"));

    // ── The deploy window ──────────────────────────────────────────────────────────────────────
    section("A workspace the migration hasn't reached");
    // Through a client of its own, checked to be on the scratch database before anything is dropped.
    const scratch = directClient(scratchUrl, { max: 1 });
    const [{ name }] = await scratch.$queryRawUnsafe<{ name: string }[]>(`select current_database()::text as name`);
    ok("(changing the scratch database only)", name === scratchName, name);
    if (name === scratchName) {
      await scratch.$executeRawUnsafe(`ALTER TABLE "company_products" DROP COLUMN "customFields"`);
      // Caught, so a load that stops retrying fails this line rather than the whole suite.
      const columnGone: Ran = await report(admin, ordersBy("cf:company:region")).catch((err: unknown) => ({ ok: false as const, error: String(err) }));
      ok(
        "orders without the column still report — the fields read as empty, the money as it was",
        columnGone.ok && columnGone.data.grandTotal === valueOf(...SEPTEMBER) && sameJson(totals(columnGone), { [NONE]: valueOf(...SEPTEMBER) }),
        shown(columnGone),
      );
      const leadsStill = await report(admin, leadsBy("cf:lead:budget_band"));
      ok("  leads, whose column is there, are untouched by it", sameJson(totals(leadsStill), totals(band)), shown(leadsStill));
      await scratch.$executeRawUnsafe(`DROP TABLE "custom_field_definitions"`);
      as(admin);
      const noTable = await analytics.reportOptions();
      ok("with no fields table at all, nothing of the kind is offered", noTable.sources.length === adminOptions.sources.length && !JSON.stringify(noTable).includes('"cf:'));
      const plainReport = await report(admin, ordersBy("salesperson"));
      ok("  and a report runs as it always did", plainReport.ok && sameJson(totals(plainReport), { [exec.name]: valueOf(...SEPTEMBER) }), shown(plainReport));
    }
    await scratch.$disconnect();
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

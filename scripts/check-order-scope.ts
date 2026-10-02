/**
 * check:order-scope — the three ways an order is raised, held to the same lines (owner, 2 Oct 2026):
 * punched (`createOrder`), seats added to a running subscription (`createAddon`), and a renewal
 * (`createRenewalOrder`).
 *
 *   · each only for an account the person could open — seats and renewals used to take any id, so a
 *     salesperson could add seats to, or renew, a customer outside their book; an account out of scope
 *     answers exactly as a missing one does;
 *   · each refused for a reseller whose onboarding isn't signed off (src/lib/orders/reseller-gate.ts);
 *   · seats and renewals audited as orders, as every other order is;
 *   · and the company page offers "Add seats" only to whom `createAddon` will let add them.
 *
 * Builds a scratch workspace database beside the real one (as check:custom-fields does), drives the real
 * actions as a workspace pointed at it (`runAsTenant`), and drops it at the end, pass or fail.
 *
 *   npm run check:order-scope
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ReactElement } from "react";
import type { PrismaClient } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";
import { istTodayKey } from "../src/lib/orders/handoff-rules";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const errorOf = (r: { ok: boolean; error?: string }) => (r.ok ? "ok" : r.error);

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

const TAG = "ZZSCOPE";
const MISSING = "That subscription no longer exists.";

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

/** A calendar day `days` after `key`, as a `@db.Date`-style value (midnight UTC of that day). */
const dayFrom = (key: string, days: number) => new Date(Date.parse(`${key}T00:00:00.000Z`) + days * 86_400_000);

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
  const scratchName = `${realName}_orderscope`;
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
  ok("its companies and orders are as they were", realAfter.counts === realBefore.counts, realAfter.counts);
  ok("  and nothing of this suite's is in it", realAfter.tagged === 0 && realBefore.tagged === 0, realAfter.tagged);

  console.log(failures === 0 ? `\nAll ${passes} order-scope checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/** What the suite must never change in the real workspace. Read-only. */
async function snapshot(client: PrismaClient) {
  const [companies, orders, tagged] = await Promise.all([
    client.company.count(),
    client.companyProduct.count(),
    client.company.count({ where: { name: { startsWith: TAG } } }),
  ]);
  return { counts: JSON.stringify({ companies, orders }), tagged };
}

// ── The suite ───────────────────────────────────────────────────────────────────────────────────

async function run(scratchUrl: string) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
  const addons = require("../src/actions/addon") as typeof import("../src/actions/addon");
  const renewals = require("../src/actions/renewal-order") as typeof import("../src/actions/renewal-order");
  const orders = require("../src/actions/order") as typeof import("../src/actions/order");
  const { CompanyDetail } = require("../src/components/companies/company-detail") as typeof import("../src/components/companies/company-detail");
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const tenant = {
    id: randomUUID(),
    slug: "zzscope",
    name: "zzscope",
    status: "ACTIVE" as const,
    dbUrl: scratchUrl,
    primaryHost: "zzscope.localhost",
    hosts: ["zzscope.localhost"],
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
    const sells = { "orders.view": true, "orders.process": true, "products.edit": true, "companies.viewAll": false };
    const owner = await user("Owner", {}, { isSuperAdmin: true, role: "ADMIN" });
    // Alpha's and the reseller's account manager.
    const salesA = await user("Asha", sells);
    // Sells too, but neither of those accounts is in their book.
    const salesB = await user("Bilal", sells);
    // Sees every account and its orders, but raises none.
    const viewer = await user("Viewer", { "orders.view": true, "orders.process": false, "products.edit": false, "companies.viewAll": true });
    const as = (u: { id: string; name: string; email: string; role: string }) => {
      actor = u;
    };

    const item = await db.item.create({
      data: { name: `${TAG} Cloud seats`, sku: `${TAG}-SEAT`, type: "SUBSCRIPTION", billingCycle: "ANNUAL", unit: "seat", sellingPrice: 1000, createdById: owner.id },
      select: { id: true, name: true },
    });
    const account = async (name: string, relationshipType: "CLIENT" | "RESELLER") => {
      const company = await db.company.create({
        data: { name: `${TAG} ${name}`, normalizedName: `${TAG} ${name}`.toLowerCase(), createdById: owner.id, ownerUserId: salesA.id, relationshipType, stage: "CUSTOMER" },
        select: { id: true },
      });
      const location = await db.companyLocation.create({ data: { companyId: company.id, label: "Head Office", isPrimary: true }, select: { id: true } });
      return { id: company.id, locationId: location.id };
    };
    const today = istTodayKey(new Date());
    // Ten seats, a month into a year's term.
    const subscription = (to: { id: string; locationId: string }) =>
      db.companyProduct.create({
        data: {
          companyId: to.id,
          locationId: to.locationId,
          itemId: item.id,
          quantity: 10,
          unitPrice: 1000,
          fullTermUnitPrice: 1000,
          startDate: dayFrom(today, -30),
          endDate: dayFrom(today, 335),
          orderStatus: "FULFILLED",
          addedByUserId: salesA.id,
        },
        select: { id: true },
      });
    const alpha = await account("Alpha", "CLIENT");
    const alphaSub = await subscription(alpha);
    const reseller = await account("Reseller", "RESELLER");
    await db.resellerProfile.create({ data: { companyId: reseller.id, status: "SUSPENDED" } });
    const resellerSub = await subscription(reseller);
    ok("an account and a reseller in Asha's book, each with ten seats a month into the year; Bilal sells too", !!alphaSub.id && !!resellerSub.id);

    const seats = (parentId: string) => addons.createAddon({ parentId, quantity: 2, startDate: today });
    const childrenOf = (parentId: string) => db.companyProduct.count({ where: { parentId } });
    const renewalsOf = (id: string) => db.companyProduct.count({ where: { renewedFromId: id } });
    const auditedAs = async (entityId: string) => (await db.auditLog.findFirst({ where: { entityId, action: "CREATE" }, select: { entityType: true } }))?.entityType;

    // ── Seats ──────────────────────────────────────────────────────────────────────────────────
    section("Seats added to a running subscription");
    as(salesB);
    ok("the quote already answered an account outside Bilal's book as missing", (await addons.quoteAddon({ parentId: alphaSub.id, quantity: 2, startDate: today })) === null);
    const outOfBook = await seats(alphaSub.id);
    ok("Bilal can't add seats to Alpha's subscription", !outOfBook.ok && outOfBook.error === MISSING && (await childrenOf(alphaSub.id)) === 0, errorOf(outOfBook));
    const noSuch = await seats(randomUUID());
    ok("  the same answer as an id that doesn't exist", !noSuch.ok && noSuch.error === MISSING, errorOf(noSuch));
    ok("  nor read it with its add-ons", (await addons.subscriptionWithAddons(alphaSub.id)) === null);
    as(salesA);
    const added = await seats(alphaSub.id);
    const addedId = added.ok ? added.data.id : "";
    ok("Asha adds two seats to it", added.ok && (await childrenOf(alphaSub.id)) === 1, errorOf(added));
    ok("  audited as an order, as every other order is", (await auditedAs(addedId)) === "Order", await auditedAs(addedId));
    const withAddons = await addons.subscriptionWithAddons(alphaSub.id);
    ok("  and reads it back with them", withAddons?.addons.length === 1, JSON.stringify(withAddons?.group ?? null));

    // ── Renewals ───────────────────────────────────────────────────────────────────────────────
    section("Renewals");
    as(salesB);
    ok("Bilal gets no renewal draft for Alpha's subscription", (await renewals.renewalDraft(alphaSub.id)) === null);
    const renewOutOfBook = await renewals.createRenewalOrder({ companyProductId: alphaSub.id });
    ok("  and can't renew it", !renewOutOfBook.ok && renewOutOfBook.error === MISSING && (await renewalsOf(alphaSub.id)) === 0, errorOf(renewOutOfBook));
    as(salesA);
    ok("Asha gets the draft", (await renewals.renewalDraft(alphaSub.id)) !== null);
    const renewed = await renewals.createRenewalOrder({ companyProductId: alphaSub.id });
    const renewedId = renewed.ok ? renewed.data.id : "";
    ok("  renews it — twelve seats, the two added included", renewed.ok && (await db.companyProduct.findUnique({ where: { id: renewedId }, select: { quantity: true } }))?.quantity === 12, errorOf(renewed));
    ok("  audited as an order", (await auditedAs(renewedId)) === "Order", await auditedAs(renewedId));

    // ── The reseller gate ──────────────────────────────────────────────────────────────────────
    section("A reseller whose onboarding isn't signed off");
    const suspended = (r: { ok: boolean; error?: string }) => !r.ok && (r.error ?? "").includes("reseller onboarding is suspended");
    const punchForReseller = await orders.createOrder({
      companyId: reseller.id,
      locationId: reseller.locationId,
      itemId: item.id,
      quantity: 1,
      unitPrice: 1000,
      businessType: "NEW",
      watcherUserIds: [],
      expenses: [],
    });
    ok("no order is punched for them", suspended(punchForReseller), errorOf(punchForReseller));
    const resellerSeats = await seats(resellerSub.id);
    ok("  no seats are added", suspended(resellerSeats) && (await childrenOf(resellerSub.id)) === 0, errorOf(resellerSeats));
    const resellerRenewal = await renewals.createRenewalOrder({ companyProductId: resellerSub.id });
    ok("  and nothing is renewed", suspended(resellerRenewal) && (await renewalsOf(resellerSub.id)) === 0, errorOf(resellerRenewal));
    await db.resellerProfile.update({ where: { companyId: reseller.id }, data: { status: "ACTIVE" } });
    const activeSeats = await seats(resellerSub.id);
    ok("once they're active, seats can be added", activeSeats.ok, errorOf(activeSeats));

    // ── The company page ───────────────────────────────────────────────────────────────────────
    section("The company page offers Add seats only to whom it will work for");
    const page = async (u: typeof salesA) => {
      as(u);
      return renderToStaticMarkup((await CompanyDetail({ id: alpha.id, tab: "products" })) as ReactElement);
    };
    const ashaPage = await page(salesA);
    ok("Asha, who may add seats, is offered them", ashaPage.includes(item.name) && ashaPage.includes("Add seats"));
    const viewerPage = await page(viewer);
    ok("  somebody who sees the subscription but raises no orders is not", viewerPage.includes(item.name) && !viewerPage.includes("Add seats"));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * check:rebates — backend rebates, negative calls and vendor credits (owner, 1 Oct 2026), against a
 * real database that is not the owner's.
 *
 * The pure part needs no database: the rebate maths, which programmes suggest themselves, the
 * reconciliation's deal-price check, a vendor credit's posting and how the close's tie-out reads one.
 *
 * The rest builds a scratch workspace database beside the real one (as check:payments-fx does), drives
 * the real actions as a workspace pointed at it (`runAsTenant`), and drops it at the end, pass or fail:
 *
 *   · punching: a deal registration and deal price kept; a backend rebate refused to an executive
 *     (no `rebates.view`) and taken from a manager; programmes suggested by brand, distributor and DR;
 *   · seeing: an order's rebates are null to an executive and worked out for a manager, and the order
 *     page shows them to one and not the other;
 *   · selling below cost: an approver without `orders.approveLoss` is refused, a manager approves (never
 *     on their own order), purchase buying for more is stopped with the price kept, the manager approves
 *     that price, and purchase buys;
 *   · targets: ORDER_MARGIN is the front margin — rebates never count;
 *   · a credit note with GST set against a rebate and a bill: the bill part paid, the ledger, AP's
 *     tie-out and GSTR-3B's input credit; over-allocating and a second CN-1 refused; a payout from the
 *     OEM into the bank; cancelling undoes it all; writing off and reopening; the report;
 *   · and the real workspace untouched.
 *
 *   npm run check:rebates
 *   TZ=UTC npm run check:rebates      (from PowerShell: $env:TZ = "UTC"; npm run check:rebates)
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import type { Prisma, PrismaClient } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";
import {
  expectedRebate,
  isBelowCost,
  matchingProgrammes,
  needsLossApproval,
  netMargin,
  rebateStanding,
  unitCostOf,
  type ProgrammeForMatch,
} from "../src/lib/rebates/rules";
import { reconcile, type SoldOrder, type StatementRow } from "../src/lib/reconcile/match";
import { postVendorCredit } from "../src/lib/ledger/posting";
import { openInRupees, type TieOutDocument } from "../src/lib/close/tieout";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const round2 = (n: number) => Math.round(n * 100) / 100;
const errorOf = (r: { ok: boolean; error?: string }) => (r.ok ? "ok" : r.error);

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

const TAG = "ZZREBATES";

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
  usePathname: () => "/orders",
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

function pure() {
  section("The rebate maths");
  ok(
    "the unit cost: what purchase paid, else the deal price, else the distributor's quote",
    unitCostOf({ purchasePrice: 900, dealPrice: 800, quotedPurchasePrice: 850 })?.from === "PURCHASE" &&
      unitCostOf({ dealPrice: 800, quotedPurchasePrice: 850 })?.cost === 800 &&
      unitCostOf({ quotedPurchasePrice: 850 })?.from === "QUOTE" &&
      unitCostOf({}) === null,
  );
  const o = { quantity: 2, unitPrice: 1000, unitCost: 800 };
  ok(
    "expected: 20% of what we pay on two at ₹800 is ₹320; 4% of what we sell for is ₹80; a fixed ₹500 is ₹500",
    expectedRebate({ basis: "PURCHASE_VALUE", rate: 20 }, o) === 320 &&
      expectedRebate({ basis: "SALE_VALUE", rate: 4 }, o) === 80 &&
      expectedRebate({ basis: "AMOUNT", amount: 500 }, o) === 500,
  );
  ok("  and not known while the cost isn't", expectedRebate({ basis: "PURCHASE_VALUE", rate: 20 }, { ...o, unitCost: null }) === null);
  const part = rebateStanding(160, 100, false);
  const off = rebateStanding(160, 100, true);
  ok("₹100 of ₹160 in: ₹60 still to come", part.received === 100 && part.outstanding === 60 && part.known);
  ok("  written off: nothing to come, the ₹100 still received", off.outstanding === 0 && off.received === 100 && off.writtenOff);
  ok("  unknown expected reads as nothing, and says so", rebateStanding(null, 0, false).known === false);
  ok("net margin: the front margin plus what rebates bring", netMargin(200, [part]) === 360 && netMargin(200, [off]) === 300 && netMargin(null, [part]) === null);
  ok(
    "below cost: under the unit cost by a paisa or more; unknown either way is not",
    isBelowCost(1000, 1100) && !isBelowCost(1000, 1000.004) && !isBelowCost(null, 1100) && !isBelowCost(1000, null),
  );
  ok(
    "an approval at ₹1,100 covers buying at ₹1,100, not at ₹1,150",
    !needsLossApproval({ unitPrice: 1000, unitCost: 1100, lossApprovedCost: 1100 }) &&
      needsLossApproval({ unitPrice: 1000, unitCost: 1150, lossApprovedCost: 1100 }) &&
      needsLossApproval({ unitPrice: 1000, unitCost: 1100, lossApprovedCost: null }),
  );

  section("Which programmes suggest themselves");
  const p = (over: Partial<ProgrammeForMatch>): ProgrammeForMatch => ({
    id: "p", brandId: null, vendorId: null, needsDealRegistration: false, validFrom: null, validTo: null, active: true, ...over,
  });
  const order = { brandId: "adobe", vendorId: "ingram", dealRegStatus: "APPROVED" as const, on: "2026-10-02" };
  const ids = (ps: ProgrammeForMatch[], o2 = order) => matchingProgrammes(ps, o2).map((x) => x.id).join(",");
  ok("the brand's, any brand's; not another brand's", ids([p({ id: "a", brandId: "adobe" }), p({ id: "any" }), p({ id: "ms", brandId: "microsoft" })]) === "a,any");
  ok("  through this distributor or any; not through another", ids([p({ id: "i", vendorId: "ingram" }), p({ id: "r", vendorId: "redington" })]) === "i");
  ok(
    "  one needing a deal registration only once it is approved",
    ids([p({ id: "dr", needsDealRegistration: true })]) === "dr" && ids([p({ id: "dr", needsDealRegistration: true })], { ...order, dealRegStatus: "APPLIED" as never }) === "",
  );
  ok(
    "  in date by India's calendar day, both ends inclusive; never an inactive one",
    ids([p({ id: "x", validFrom: new Date("2026-10-02T00:00:00Z"), validTo: new Date("2026-10-02T00:00:00Z") })]) === "x" &&
      ids([p({ id: "x", validTo: new Date("2026-10-01T00:00:00Z") })]) === "" &&
      ids([p({ id: "x", active: false })]) === "",
  );

  section("Reconciling a distributor's bill against the deal price");
  const sold = (over: Partial<SoldOrder> = {}): SoldOrder => ({
    orderId: "ord-1", companyId: "co-1", companyName: "Acme Industries", aliases: [], sku: "65304477BA01A12", quantity: 10,
    purchasePrice: 8400, dealPrice: 8400, startDate: new Date("2026-01-01"), endDate: new Date("2026-12-31"), ...over,
  });
  const row = (over: Partial<StatementRow> = {}): StatementRow => ({
    rowNumber: 1, sku: "65304477BA01A12", customerRef: "Acme Industries", quantity: 10, unitCost: 700, lineTotal: 7000, ...over,
  });
  const september = { start: new Date("2026-09-01"), end: new Date("2026-09-30") };
  const at = (r: StatementRow, s: SoldOrder) => reconcile([r], [s], september, { billing: "MONTHLY" }).lines[0]!;
  const fair = at(row(), sold());
  ok("billed at the deal price (₹8,400 a year, ₹700 a month): matched", fair.state === "MATCHED", `${fair.state} ${fair.note}`);
  const above = at(row({ unitCost: 750, lineTotal: 7500 }), sold({ purchasePrice: 9000 }));
  ok(
    "billed ₹750 against a ₹700 deal — even with purchase's ₹9,000 a year recorded — flagged: the deal price wasn't applied",
    above.state === "PRICE_MISMATCH" && above.variance === 500 && above.note.includes("deal price"),
    `${above.state} ${above.variance} ${above.note}`,
  );
  const noDeal = at(row({ unitCost: 750, lineTotal: 7500 }), sold({ purchasePrice: 9000, dealPrice: null }));
  ok("  without a deal price the same bill matches what purchase paid", noDeal.state === "MATCHED", `${noDeal.state} ${noDeal.note}`);

  section("A vendor credit's posting, and how the close reads one");
  const balanced = (lines: { debit: number; credit: number }[]) => round2(lines.reduce((t, l) => t + l.debit - l.credit, 0)) === 0;
  const cn = postVendorCredit({ form: "CREDIT_NOTE", vendorId: "ingram", vendorName: "Ingram", reference: "CN-1", taxable: 160, cgst: 0, sgst: 0, igst: 28.8, total: 188.8 });
  const by = (d: typeof cn, key: string) => d.lines.find((l) => l.account === key);
  ok(
    "a credit note: Dr AP 188.80 (the distributor's), Cr Purchase Rebates 160, Cr Input IGST 28.80 — balanced",
    by(cn, "AP")?.debit === 188.8 && by(cn, "AP")?.companyId === "ingram" && by(cn, "PURCHASE_REBATES")?.credit === 160 && by(cn, "INPUT_IGST")?.credit === 28.8 && balanced(cn.lines) && cn.lines.length === 3,
    cn.lines.map((l) => `${l.account} ${l.debit}/${l.credit}`).join(", "),
  );
  const payout = postVendorCredit({ form: "PAYOUT", vendorId: "adobe", vendorName: "Adobe", reference: "PAY-1", taxable: 500, cgst: 0, sgst: 0, igst: 0, total: 500, bankLedgerAccountId: "acct-hdfc" });
  ok(
    "a payout: Dr the bank it came into 500, Cr Purchase Rebates 500 — nothing on AP",
    by(payout, "BANK")?.debit === 500 && by(payout, "BANK")?.accountIdOverride === "acct-hdfc" && by(payout, "PURCHASE_REBATES")?.credit === 500 && !by(payout, "AP") && balanced(payout.lines),
  );
  const doc = (over: Partial<TieOutDocument>): TieOutDocument => ({
    id: "d", docNumber: "CN-1", docType: "VENDOR_CREDIT", companyId: "ingram", companyName: "Ingram", currency: "INR", rate: 1,
    total: 188.8, allocated: 0, credited: 0, applied: 0, posted: -188.8, hasEntry: true, entryNumbers: [], ...over,
  });
  ok("the tie-out reads a vendor credit note as a credit note: −188.80 open, −88.80 once 100 is set against a bill", openInRupees(doc({})) === -188.8 && openInRupees(doc({ applied: 100 })) === -88.8);
  ok("  and a bill with 188.80 of vendor credit set against it as 4,811.20 open", openInRupees(doc({ docType: "BILL", docNumber: "B-1", total: 5000, credited: 188.8 })) === 4811.2);
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
  const scratchName = `${realName}_rebates`;
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

    // From here on anything reaching for the environment's workspace lands in the scratch one too, and
    // the control plane is switched off by value (a Prisma client reloads .env for a missing variable).
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
  ok("its programmes, rebates, vendor credits, orders and journal are as they were", realAfter.counts === realBefore.counts, realAfter.counts);
  ok("  and nothing of this suite's is in it", realAfter.tagged === 0 && realBefore.tagged === 0, realAfter.tagged);

  console.log(failures === 0 ? `\nAll ${passes} rebates checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/** What the suite must never change in the real workspace. Read-only. */
async function snapshot(client: PrismaClient) {
  const [programmes, rebates, credits, orders, entries, tagged] = await Promise.all([
    client.rebateProgramme.count(),
    client.orderRebate.count(),
    client.vendorCredit.count(),
    client.companyProduct.count(),
    client.journalEntry.count(),
    client.company.count({ where: { name: { startsWith: TAG } } }),
  ]);
  return { counts: JSON.stringify({ programmes, rebates, credits, orders, entries }), tagged };
}

// ── The suite ───────────────────────────────────────────────────────────────────────────────────

async function run(scratchUrl: string) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db, getTenantDb } = require("../src/lib/db") as typeof import("../src/lib/db");
  const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
  const journal = require("../src/lib/ledger/journal") as typeof import("../src/lib/ledger/journal");
  const { SYSTEM_ACCOUNTS } = require("../src/lib/ledger/chart") as typeof import("../src/lib/ledger/chart");
  const { loadTieOut, tieOut } = require("../src/lib/close/tieout") as typeof import("../src/lib/close/tieout");
  const months = require("../src/lib/close/months") as typeof import("../src/lib/close/months");
  // The workspace sets no zone, so its today is India's — and GSTR-3B's month is India's in every workspace.
  const { indiaClock } = require("../src/lib/time/zone") as typeof import("../src/lib/time/zone");
  const { measure } = require("../src/lib/targets/measure") as typeof import("../src/lib/targets/measure");
  const orders = require("../src/actions/order") as typeof import("../src/actions/order");
  const rebates = require("../src/actions/rebate") as typeof import("../src/actions/rebate");
  const credits = require("../src/actions/vendor-credit") as typeof import("../src/actions/vendor-credit");
  const tax = require("../src/actions/tax-reports") as typeof import("../src/actions/tax-reports");
  const { executeMerge } = require("../src/lib/companies/merge") as typeof import("../src/lib/companies/merge");
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  const { OrderDetail } = require("../src/components/orders/order-detail") as typeof import("../src/components/orders/order-detail");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const tenant = {
    id: randomUUID(),
    slug: "zzrebates",
    name: "zzrebates",
    status: "ACTIVE" as const,
    dbUrl: scratchUrl,
    primaryHost: "zzrebates.localhost",
    hosts: ["zzrebates.localhost"],
    source: "env" as const,
    isDefault: false,
    keyBundleCipher: null,
    country: "IN",
    entitlements: { v: 1 as const, all: true, modules: [], seats: null, copilotTokens: null, customDomains: null, plans: [] },
    holdReason: null,
  };

  await runAsTenant(tenant, async () => {
    const today = indiaClock.today();

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
    const base = { "orders.view": true, "orders.approve": false, "orders.process": false, "orders.approveLoss": false, "rebates.view": false, "rebates.manage": false };
    const owner = await user("Owner", {}, { isSuperAdmin: true, role: "ADMIN" });
    const exec = await user("Executive", { ...base, "companies.viewAll": false });
    const manager = await user("Manager", { ...base, "companies.viewAll": true, "rebates.view": true, "orders.approveLoss": true });
    const approver = await user("Approver", { ...base, "companies.viewAll": true, "orders.approve": true, "credit.override": true });
    const buyer = await user("Buyer", { ...base, "companies.viewAll": true, "orders.process": true });
    const accounts = await user("Accounts", { ...base, "companies.viewAll": true, "rebates.view": true, "rebates.manage": true });
    const as = (u: { id: string; name: string; email: string; role: string }) => {
      actor = u;
    };
    await db.branch.create({ data: { name: `${TAG} Head office`, code: "HO", isHeadOffice: true } });
    await journal.ensureChartOfAccounts(db);

    const company = (name: string, data: Partial<Prisma.CompanyUncheckedCreateInput> = {}) =>
      db.company.create({
        data: { name: `${TAG} ${name}`, normalizedName: `${TAG} ${name}`.toLowerCase(), createdById: owner.id, ...data },
        select: { id: true, name: true },
      });
    const customer = await company("Customer", { ownerUserId: exec.id, relationshipType: "CLIENT", stage: "CUSTOMER", paymentTerms: "ADVANCE" });
    const ingram = await company("Ingram", { relationshipType: "DISTRIBUTOR" });
    const redington = await company("Redington", { relationshipType: "DISTRIBUTOR" });
    const microsoft = await company("Microsoft", { relationshipType: "OEM" });
    const location = await db.companyLocation.create({ data: { companyId: customer.id, label: "Head Office", isPrimary: true } });
    const adobe = await db.brand.create({ data: { name: `${TAG} Adobe` } });
    const msBrand = await db.brand.create({ data: { name: `${TAG} Microsoft` } });
    const item = (name: string, brandId: string) =>
      db.item.create({ data: { name: `${TAG} ${name}`, sku: `${TAG}-${name}`, type: "SERVICE", sellingPrice: 1000, taxRatePercent: 18, brandId, createdById: owner.id } });
    const acrobat = await item("Acrobat", adobe.id);
    const m365 = await item("M365", msBrand.id);
    ok("an owner, an executive, a manager, an approver, a buyer, accounts; a customer, two distributors, an OEM, two brands", true);

    const punch = (itemId: string, extra: Record<string, unknown> = {}) =>
      orders.createOrder({ companyId: customer.id, locationId: location.id, itemId, quantity: 1, unitPrice: 1000, businessType: "NEW", watcherUserIds: [], expenses: [], ...extra });
    const row = (id: string) => db.companyProduct.findUniqueOrThrow({ where: { id } });
    const idOf = (r: { ok: boolean; data?: unknown; error?: string }) => {
      if (!r.ok) throw new Error(`the action refused: ${r.error}`);
      return (r.data as { id: string }).id;
    };

    // ── Programmes ─────────────────────────────────────────────────────────────────────────────
    section("Rebate programmes");
    const programme = {
      name: "Adobe deal registration", brandId: adobe.id, vendorId: "", basis: "PURCHASE_VALUE", rate: "20",
      needsDealRegistration: true, payer: "DISTRIBUTOR", settlement: "CREDIT_NOTE", validFrom: "", validTo: "", active: true, notes: "",
    };
    as(manager);
    const refusedProgramme = await rebates.saveRebateProgramme(programme);
    ok("a manager who sees rebates can't set up a programme — that's rebates.manage", !refusedProgramme.ok, errorOf(refusedProgramme));
    as(accounts);
    const adobeProgramme = idOf(await rebates.saveRebateProgramme(programme));
    const msProgramme = idOf(
      await rebates.saveRebateProgramme({ ...programme, name: "Microsoft through Redington", brandId: msBrand.id, vendorId: redington.id, rate: "4", needsDealRegistration: false }),
    );
    ok("accounts sets up Adobe's 20% with an approved DR, and Microsoft's 4% through Redington", !!adobeProgramme && !!msProgramme);
    as(exec);
    ok("  an executive's list is empty", (await rebates.listRebateProgrammes()) === null || (await rebates.listRebateProgrammes())?.programmes.length === 0);

    section("Suggested as the order is punched");
    as(exec);
    ok("to an executive, nothing", (await rebates.suggestOrderRebates({ itemId: acrobat.id, dealRegStatus: "APPROVED" })).length === 0);
    as(manager);
    const approvedDr = await rebates.suggestOrderRebates({ itemId: acrobat.id, dealRegStatus: "APPROVED" });
    ok("to a manager: Adobe's, once the DR is approved", approvedDr.length === 1 && approvedDr[0]!.id === adobeProgramme && approvedDr[0]!.rate === 20, JSON.stringify(approvedDr));
    ok("  not while it is only applied for", (await rebates.suggestOrderRebates({ itemId: acrobat.id, dealRegStatus: "APPLIED" })).length === 0);
    ok(
      "  Microsoft's only through Redington, paid by Redington",
      (await rebates.suggestOrderRebates({ itemId: m365.id, vendorId: ingram.id })).length === 0 &&
        (await rebates.suggestOrderRebates({ itemId: m365.id, vendorId: redington.id }))[0]?.payerCompanyId === redington.id,
    );

    // ── Punching ───────────────────────────────────────────────────────────────────────────────
    section("Punching: the deal registration, and who may enter a rebate");
    const rebate20 = { programmeId: adobeProgramme, basis: "PURCHASE_VALUE", value: "20", payer: "DISTRIBUTOR", payerCompanyId: ingram.id, settlement: "CREDIT_NOTE", note: "" };
    const dr = { dealRegStatus: "APPROVED", dealRegNumber: `${TAG}-DR-123`, dealRegValidTo: "2026-12-31", dealPrice: "800" };
    as(exec);
    const execRebate = await punch(acrobat.id, { ...dr, rebates: [rebate20] });
    ok("an executive punching a backend rebate is refused", !execRebate.ok && execRebate.error.includes("backend rebate"), errorOf(execRebate));
    const orderA = idOf(await punch(acrobat.id, dr));
    const a0 = await row(orderA);
    ok(
      "  without one, the order keeps the DR — approved, its number, valid to 31 Dec — and the ₹800 deal price",
      a0.dealRegStatus === "APPROVED" && a0.dealRegNumber === `${TAG}-DR-123` && a0.dealRegValidTo?.toISOString().slice(0, 10) === "2026-12-31" && Number(a0.dealPrice) === 800,
    );
    as(exec);
    ok("the executive can't see the order's rebates", (await rebates.getOrderRebates(orderA)) === null);
    const execSave = await rebates.saveOrderRebate({ orderId: orderA, rebate: rebate20 });
    ok("  nor add one", !execSave.ok, errorOf(execSave));
    as(manager);
    const rebateA = idOf(await rebates.saveOrderRebate({ orderId: orderA, rebate: rebate20 }));
    const sumA = await rebates.getOrderRebates(orderA);
    ok(
      "the manager adds Adobe's 20%: expected ₹160 on the ₹800 deal price; front margin ₹200, net ₹360",
      sumA?.totals.expected === 160 && sumA.front === 200 && sumA.net === 360 && sumA.costFrom === "DEAL" && sumA.rebates[0]?.id === rebateA,
      JSON.stringify(sumA?.totals),
    );
    as(manager);
    const orderD = idOf(
      await punch(m365.id, { rebates: [{ basis: "AMOUNT", value: "500", payer: "OEM", payerCompanyId: microsoft.id, settlement: "PAYOUT", note: "Quarter-end incentive" }] }),
    );
    const sumD = await rebates.getOrderRebates(orderD);
    const rebateD = sumD?.rebates[0]?.id ?? "";
    ok("a manager punches one with a fixed ₹500 from the OEM, paid out", sumD?.totals.expected === 500 && sumD.rebates[0]?.payer === "OEM" && sumD.rebates[0]?.settlement === "PAYOUT");

    as(approver);
    idOf(await orders.approveOrder({ orderId: orderA, approved: true, creditOverrideReason: "Advance PO on file" }));
    idOf(await orders.approveOrder({ orderId: orderD, approved: true, creditOverrideReason: "Advance PO on file" }));
    as(buyer);
    const boughtA = await orders.processOrder({ orderId: orderA, vendorId: ingram.id, purchasePrice: 800 });
    const boughtD = await orders.processOrder({ orderId: orderD, vendorId: redington.id, purchasePrice: 900 });
    ok("approved and bought: Acrobat at its ₹800 deal price from Ingram, M365 at ₹900", boughtA.ok && boughtD.ok, `${errorOf(boughtA)} / ${errorOf(boughtD)}`);
    as(manager);
    ok("  the rebate now worked out on what purchase paid: still ₹160", (await rebates.getOrderRebates(orderA))?.rebates[0]?.expected === 160);

    // ── The order page ─────────────────────────────────────────────────────────────────────────
    section("The order page");
    const page = async (id: string, who: typeof exec) => {
      as(who);
      return textOf(renderToStaticMarkup((await resolveAsync(createElement(OrderDetail, { id }))) as ReactElement));
    };
    const execPage = await page(orderA, exec);
    const managerPage = await page(orderA, manager);
    ok("the executive sees the deal registration and its number", execPage.includes("Deal registration") && execPage.includes(`${TAG}-DR-123`));
    ok("  but no backend rebate and no net margin", !execPage.includes("Backend rebate") && !execPage.includes("Net margin") && !execPage.includes("160"));
    ok("the manager sees the backend rebate and the net margin", managerPage.includes("Backend rebate") && managerPage.includes("Net margin") && managerPage.includes("Adobe deal registration"));

    // ── Selling below cost ─────────────────────────────────────────────────────────────────────
    section("Selling below cost");
    as(exec);
    const orderB = idOf(await punch(acrobat.id, { dealRegStatus: "APPLIED", dealPrice: "1100" }));
    ok("an executive punches one at ₹1,000 against a ₹1,100 deal price — punched, not stopped", !!orderB);
    as(approver);
    const plainApprove = await orders.approveOrder({ orderId: orderB, approved: true, creditOverrideReason: "Advance PO on file" });
    ok(
      "an approver without “Approve orders sold below cost” is refused, and told why",
      !plainApprove.ok && plainApprove.error.includes("₹100") && plainApprove.error.includes("Approve orders sold below cost"),
      errorOf(plainApprove),
    );
    as(exec);
    const execLoss = await orders.approveOrderLoss({ orderId: orderB, note: "Strategic account" });
    ok("  the executive can't approve it either", !execLoss.ok, errorOf(execLoss));
    as(manager);
    const ownC = idOf(await punch(acrobat.id, { dealPrice: "1200" }));
    const ownLoss = await orders.approveOrderLoss({ orderId: ownC, note: "My own negative call" });
    ok("a manager can't approve a negative call on their own order", !ownLoss.ok, errorOf(ownLoss));
    const lossB = await orders.approveOrderLoss({ orderId: orderB, note: "Strategic account — wins the renewal" });
    const b1 = await row(orderB);
    ok(
      "  on the executive's: approved at ₹1,100, by them, with the reason",
      lossB.ok && Number(b1.lossApprovedCost) === 1100 && b1.lossApprovedById === manager.id && b1.lossApprovalNote === "Strategic account — wins the renewal",
      errorOf(lossB),
    );
    ok(
      "  and the executive is told",
      (await db.notification.count({ where: { userId: exec.id, link: `/orders/${orderB}`, title: { contains: "below cost approved" } } })) === 1,
    );
    as(approver);
    idOf(await orders.approveOrder({ orderId: orderB, approved: true, creditOverrideReason: "Advance PO on file" }));
    ok("the approver approves it now", (await row(orderB)).orderStatus === "APPROVED");
    as(buyer);
    const dearer = await orders.processOrder({ orderId: orderB, vendorId: ingram.id, purchasePrice: 1150 });
    const b2 = await row(orderB);
    ok(
      "purchase finds it at ₹1,150 — more than approved — and is stopped, the price kept for the manager",
      !dearer.ok && dearer.error.includes("₹150") && Number(b2.lossRequestedCost) === 1150 && !!b2.lossRequestedAt && b2.orderStatus === "APPROVED",
      errorOf(dearer),
    );
    ok(
      "  the manager is asked",
      (await db.notification.count({ where: { userId: manager.id, link: `/orders/${orderB}`, title: { contains: "needs your approval" } } })) >= 1,
    );
    as(manager);
    const again = await orders.approveOrderLoss({ orderId: orderB, note: "Still worth it at ₹1,150" });
    const b3 = await row(orderB);
    ok("the manager approves that price: ₹1,150, the request cleared", again.ok && Number(b3.lossApprovedCost) === 1150 && b3.lossRequestedCost === null, errorOf(again));
    as(buyer);
    const boughtB = await orders.processOrder({ orderId: orderB, vendorId: ingram.id, purchasePrice: 1150 });
    ok("  and purchase buys it", boughtB.ok && (await row(orderB)).orderStatus === "PROCESSING", errorOf(boughtB));
    as(manager);
    const cheapB = await orders.approveOrderLoss({ orderId: orderA, note: "Nothing to approve here" });
    ok("an order that isn't below cost has nothing to approve", !cheapB.ok && cheapB.error.includes("nothing to approve"), errorOf(cheapB));

    section("Targets count the front margin only");
    // A target's window is calendar days, held as UTC midnights (src/lib/targets/measure.ts rangeOf): today in India.
    const day = new Date(`${today}T00:00:00.000Z`);
    const margin = await measure(await getTenantDb(), "ORDER_MARGIN", { from: day, to: day, userIds: [exec.id] });
    ok("the executive's ORDER_MARGIN: ₹200 on Acrobat less ₹150 on the negative call — ₹50, the ₹160 rebate not in it", margin === 50, margin);

    // ── A credit note ──────────────────────────────────────────────────────────────────────────
    section("A credit note from Ingram, with GST, against the rebate and a bill");
    const bill = await db.tradeDocument.create({
      data: {
        docNumber: `${TAG}-BILL-1`, docType: "BILL", direction: "PURCHASE", status: "ISSUED", companyId: ingram.id, createdById: owner.id,
        issueDate: new Date(), currency: "INR", exchangeRate: 1, subtotal: 5000, taxableValue: 5000, total: 5000,
      },
      select: { id: true },
    });
    await db.$transaction((t) => journal.postDocumentToLedger(t, bill.id, owner.id), { timeout: 60_000 });
    const party = async (key: string, companyId: string) => {
      const s = await db.journalLine.aggregate({ where: { account: { systemKey: key }, companyId }, _sum: { debit: true, credit: true } });
      return round2(Number(s._sum.debit ?? 0) - Number(s._sum.credit ?? 0));
    };
    const balance = async (key: string) => {
      const s = await db.journalLine.aggregate({ where: { account: { systemKey: key } }, _sum: { debit: true, credit: true } });
      return round2(Number(s._sum.debit ?? 0) - Number(s._sum.credit ?? 0));
    };
    const statusOf = async (id: string) => (await db.tradeDocument.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
    const { year, month } = indiaClock.parts(new Date());
    as(owner);
    const before3b = await tax.gstr3b({ month: month + 1, year });

    const cnInput = {
      vendorId: ingram.id, form: "CREDIT_NOTE", kind: "REBATE", reference: `${TAG}-CN-1`, date: today,
      taxableAmount: "160", cgstAmount: "", sgstAmount: "", igstAmount: "28.8", bankAccountId: "", notes: "",
      allocations: [{ orderRebateId: rebateA, amount: "160" }],
      applications: [{ billId: bill.id, amount: "188.8" }],
    };
    as(manager);
    const managerCn = await credits.createVendorCredit(cnInput);
    ok("a manager who only sees rebates can't record it", !managerCn.ok, errorOf(managerCn));
    as(accounts);
    const tooMuch = await credits.createVendorCredit({ ...cnInput, allocations: [{ orderRebateId: rebateA, amount: "170" }] });
    ok(
      "₹170 against the rebate is refused — more than the ₹160 before GST — and nothing is kept",
      !tooMuch.ok && tooMuch.error.includes("₹160") && (await db.vendorCredit.count()) === 0 && (await db.journalEntry.count({ where: { source: "VENDOR_CREDIT" } })) === 0,
      errorOf(tooMuch),
    );
    const cn1 = idOf(await credits.createVendorCredit(cnInput));
    ok("recorded: ₹160 + ₹28.80 IGST", (await db.vendorCredit.findUniqueOrThrow({ where: { id: cn1 } })).total.toString() === "188.8");
    as(manager);
    const afterCn = await rebates.getOrderRebates(orderA);
    ok("the rebate is received: ₹160 in, nothing to come, net margin ₹360", afterCn?.totals.received === 160 && afterCn.totals.outstanding === 0 && afterCn.net === 360, JSON.stringify(afterCn?.totals));
    as(accounts);
    const opts = await credits.vendorCreditOptions(ingram.id);
    ok(
      "the bill is part paid, ₹4,811.20 still owed, and the rebate no longer offered",
      (await statusOf(bill.id)) === "PARTIALLY_PAID" && opts?.bills.find((b) => b.id === bill.id)?.balance === 4811.2 && !opts.rebates.some((r) => r.orderRebateId === rebateA),
      JSON.stringify(opts?.bills),
    );
    const entry = await db.journalEntry.findFirst({
      where: { vendorCreditId: cn1, reversesId: null },
      select: { source: true, lines: { select: { debit: true, credit: true, companyId: true, account: { select: { systemKey: true } } } } },
    });
    const ln = (key: string) => entry?.lines.find((l) => l.account.systemKey === key);
    ok(
      "posted: Dr AP 188.80 on Ingram, Cr Purchase Rebates 160, Cr Input IGST 28.80",
      entry?.source === "VENDOR_CREDIT" && Number(ln("AP")?.debit) === 188.8 && ln("AP")?.companyId === ingram.id && Number(ln("PURCHASE_REBATES")?.credit) === 160 && Number(ln("INPUT_IGST")?.credit) === 28.8,
    );
    ok("  Ingram's AP is ₹4,811.20", (await party(SYSTEM_ACCOUNTS.AP, ingram.id)) === -4811.2, await party(SYSTEM_ACCOUNTS.AP, ingram.id));
    const monthKey = months.parseMonthKey(today.slice(0, 7))!;
    const ap1 = tieOut(await loadTieOut("AP", monthKey));
    ok("  the close's AP tie-out agrees with the ledger", ap1.detail.difference === 0, `${ap1.detail.ageing} vs ${ap1.detail.ledger}`);
    as(owner);
    const after3b = await tax.gstr3b({ month: month + 1, year });
    ok(
      "  and GSTR-3B's input IGST goes down by ₹28.80",
      round2((after3b?.inward.igst ?? NaN) - (before3b?.inward.igst ?? NaN)) === -28.8,
      `${before3b?.inward.igst} → ${after3b?.inward.igst}`,
    );
    as(accounts);
    const dup = await credits.createVendorCredit({ ...cnInput, allocations: [], applications: [] });
    ok("the same CN number from Ingram again is refused", !dup.ok && dup.error.includes("recorded already"), errorOf(dup));
    const removeA = await rebates.removeOrderRebate(rebateA);
    ok("  a rebate money has come in against can't be removed", !removeA.ok, errorOf(removeA));
    const dropProgramme = await rebates.deleteRebateProgramme(adobeProgramme);
    ok("  nor a programme an order uses", !dropProgramme.ok, errorOf(dropProgramme));

    section("A payout from the OEM");
    const bank0 = await balance(SYSTEM_ACCOUNTS.BANK);
    const rebates0 = await balance(SYSTEM_ACCOUNTS.PURCHASE_REBATES);
    const payoutBills = await credits.createVendorCredit({ ...cnInput, vendorId: microsoft.id, form: "PAYOUT", reference: `${TAG}-PAY-1`, taxableAmount: "500", igstAmount: "", allocations: [], applications: [{ billId: bill.id, amount: "100" }] });
    ok("money into the bank can't be set against a bill", !payoutBills.ok, errorOf(payoutBills));
    idOf(
      await credits.createVendorCredit({ ...cnInput, vendorId: microsoft.id, form: "PAYOUT", reference: `${TAG}-PAY-1`, taxableAmount: "500", igstAmount: "", allocations: [{ orderRebateId: rebateD, amount: "500" }], applications: [] }),
    );
    as(manager);
    ok("Microsoft's ₹500 received against the M365 order", (await rebates.getOrderRebates(orderD))?.totals.received === 500);
    ok(
      "  the bank up ₹500, Purchase Rebates credited ₹500, nothing on AP",
      round2((await balance(SYSTEM_ACCOUNTS.BANK)) - bank0) === 500 && round2((await balance(SYSTEM_ACCOUNTS.PURCHASE_REBATES)) - rebates0) === -500 && (await party(SYSTEM_ACCOUNTS.AP, microsoft.id)) === 0,
    );

    section("Writing off, reopening, cancelling");
    as(manager);
    const managerOff = await rebates.writeOffOrderRebate({ rebateId: rebateD, reason: "Microsoft won't pay the rest" });
    ok("writing off is rebates.manage — not the manager's", !managerOff.ok, errorOf(managerOff));
    as(accounts);
    const cancelled = await credits.cancelVendorCredit({ vendorCreditId: cn1, reason: "Ingram reissued it as CN-2" });
    ok("Ingram's credit note cancelled", cancelled.ok, errorOf(cancelled));
    as(manager);
    const reopened = await rebates.getOrderRebates(orderA);
    ok("  the rebate is due again: ₹160 to come", reopened?.totals.received === 0 && reopened.totals.outstanding === 160, JSON.stringify(reopened?.totals));
    ok("  the bill owes all ₹5,000 again", (await statusOf(bill.id)) === "ISSUED" && (await party(SYSTEM_ACCOUNTS.AP, ingram.id)) === -5000);
    const reversal = await db.journalEntry.findFirst({ where: { vendorCreditId: cn1, reversesId: { not: null } }, select: { source: true } });
    ok("  its posting reversed", reversal?.source === "VENDOR_CREDIT");
    const ap2 = tieOut(await loadTieOut("AP", monthKey));
    ok("  AP's tie-out still agrees", ap2.detail.difference === 0, `${ap2.detail.ageing} vs ${ap2.detail.ledger}`);
    as(owner);
    const cancelled3b = await tax.gstr3b({ month: month + 1, year });
    ok("  and GSTR-3B's input credit is as it was", cancelled3b?.inward.igst === before3b?.inward.igst, `${before3b?.inward.igst} → ${cancelled3b?.inward.igst}`);

    as(accounts);
    const off = await rebates.writeOffOrderRebate({ rebateId: rebateA, reason: "Ingram says the DR lapsed" });
    as(manager);
    const offSum = await rebates.getOrderRebates(orderA);
    ok("accounts writes Acrobat's off: nothing to come, net margin back to the ₹200 front", off.ok && offSum?.totals.outstanding === 0 && offSum.net === 200, errorOf(off));
    as(accounts);
    const toWrittenOff = await credits.createVendorCredit({ ...cnInput, reference: `${TAG}-CN-2`, applications: [] });
    ok("  a credit can't be set against a written-off rebate", !toWrittenOff.ok && toWrittenOff.error.includes("written off"), errorOf(toWrittenOff));
    const back = await rebates.reopenOrderRebate(rebateA);
    const cn2 = idOf(await credits.createVendorCredit({ ...cnInput, reference: `${TAG}-CN-2`, applications: [] }));
    ok("  reopened, it is due again — and CN-2 takes the ₹160", back.ok && !!cn2);

    section("The report");
    as(exec);
    ok("an executive gets no report", (await rebates.rebatesReport({ from: today, to: today })) === null);
    as(manager);
    const report = await rebates.rebatesReport({ from: today, to: today });
    ok(
      "a manager's: Acrobat and M365, ₹660 expected, ₹660 received",
      report?.rows.length === 2 && report.totals.expected === 660 && report.totals.received === 660 && report.totals.outstanding === 0,
      JSON.stringify(report?.totals),
    );
    ok("  by who pays — Ingram and Microsoft — and by brand", report?.byPayer.length === 2 && report.byBrand.length === 2 && report.byQuarter.length === 1);

    // ── The screens ────────────────────────────────────────────────────────────────────────────
    section("The screens, rendered as each would see them");
    const screen = async (who: typeof exec, el: ReactElement) => {
      as(who);
      return textOf(renderToStaticMarkup((await resolveAsync(el)) as ReactElement));
    };
    const pageOf = (file: string) => (require(file) as { default: (p: never) => Promise<ReactElement> }).default; // eslint-disable-line @typescript-eslint/no-require-imports
    const NewOrderPage = pageOf("../src/app/(dashboard)/orders/new/page");
    const RebatesPage = pageOf("../src/app/(dashboard)/orders/rebates/page");
    const CreditsPage = pageOf("../src/app/(dashboard)/purchase/vendor-credits/page");
    const NewCreditPage = pageOf("../src/app/(dashboard)/purchase/vendor-credits/new/page");
    const CreditPage = pageOf("../src/app/(dashboard)/purchase/vendor-credits/[id]/page");
    const ProgrammesPage = pageOf("../src/app/(dashboard)/settings/rebate-programmes/page");
    const el = (page: (p: never) => Promise<ReactElement>, props: Record<string, unknown> = {}) => createElement(page as never, props);

    const formFor = (who: typeof exec) => screen(who, el(NewOrderPage, { searchParams: Promise.resolve({ companyId: customer.id }) }));
    const execForm = await formFor(exec);
    const managerForm = await formFor(manager);
    ok("the order form: the executive gets the deal registration, not the backend rebate", execForm.includes("Deal registration") && !execForm.includes("Backend rebate"));
    ok("  the manager gets both", managerForm.includes("Deal registration") && managerForm.includes("Backend rebate"));

    const range = { searchParams: Promise.resolve({ from: today, to: today }) };
    const execReport = await screen(exec, el(RebatesPage, range));
    const managerReport = await screen(manager, el(RebatesPage, range));
    ok("the report: the executive is told it isn't theirs", execReport.includes("for whoever can see backend rebates") && !execReport.includes(customer.name));
    ok(
      "  the manager sees both orders, who pays and the brands",
      managerReport.includes("ORD-000001") && managerReport.includes("ORD-000002") && managerReport.includes(ingram.name) && managerReport.includes(`${TAG} Adobe`),
    );

    const execCredits = await screen(exec, el(CreditsPage));
    const managerCredits = await screen(manager, el(CreditsPage));
    const accountsCredits = await screen(accounts, el(CreditsPage));
    ok("vendor credits: not the executive's", execCredits.includes("for whoever can see backend rebates") && !execCredits.includes(`${TAG}-CN-2`));
    ok(
      "  the manager sees the credit notes and the payout, and can't record one",
      managerCredits.includes(`${TAG}-CN-2`) && managerCredits.includes(`${TAG}-PAY-1`) && !managerCredits.includes("Record a credit"),
    );
    ok("  accounts can", accountsCredits.includes("Record a credit"));
    const managerNew = await screen(manager, el(NewCreditPage));
    const accountsNew = await screen(accounts, el(NewCreditPage));
    ok("recording one is for whoever manages rebates; accounts gets the form", managerNew.includes("for whoever manages rebates") && accountsNew.includes("Purchase Rebates") && !accountsNew.includes("for whoever manages rebates"));
    const creditPage = await screen(accounts, el(CreditPage, { params: Promise.resolve({ id: cn2 }) }));
    ok("CN-2's page: from Ingram, set against ORD-000001's rebate", creditPage.includes(`${TAG}-CN-2`) && creditPage.includes(ingram.name) && creditPage.includes("ORD-000001"));

    const settingsKey = (who: typeof exec) => screen(who, el(ProgrammesPage));
    const execProgrammes = await settingsKey(exec);
    const accountsProgrammes = await settingsKey(accounts);
    ok("the programmes page: not the executive's", execProgrammes.includes("permission") && !execProgrammes.includes("Adobe deal registration"));
    ok("  accounts sees Adobe's and Microsoft's", accountsProgrammes.includes("Adobe deal registration") && accountsProgrammes.includes("Microsoft through Redington"));

    // ── Merging a duplicate distributor ──────────────────────────────────────────────────────────
    section("Merging a duplicate distributor that holds a credit with the same number");
    const dupIngram = await company("Ingram duplicate", { relationshipType: "DISTRIBUTOR" });
    as(accounts);
    const twice = idOf(await credits.createVendorCredit({ ...cnInput, vendorId: dupIngram.id, reference: `${TAG}-CN-2`, allocations: [], applications: [] }));
    const only = idOf(await credits.createVendorCredit({ ...cnInput, vendorId: dupIngram.id, reference: `${TAG}-CN-3`, igstAmount: "", allocations: [], applications: [] }));
    await executeMerge({ keepId: ingram.id, dropId: dupIngram.id, choices: {}, combine: [], userId: owner.id });
    const after = await db.vendorCredit.findMany({ where: { vendorId: ingram.id }, orderBy: { reference: "asc" }, select: { id: true, reference: true } });
    const refs = after.map((c) => c.reference);
    ok(
      "both CN-2s stay under Ingram — the duplicate's marked “(merged)” — and its CN-3 moves across",
      refs.includes(`${TAG}-CN-2`) && after.find((c) => c.id === twice)?.reference === `${TAG}-CN-2 (merged)` && after.find((c) => c.id === only)?.reference === `${TAG}-CN-3` && after.find((c) => c.id === cn2)?.reference === `${TAG}-CN-2`,
      refs.join(", "),
    );
    ok("  each still has its own posting", (await db.journalEntry.count({ where: { vendorCreditId: { in: [twice, only] }, reversesId: null } })) === 2);
    const ap3 = tieOut(await loadTieOut("AP", monthKey));
    ok("  and AP's tie-out still agrees", ap3.detail.difference === 0, `${ap3.detail.ageing} vs ${ap3.detail.ledger}`);

    const unbalanced = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM (SELECT l."entryId" FROM journal_lines l GROUP BY l."entryId" HAVING SUM(l.debit) <> SUM(l.credit)) x`;
    ok("every entry in the scratch books balances", Number(unbalanced[0]?.n ?? 1) === 0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

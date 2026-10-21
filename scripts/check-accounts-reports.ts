/**
 * check:accounts-reports — Finance → Accounts' reports agree with the books and the stock (owner, 22 Oct 2026).
 *
 * Builds a scratch workspace from the migrations beside the real database, points the app's own `db` at it, and
 * makes a little real activity through the actions and the stock engine — opening stock (one of it forty days
 * ago), a goods receipt, an invoice that issues stock, vouchers into cash and the bank and out of cash, a
 * transfer sent and received, a physical count approved by somebody else, and a vendor bill. Then:
 *
 *   · the day book's debits equal its credits, and equal the trial balance's movement over the same days;
 *   · the cash book's and the bank book's closing balances are the accounts' own ledger balances;
 *   · the sales register's totals are the invoices', and its tax is GSTR-1's for the month;
 *   · stock valuation today is the stock balances' value and the movements' sum; a past date leaves out what came later;
 *   · aging's buckets add up to the cost layers' value; low stock lists the item under its reorder level;
 *   · CSV export is refused without the finance export permission — and logged — and works with it, logged,
 *     formula-guarded; a report is refused without its view permission; pages give the right totals;
 *   · the pages render (no duplicate ids, every control named, every table in a scroller), and the Accounting
 *     overview carries "Accounts at a glance".
 *
 * It drops the scratch database at the end, pass or fail, and checks the real one was not touched.
 *
 *   npm run check:accounts-reports
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import type { ReactNode } from "react";
import type { PrismaClient } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";
import { renderHtml } from "./lib/render-html";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const round2 = (n: number) => Math.round(n * 100) / 100;
const close = (a: number, b: number) => Math.abs(a - b) < 0.005;

// ── Who the actions think is asking ──────────────────────────────────────────────────────────────

type Actor = { id: string; name: string; email: string; role: string };
let actor: Actor | null = null;
const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
class UnauthorizedError extends Error {}
const sessionStub = {
  requireUser: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => null,
  UnauthorizedError,
};
const cacheStub = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const navigationStub = {
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/accounting",
  useParams: () => ({}),
  notFound: () => {
    throw new Error("NOT_FOUND_CALLED");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT_CALLED ${to}`);
  },
  permanentRedirect: (to: string) => {
    throw new Error(`REDIRECT_CALLED ${to}`);
  },
};
const byName = new Map<string, unknown>([
  ["next/cache", cacheStub],
  ["next/navigation", navigationStub],
  ["@/lib/session", sessionStub],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), cacheStub],
  [load.resolve("next/navigation"), navigationStub],
  [load.resolve("../src/lib/session"), sessionStub],
]);
const swap = (real: Record<string, unknown>, name: string, value: unknown) =>
  new Proxy(real, { get: (target, prop, receiver) => (prop === name ? value : Reflect.get(target, prop, receiver)) });
const authFile = load.resolve("../src/lib/auth");
let authWrapped: unknown = null;
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
  if (resolved === authFile) {
    authWrapped ??= swap(realLoad.call(this, request, parent, isMain) as Record<string, unknown>, "auth", async () =>
      actor ? { user: { id: actor.id, name: actor.name, email: actor.email, role: actor.role, sid: null } } : null,
    );
    return authWrapped;
  }
  return realLoad.call(this, request, parent, isMain);
};

type Page = (props: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<unknown>;
const renderPage = async (page: Page, searchParams: Record<string, string> = {}) =>
  renderHtml((await page({ params: Promise.resolve({}), searchParams: Promise.resolve(searchParams) })) as ReactNode);
const outcome = (rendering: Promise<string>) =>
  rendering.then(
    (html) => ({ kind: "rendered" as const, html }),
    (err: unknown) => ({ kind: err instanceof Error && err.message === "NOT_FOUND_CALLED" ? ("notFound" as const) : ("error" as const), html: String(err instanceof Error ? err.stack : err) }),
  );

function structure(label: string, markup: string) {
  const ids = [...markup.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!);
  const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  const unnamed: string[] = [];
  for (const m of markup.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    const attrs = m[2]!;
    if (/type="hidden"/.test(attrs)) continue;
    if (/aria-label(ledby)?="[^"]+"/.test(attrs)) continue;
    const id = /\sid="([^"]+)"/.exec(attrs)?.[1];
    if (id && markup.includes(`for="${id}"`)) continue;
    const before = markup.slice(0, m.index);
    if (before.lastIndexOf("<label") > before.lastIndexOf("</label>")) continue;
    unnamed.push(`<${m[1]} ${attrs.slice(0, 60)}>`);
  }
  const loose: number[] = [];
  let at = markup.indexOf("<table");
  while (at !== -1) {
    const before = markup.slice(0, at);
    if (before.lastIndexOf("overflow-x-auto") <= before.lastIndexOf("</table>")) loose.push(at);
    at = markup.indexOf("<table", at + 1);
  }
  ok(`${label}: unique ids, named controls, tables in a scroller`, dupes.length === 0 && unnamed.length === 0 && loose.length === 0, [dupes.join(","), unnamed.slice(0, 2).join(" | "), loose.length].filter(Boolean).join(" · "));
}

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

async function snapshot(client: PrismaClient) {
  const [entries, movements, audit] = await Promise.all([client.journalEntry.count(), client.stockMovement.count(), client.auditLog.count()]);
  return { entries, movements, audit };
}

async function main() {
  const realUrl = process.env.DATABASE_URL;
  if (!realUrl) throw new Error("DATABASE_URL is not set.");
  const host = new URL(realUrl).hostname;
  const realName = new URL(realUrl).pathname.slice(1);

  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratchName = `${realName}_acreports`;
  const scratchUrl = withDatabase(realUrl, scratchName);

  const real = directClient(realUrl, { max: 1 });
  const realBefore = await snapshot(real);
  const admin = directClient(withDatabase(realUrl, "postgres"), { max: 1 });
  let appDb: { $disconnect: () => Promise<void> } | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
    const started = Date.now();
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60_000 });
    ok("built from the migrations", true, `${Math.round((Date.now() - started) / 1000)} s`);
    process.env.DATABASE_URL = scratchUrl;
    process.env.CONTROL_DATABASE_URL = "";
    process.env.DESKZO_TENANCY_FALLBACK = "legacy";
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    appDb = db;
    await run(scratchName);
  } finally {
    await appDb?.$disconnect().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`).catch(() => {});
    const gone = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratchName}'`);
    ok("the scratch database is dropped", Number(gone[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  section("The real workspace was not touched");
  const realAfter = await snapshot(real);
  await real.$disconnect();
  ok("same journal entries, stock movements and audit rows as before", JSON.stringify(realAfter) === JSON.stringify(realBefore), realAfter);

  console.log(failures === 0 ? `\nAll ${passes} accounts report checks passed.\n` : `\n${failures} check(s) FAILED, ${passes} passed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

async function run(scratchName: string) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const stockReports = require("../src/actions/stock-reports") as typeof import("../src/actions/stock-reports");
  const accountsReports = require("../src/actions/accounts-reports") as typeof import("../src/actions/accounts-reports");
  const inventory = require("../src/actions/inventory") as typeof import("../src/actions/inventory");
  const vouchers = require("../src/actions/vouchers") as typeof import("../src/actions/vouchers");
  const docs = require("../src/actions/trade-document") as typeof import("../src/actions/trade-document");
  const ledgerReports = require("../src/actions/ledger-reports") as typeof import("../src/actions/ledger-reports");
  const taxReports = require("../src/actions/tax-reports") as typeof import("../src/actions/tax-reports");
  const { accountsSettings } = require("../src/lib/accounts/settings") as typeof import("../src/lib/accounts/settings");
  const { moveStock } = require("../src/lib/inventory/engine") as typeof import("../src/lib/inventory/engine");
  const { recordOpeningStock } = require("../src/lib/inventory/opening") as typeof import("../src/lib/inventory/opening");
  const { ensureChartOfAccounts } = require("../src/lib/ledger/journal") as typeof import("../src/lib/ledger/journal");
  const { permissionsFor } = require("../src/lib/authz/resolve") as typeof import("../src/lib/authz/resolve");
  const { indiaClock } = require("../src/lib/time/zone") as typeof import("../src/lib/time/zone");
  const { toMilli, toCost4, valuePaise, fromPaise } = require("../src/lib/accounts/money") as typeof import("../src/lib/accounts/money");
  const D = "../src/app/(dashboard)";
  const StockReportsPage = (load(`${D}/items/stock-reports/page`) as { default: Page }).default;
  const DayBookPage = (load(`${D}/accounting/day-book/page`) as { default: Page }).default;
  const CashBookPage = (load(`${D}/accounting/cash-book/page`) as { default: Page }).default;
  const RegistersPage = (load(`${D}/accounting/registers/page`) as { default: Page }).default;
  const OverviewPage = (load(`${D}/accounting/page`) as { default: Page }).default;
  /* eslint-enable @typescript-eslint/no-require-imports */

  const where = await db.$queryRaw<{ name: string }[]>`SELECT current_database()::text AS name`;
  ok("the app's db is the scratch database", where[0]?.name === scratchName, where[0]?.name);
  if (where[0]?.name !== scratchName) throw new Error("Refusing to go on: db is not the scratch database.");

  const as = async <T,>(who: Actor, work: () => Promise<T>) => {
    const before = actor;
    actor = who;
    try {
      return await work();
    } finally {
      actor = before;
    }
  };

  // ── Fixture ────────────────────────────────────────────────────────────────────────────────────
  section("Fixture");
  const person = (key: string, role: string, extra: { isSuperAdmin?: boolean } = {}): Promise<Actor> =>
    db.user.create({
      data: { name: `Zz ${key}`, email: `zzacr-${key.toLowerCase()}@example.test`, passwordHash: "!", role, ...extra },
      select: { id: true, name: true, email: true, role: true },
    }) as Promise<Actor>;
  const owner = await person("Owner", "ADMIN", { isSuperAdmin: true });
  const accountant = await person("Accountant", "ACCOUNTS");
  const reader = await person("Reader", "ACCOUNTS");
  const storekeeper = await person("Storekeeper", "PURCHASE");
  const outsider = await person("Outsider", "SALES");
  const set = (u: Actor, permission: string, allowed: boolean) =>
    db.userPermission.create({ data: { userId: u.id, permission, allowed, reason: "check:accounts-reports", grantedById: owner.id } });
  for (const k of ["ledger.viewReports", "data.exportFinance", "inventory.view", "inventory.receive", "inventory.transfer", "inventory.adjust", "vouchers.create", "ledger.post", "payments.manage"]) await set(accountant, k, true);
  for (const k of ["ledger.viewReports", "inventory.view"]) await set(reader, k, true);
  await set(reader, "data.exportFinance", false);
  await set(storekeeper, "inventory.view", true);
  await set(storekeeper, "ledger.viewReports", false);
  for (const k of ["ledger.viewReports", "payments.manage", "inventory.view", "inventory.receive", "inventory.transfer", "inventory.adjust", "inventory.manage", "data.exportFinance"]) await set(outsider, k, false);
  const held = async (u: Actor) => new Set<string>(await permissionsFor(u.id));
  const [accHeld, readHeld, storeHeld, outHeld] = await Promise.all([held(accountant), held(reader), held(storekeeper), held(outsider)]);
  ok(
    "the people hold what the checks assume",
    accHeld.has("data.exportFinance") && accHeld.has("ledger.viewReports") && readHeld.has("ledger.viewReports") && !readHeld.has("data.exportFinance") &&
      storeHeld.has("inventory.view") && !storeHeld.has("ledger.viewReports") && !outHeld.has("inventory.view") && !outHeld.has("ledger.viewReports") && !outHeld.has("payments.manage"),
  );

  const reg = await db.gstRegistration.create({ data: { gstin: "29AAACZ1234Z1Z5", stateCode: "29", code: "KA" } });
  const ho = await db.branch.create({ data: { name: "Zz Head office", code: "HO", isHeadOffice: true, gstRegistrationId: reg.id }, select: { id: true } });
  const company = (name: string) =>
    db.company.create({
      data: { name, normalizedName: name.toLowerCase(), createdById: owner.id, ownerUserId: owner.id, relationshipType: "CLIENT", stage: "CUSTOMER" },
      select: { id: true, name: true },
    });
  // A name a spreadsheet would run as a formula: the CSV must neutralise it.
  const customer = await company("=SUM(1+1) Zz Customer");
  const vendor = await company("Zz Vendor Supplies");

  const main = await db.warehouse.findUniqueOrThrow({ where: { id: "wh_main" }, select: { id: true } });
  const second = await db.warehouse.create({ data: { code: "SECOND", name: "Zz Second godown" }, select: { id: true } });
  await db.accountsSettings.create({ data: { id: "global", invoiceIssuesStock: true, defaultWarehouseId: main.id } });
  const settings = await accountsSettings();
  ok("Accounts settings: invoices issue stock, from the main warehouse", settings.migrated && settings.invoiceIssuesStock && settings.defaultWarehouseId === main.id);

  const good = (name: string, sku: string, reorderLevel: number | null) =>
    db.item.create({ data: { name, sku, type: "GOOD", trackInventory: true, unit: "PCS", sellingPrice: 150, costPrice: 100, taxRatePercent: 18, hsnCode: "84713010", reorderLevel, createdById: owner.id }, select: { id: true, name: true } });
  const widget = await good("Zz Widget", "ZZACR-W", 50);
  const bolt = await good("Zz Bolt", "ZZACR-B", 20);
  // Thirty more with nothing on hand, for paging.
  await db.item.createMany({ data: Array.from({ length: 30 }, (_, i) => ({ name: `Zz Filler ${String(i + 1).padStart(2, "0")}`, sku: `ZZACR-F${i + 1}`, type: "GOOD" as const, trackInventory: true, sellingPrice: 10, createdById: owner.id })) });

  const today = indiaClock.today();
  const daysAgo = (d: number) => indiaClock.dateKey(new Date(Date.now() - d * 86_400_000));
  const fortyAgo = new Date(`${daysAgo(40)}T00:00:00.000Z`);
  await db.$transaction((tx) =>
    moveStock(tx, {
      itemId: widget.id, warehouseId: main.id, quantity: 100, type: "OPENING", sourceType: "OPENING", sourceId: widget.id, date: fortyAgo,
      userId: owner.id, reason: "Opening stock", idempotencyKey: `opening:${widget.id}`, unitCost: 100, settings,
    }),
  );
  await db.$transaction((tx) => recordOpeningStock(tx, { itemId: bolt.id, quantity: 10, unitCost: 50, userId: owner.id, reason: "Opening stock" }, settings));

  const grn = await as(accountant, () =>
    inventory.saveStockDocument({ type: "GRN", date: daysAgo(10), warehouseId: main.id, companyId: vendor.id, reference: "ZZ-DC-1", lines: [{ itemId: widget.id, quantity: 50, unitCost: 120 }] }),
  );
  const grnPosted = grn.ok ? await as(accountant, () => inventory.postStockDocument(grn.data.id)) : grn;
  ok("a goods receipt of 50 widgets at ₹120, ten days ago, posted", grnPosted.ok, grnPosted.ok ? "" : grnPosted.error);

  const invoiceDraft = await db.tradeDocument.create({
    data: {
      docNumber: "ZZACR-DRAFT-1", docType: "INVOICE", direction: "SALES", status: "DRAFT", companyId: customer.id, createdById: owner.id,
      issueDate: new Date(Date.now() - 60_000), currency: "INR", exchangeRate: 1, branchId: ho.id, gstRegistrationId: reg.id, placeOfSupplyCode: "29",
      buyerGstin: "29AAACY5555Y1Z2", gstTreatment: "REGISTERED_REGULAR",
      subtotal: 4500, taxableValue: 4500, cgstAmount: 405, sgstAmount: 405, total: 5310,
      lines: { create: [{ name: "Zz Widget", itemId: widget.id, hsnCode: "84713010", unit: "PCS", quantity: 30, unitPrice: 150, taxRatePercent: 18, taxableValue: 4500, cgstAmount: 405, sgstAmount: 405, lineTotal: 5310, sortOrder: 0 }] },
    },
    select: { id: true },
  });
  const issued = await as(owner, () => docs.issueTradeDocument({ id: invoiceDraft.id }));
  ok("an invoice for 30 widgets issued — and it took them out of stock", issued.ok && (await db.stockMovement.count({ where: { tradeDocumentId: invoiceDraft.id, type: "SOLD" } })) === 1, issued.ok ? "" : issued.error);

  const billDraft = await db.tradeDocument.create({
    data: {
      docNumber: "ZZACR-BILL-DRAFT", docType: "BILL", direction: "PURCHASE", status: "DRAFT", companyId: vendor.id, createdById: owner.id,
      issueDate: new Date(Date.now() - 120_000), currency: "INR", exchangeRate: 1, branchId: ho.id, gstRegistrationId: reg.id, placeOfSupplyCode: "29",
      sellerGstin: "29AAACV7777V1Z9", reference: "VND-7781", gstTreatment: "REGISTERED_REGULAR",
      subtotal: 6000, taxableValue: 6000, cgstAmount: 540, sgstAmount: 540, total: 7080,
      lines: { create: [{ name: "Zz Widget", itemId: widget.id, hsnCode: "84713010", unit: "PCS", quantity: 50, unitPrice: 120, taxRatePercent: 18, taxableValue: 6000, cgstAmount: 540, sgstAmount: 540, lineTotal: 7080, sortOrder: 0 }] },
    },
    select: { id: true },
  });
  const billIssued = await as(owner, () => docs.issueTradeDocument({ id: billDraft.id }));
  ok("the vendor's bill issued (bills don't move stock here)", billIssued.ok, billIssued.ok ? "" : billIssued.error);

  await ensureChartOfAccounts();
  const account = (key: string) => db.ledgerAccount.findUniqueOrThrow({ where: { systemKey: key }, select: { id: true, name: true } });
  const cash = await account("CASH");
  const bank = await account("BANK");
  const income = await db.ledgerAccount.findFirstOrThrow({ where: { type: "INCOME", isGroup: false, active: true, systemKey: null }, orderBy: { code: "asc" }, select: { id: true } }).catch(() =>
    db.ledgerAccount.findFirstOrThrow({ where: { type: "INCOME", isGroup: false, active: true }, orderBy: { code: "asc" }, select: { id: true } }),
  );
  const expense = await db.ledgerAccount.findFirstOrThrow({ where: { type: "EXPENSE", isGroup: false, active: true, systemKey: null }, orderBy: { code: "asc" }, select: { id: true } }).catch(() =>
    db.ledgerAccount.findFirstOrThrow({ where: { type: "EXPENSE", isGroup: false, active: true }, orderBy: { code: "asc" }, select: { id: true } }),
  );
  const voucher = async (type: "RECEIPT" | "PAYMENT", date: string, lines: { accountId: string; debit: number; credit: number }[], narration: string) => {
    const saved = await as(accountant, () => vouchers.saveVoucher({ type, date, narration, lines }));
    if (!saved.ok) return saved;
    return as(accountant, () => vouchers.postVoucher(saved.data.id));
  };
  const v1 = await voucher("RECEIPT", daysAgo(3), [{ accountId: cash.id, debit: 5000, credit: 0 }, { accountId: income.id, debit: 0, credit: 5000 }], "Zz scrap sale, cash");
  const v2 = await voucher("PAYMENT", daysAgo(2), [{ accountId: expense.id, debit: 1200, credit: 0 }, { accountId: cash.id, debit: 0, credit: 1200 }], "Zz courier charges");
  const v3 = await voucher("RECEIPT", daysAgo(1), [{ accountId: bank.id, debit: 20000, credit: 0 }, { accountId: income.id, debit: 0, credit: 20000 }], "Zz bank receipt");
  ok("three vouchers posted — cash in, cash out, money into the bank", v1.ok && v2.ok && v3.ok, [v1, v2, v3].map((v) => (v.ok ? "ok" : v.error)).join(" · "));

  const transfer = await as(accountant, () => inventory.saveStockDocument({ type: "TRANSFER", date: today, warehouseId: main.id, toWarehouseId: second.id, lines: [{ itemId: widget.id, quantity: 5 }] }));
  const sent = transfer.ok ? await as(accountant, () => inventory.postStockDocument(transfer.data.id)) : transfer;
  const received = transfer.ok ? await as(accountant, () => inventory.receiveStockTransfer(transfer.data.id)) : transfer;
  ok("5 widgets sent to the second godown and received there", sent.ok && received.ok, [sent, received].map((v) => (v.ok ? "ok" : v.error)).join(" · "));

  const count = await as(accountant, () => inventory.saveStockDocument({ type: "PHYSICAL_COUNT", date: today, warehouseId: main.id, reason: "Zz month-end count", lines: [{ itemId: bolt.id, countedQty: 8 }] }));
  const submitted = count.ok ? await as(accountant, () => inventory.submitStockDocument(count.data.id)) : count;
  const approved = count.ok ? await as(owner, () => inventory.approveStockDocument(count.data.id)) : count;
  ok("a count found 8 bolts against 10 — sent for approval, approved by somebody else", submitted.ok && approved.ok, [submitted, approved].map((v) => (v.ok ? "ok" : v.error)).join(" · "));

  // ── Day book ───────────────────────────────────────────────────────────────────────────────────
  section("Day book");
  const from = daysAgo(60);
  const dayBook = await as(accountant, () => accountsReports.accountsReport("day-book", { from, to: today, pageSize: 200 }));
  const db1 = dayBook.status === "ok" ? dayBook.table : null;
  ok("the day book opens for the books' reader", !!db1, dayBook.status);
  const dbDebit = Number(db1?.totals?.debit ?? -1);
  const dbCredit = Number(db1?.totals?.credit ?? -2);
  ok("its debits equal its credits", close(dbDebit, dbCredit) && dbDebit > 0, `${dbDebit} / ${dbCredit}`);
  const tbTo = await as(accountant, () => ledgerReports.trialBalance({ to: today }));
  const tbBefore = await as(accountant, () => ledgerReports.trialBalance({ to: daysAgo(61) }));
  const movement = round2(tbTo.totals.debit - tbBefore.totals.debit);
  ok("and they are the trial balance's movement over the same days", close(dbDebit, movement), `${dbDebit} vs ${movement}`);
  const entries = await db.journalEntry.count({ where: { date: { gte: indiaClock.startOfDay(from)!, lt: indiaClock.endOfDay(today)! } } });
  ok("every entry in the window is counted", db1?.total === entries, `${db1?.total} vs ${entries}`);
  const sources = new Set(db1?.rows.map((r) => String(r.cells.source)));
  ok("it has the invoice's, the bill's and the vouchers' entries", ["Invoice", "Bill", "Voucher"].every((s) => sources.has(s)), [...sources].join(", "));
  const paged = await as(accountant, () => accountsReports.accountsReport("day-book", { from, to: today, pageSize: 25 }));
  ok("a page of it keeps the whole window's totals", paged.status === "ok" && paged.table.totals?.debit === db1?.totals?.debit && paged.table.total === entries);

  // ── Cash and bank books ────────────────────────────────────────────────────────────────────────
  section("Cash and bank books");
  for (const [label, acct] of [["cash book", cash], ["bank book", bank]] as const) {
    const book = await as(accountant, () => accountsReports.accountsReport("cash-book", { account: acct.id, from, to: today }));
    const ledger = await as(accountant, () => ledgerReports.accountLedger({ accountId: acct.id, to: today }));
    const closing = book.status === "ok" ? Number(book.table.totals?.balance) : NaN;
    ok(`the ${label}'s closing balance is the account's ledger balance`, close(closing, ledger?.closingBalance ?? NaN), `${closing} vs ${ledger?.closingBalance}`);
    const last = book.status === "ok" ? book.table.rows[book.table.rows.length - 1] : undefined;
    ok(`  and its last running balance says the same`, close(Number(last?.cells.balance), closing));
  }
  const cashBook = await as(accountant, () => accountsReports.accountsReport("cash-book", { account: cash.id, from, to: today }));
  ok("the cash book shows ₹5,000 in and ₹1,200 out", cashBook.status === "ok" && cashBook.table.totals?.receipts === 5000 && cashBook.table.totals?.payments === 1200);
  const midBook = await as(accountant, () => accountsReports.accountsReport("cash-book", { account: cash.id, from: daysAgo(2), to: today }));
  ok("  from a later day, the opening carries what came before", midBook.status === "ok" && midBook.table.rows[0]?.cells.balance === 5000 && Number(midBook.table.totals?.balance) === 3800);
  const financeOnly = await person("Finance", "ACCOUNTS");
  await set(financeOnly, "ledger.viewReports", false);
  await set(financeOnly, "payments.manage", true);
  ok("the finance function opens the cash book without the books' reader permission", (await as(financeOnly, () => accountsReports.accountsReport("cash-book", {}))).status === "ok");
  ok("  but not the day book", (await as(financeOnly, () => accountsReports.accountsReport("day-book", {}))).status === "forbidden");

  // ── Registers ──────────────────────────────────────────────────────────────────────────────────
  section("Registers");
  const monthStart = `${today.slice(0, 7)}-01`;
  const sales = await as(accountant, () => accountsReports.accountsReport("sales", { from: monthStart, to: today }));
  const issuedInvoices = await db.tradeDocument.findMany({ where: { docType: { in: ["INVOICE", "CREDIT_NOTE"] }, status: { notIn: ["DRAFT", "CANCELLED"] }, issueDate: { gte: indiaClock.startOfDay(monthStart)!, lt: indiaClock.endOfDay(today)! } }, select: { docType: true, total: true } });
  const expected = round2(issuedInvoices.reduce((t, d) => t + (d.docType === "CREDIT_NOTE" ? -1 : 1) * Number(d.total), 0));
  ok("the sales register's total is the issued invoices'", sales.status === "ok" && close(Number(sales.table.totals?.total), expected) && expected === 5310, `${sales.status === "ok" ? sales.table.totals?.total : sales.status} vs ${expected}`);
  const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
  const g1 = await as(owner, () => taxReports.gstr1({ month: m, year: y }));
  ok(
    "  and its tax is GSTR-1's for the month",
    sales.status === "ok" && !!g1 && close(Number(sales.table.totals?.cgst), g1.totals.cgst) && close(Number(sales.table.totals?.sgst), g1.totals.sgst) && close(Number(sales.table.totals?.igst), g1.totals.igst) && close(Number(sales.table.totals?.taxable), g1.totals.taxableValue),
    g1 ? `${JSON.stringify(sales.status === "ok" ? sales.table.totals : null)} vs ${JSON.stringify(g1.totals)}` : "no GSTR-1",
  );
  const purchase = await as(accountant, () => accountsReports.accountsReport("purchase", { from: monthStart, to: today }));
  ok("the purchase register has the bill, with the vendor's GSTIN", purchase.status === "ok" && purchase.table.totals?.total === 7080 && purchase.table.rows.some((r) => r.cells.gstin === "29AAACV7777V1Z9"));
  const gst = await as(accountant, () => accountsReports.accountsReport("gst", { from: monthStart, to: today }));
  ok("the GST summary nets output tax against the bill's input", gst.status === "ok" && gst.table.totals?.outCgst === 405 && gst.table.totals?.inCgst === 540 && gst.table.totals?.net === round2(810 - 1080));
  ok("  and says it is not a return", gst.status === "ok" && (gst.table.notes ?? []).some((n) => /not a return/.test(n)));
  const journal = await as(accountant, () => accountsReports.accountsReport("journal", { from, to: today }));
  ok("the journal register has the three vouchers and nothing else", journal.status === "ok" && journal.table.total === 3, journal.status === "ok" ? journal.table.total : journal.status);
  const expenses = await as(accountant, () => accountsReports.accountsReport("expenses", { from, to: today }));
  ok("expenses by month carry the courier charge", expenses.status === "ok" && Number(expenses.table.totals?.total) >= 1200);
  const auditTrail = await as(accountant, () => accountsReports.accountsReport("audit", {}));
  ok("the audit history has the vouchers' and stock vouchers' steps", auditTrail.status === "ok" && auditTrail.table.rows.some((r) => (r.cells.record as { text: string }).text === "Voucher") && auditTrail.table.rows.some((r) => (r.cells.record as { text: string }).text === "Stock voucher"));

  // ── Stock ──────────────────────────────────────────────────────────────────────────────────────
  section("Stock valuation, aging and low stock");
  const balanceSum = round2(Number((await db.stockBalance.aggregate({ _sum: { value: true } }))._sum.value ?? 0));
  const movementSum = round2(Number((await db.stockMovement.aggregate({ _sum: { value: true } }))._sum.value ?? 0));
  const valuation = await as(accountant, () => stockReports.stockReport("valuation", {}));
  const valued = valuation.status === "ok" ? Number(valuation.table.totals?.value) : NaN;
  ok("stock valuation today is the stock balances' value", close(valued, balanceSum), `${valued} vs ${balanceSum}`);
  ok("  and the sum of every movement's value", close(valued, movementSum), `${valued} vs ${movementSum}`);
  const past = await as(accountant, () => stockReports.stockReport("valuation", { asOf: daysAgo(20) }));
  ok("as of twenty days ago, only the opening widgets: 100 at ₹100", past.status === "ok" && past.table.total === 1 && Number(past.table.totals?.value) === 10000 && past.table.rows[0]?.cells.quantity === 100, past.status === "ok" ? past.table.totals : past.status);
  const summary = await as(accountant, () => stockReports.stockReport("summary", {}));
  ok("the stock summary's value agrees", summary.status === "ok" && close(Number(summary.table.totals?.value), balanceSum));
  const layers = await db.stockCostLayer.findMany({ where: { remaining: { gt: 0 } }, select: { remaining: true, unitCost: true } });
  const layerValue = fromPaise(layers.reduce((t, l) => t + valuePaise(toMilli(Number(l.remaining)), toCost4(Number(l.unitCost))), 0));
  const aging = await as(accountant, () => stockReports.stockReport("aging", {}));
  const bucketSum = aging.status === "ok" ? round2(Object.entries(aging.table.totals ?? {}).filter(([k]) => k.startsWith("b_")).reduce((t, [, v]) => t + Number(v), 0)) : NaN;
  ok("aging's buckets add up to the cost layers' value", close(bucketSum, layerValue) && aging.status === "ok" && close(Number(aging.table.totals?.value ?? NaN), layerValue), `${bucketSum} vs ${layerValue}`);
  ok("  the forty-day-old widgets are in 31–60 days", aging.status === "ok" && Number(aging.table.totals?.["b_31-60"]) > 0);
  const reorder = await as(accountant, () => stockReports.stockReport("reorder", {}));
  ok("low stock lists the bolts (8 against a reorder level of 20), not the widgets", reorder.status === "ok" && reorder.table.rows.some((r) => (r.cells.item as { text: string }).text === "Zz Bolt" && r.cells.onHand === 8) && !reorder.table.rows.some((r) => (r.cells.item as { text: string }).text === "Zz Widget"));
  const variance = await as(accountant, () => stockReports.stockReport("variance", {}));
  ok("count variance: −2 bolts at ₹50 = −₹100", variance.status === "ok" && variance.table.rows[0]?.cells.difference === -2 && variance.table.totals?.value === -100);
  const transfers = await as(accountant, () => stockReports.stockReport("transfers", {}));
  const sentAtCost = round2(-Number((await db.stockMovement.aggregate({ where: { type: "TRANSFER_OUT" }, _sum: { value: true } }))._sum.value ?? 0));
  ok("the transfer is received, at what the widgets cost when they left", transfers.status === "ok" && transfers.table.rows[0]?.cells.status === "Received" && sentAtCost > 0 && transfers.table.totals?.value === sentAtCost, transfers.status === "ok" ? `${transfers.table.totals?.value} vs ${sentAtCost}` : transfers.status);
  const ledgerReport = await as(accountant, () => stockReports.stockReport("ledger", { item: widget.id }));
  ok("the widget's ledger runs to 120 on hand (100 + 50 − 30, and 5 moved between godowns)", ledgerReport.status === "ok" && ledgerReport.table.totals?.balanceQty === 120, ledgerReport.status === "ok" ? ledgerReport.table.totals : ledgerReport.status);
  const mainOnly = await as(accountant, () => stockReports.stockReport("ledger", { item: widget.id, warehouse: main.id }));
  ok("  115 of them in the main warehouse", mainOnly.status === "ok" && mainOnly.table.totals?.balanceQty === 115);
  const lastRow = ledgerReport.status === "ok" ? ledgerReport.table.rows[ledgerReport.table.rows.length - 1] : undefined;
  ok("  the running balance's last figure is the closing one", lastRow?.cells.balanceQty === 120 && close(Number(lastRow?.cells.balanceValue), Number(ledgerReport.status === "ok" ? ledgerReport.table.totals?.balanceValue : NaN)));
  const byWarehouse = await as(accountant, () => stockReports.stockReport("warehouses", {}));
  ok("warehouse-wise: 115 widgets and 8 bolts in the main warehouse, 5 widgets in the second", byWarehouse.status === "ok" && byWarehouse.table.totals?.[`w_${main.id}`] === 123 && byWarehouse.table.totals?.[`w_${second.id}`] === 5, byWarehouse.status === "ok" ? byWarehouse.table.totals : byWarehouse.status);
  const profit = await as(accountant, () => stockReports.stockReport("profitability", {}));
  ok("profitability: widgets sold for ₹4,500, at cost", profit.status === "ok" && profit.table.totals?.sales === 4500 && Number(profit.table.totals?.cogs) > 0 && close(Number(profit.table.totals?.margin), 4500 - Number(profit.table.totals?.cogs)));

  // ── Paging ─────────────────────────────────────────────────────────────────────────────────────
  section("Pages");
  const p1 = await as(accountant, () => stockReports.stockReport("summary", { pageSize: 25 }));
  const p2 = await as(accountant, () => stockReports.stockReport("summary", { pageSize: 25, page: 2 }));
  ok("32 goods: 25 on the first page, 7 on the second, same totals on both", p1.status === "ok" && p2.status === "ok" && p1.table.total === 32 && p1.table.rows.length === 25 && p2.table.rows.length === 7 && p1.table.totals?.value === p2.table.totals?.value);
  const m1 = await as(accountant, () => stockReports.stockReport("movements", {}));
  ok("the movement register counts every movement", m1.status === "ok" && m1.table.total === (await db.stockMovement.count()));

  // ── Who may read and download ──────────────────────────────────────────────────────────────────
  section("Permissions and CSV");
  ok("somebody without the stock view permission is refused the stock reports", (await as(outsider, () => stockReports.stockReport("summary", {}))).status === "forbidden");
  ok("  and the books' reports", (await as(outsider, () => accountsReports.accountsReport("day-book", {}))).status === "forbidden" && (await as(outsider, () => accountsReports.accountsReport("cash-book", {}))).status === "forbidden");
  ok("a storekeeper reads stock but not item profitability (it shows the books' figures)", (await as(storekeeper, () => stockReports.stockReport("summary", {}))).status === "ok" && (await as(storekeeper, () => stockReports.stockReport("profitability", {}))).status === "forbidden");
  const deniedBefore = await db.activityLog.count({ where: { kind: "PERMISSION_DENIED" } });
  const refused = await as(reader, () => stockReports.exportStockReportCsv("summary", {}));
  const refusedBooks = await as(reader, () => accountsReports.exportAccountsReportCsv("day-book", { from, to: today }));
  ok("without the finance export permission, a download is refused", !refused.ok && !refusedBooks.ok && /export permission/.test(refused.ok ? "" : refused.error));
  ok("  and the refusal is logged", (await db.activityLog.count({ where: { kind: "PERMISSION_DENIED" } })) === deniedBefore + 2);
  const exportsBefore = await db.activityLog.count({ where: { kind: "EXPORT" } });
  const csv = await as(accountant, () => stockReports.exportStockReportCsv("summary", {}));
  ok("with it, the stock summary downloads — every item, not one page", csv.ok && csv.data.rows === 32 && csv.data.csv.includes('"Item","Category"') && csv.data.filename.startsWith("stock-summary-"));
  const salesCsv = await as(accountant, () => accountsReports.exportAccountsReportCsv("sales", { from: monthStart, to: today }));
  ok("the sales register downloads, its formula-like customer name neutralised", salesCsv.ok && salesCsv.data.csv.includes("\"'=SUM(1+1) Zz Customer\"") && !salesCsv.data.csv.includes('"=SUM'));
  const logged = await db.activityLog.findMany({ where: { kind: "EXPORT" }, orderBy: { createdAt: "desc" }, take: 2, select: { summary: true, metadata: true, userId: true } });
  ok("  each download is in the activity log, by whom and which report", (await db.activityLog.count({ where: { kind: "EXPORT" } })) === exportsBefore + 2 && logged.every((l) => l.userId === accountant.id) && logged.some((l) => (l.metadata as { report?: string })?.report === "stock-summary"));
  ok("  without the search text itself", !(await db.activityLog.findMany({ where: { kind: "EXPORT" }, select: { metadata: true } })).some((l) => JSON.stringify(l.metadata).includes("SUM(1+1)")));

  // ── The glance and the pages ───────────────────────────────────────────────────────────────────
  section("Accounts at a glance, and the pages");
  const glance = await as(owner, () => accountsReports.accountsGlance());
  const stockCard = glance.find((c) => c.key === "stockValue");
  ok("the owner's glance has the stock value, the same figure", !!stockCard && close(stockCard.value, balanceSum), stockCard);
  ok("  and the items to reorder", glance.find((c) => c.key === "reorder")?.value === 1);
  ok("  and what's overdue and waiting", ["overdueInvoices", "overdueBills", "vouchers", "adjustments", "unreconciled"].every((k) => glance.some((c) => c.key === k)), glance.map((c) => c.key).join(","));
  const outsiderGlance = await as(outsider, () => accountsReports.accountsGlance());
  ok("somebody without stock permissions sees no stock card", !outsiderGlance.some((c) => c.key === "stockValue" || c.key === "reorder"));

  for (const [name, page, params] of [
    ["Stock reports — summary", StockReportsPage, {}],
    ["Stock reports — item ledger", StockReportsPage, { report: "ledger", item: widget.id }],
    ["Stock reports — movements", StockReportsPage, { report: "movements" }],
    ["Stock reports — valuation", StockReportsPage, { report: "valuation" }],
    ["Stock reports — aging", StockReportsPage, { report: "aging" }],
    ["Day book", DayBookPage, { from }],
    ["Cash & bank book", CashBookPage, { from }],
    ["Registers — sales", RegistersPage, {}],
    ["Registers — GST", RegistersPage, { register: "gst" }],
  ] as const) {
    const out = await as(owner, () => outcome(renderPage(page as Page, params as Record<string, string>)));
    ok(`${name} renders`, out.kind === "rendered", out.kind === "rendered" ? "" : out.html.slice(0, 300));
    if (out.kind === "rendered") structure(name, out.html);
  }
  const ownerStock = await as(owner, () => outcome(renderPage(StockReportsPage, {})));
  ok("  the owner may download (the button is there)", ownerStock.kind === "rendered" && ownerStock.html.includes("Export CSV"));
  const readerStock = await as(reader, () => outcome(renderPage(StockReportsPage, {})));
  ok("  the reader may not (no button)", readerStock.kind === "rendered" && !readerStock.html.includes("Export CSV"));
  const outsiderStock = await as(outsider, () => outcome(renderPage(StockReportsPage, {})));
  ok("  somebody without the stock view permission gets the 404 page", outsiderStock.kind === "notFound", outsiderStock.kind);
  const outsiderDayBook = await as(outsider, () => outcome(renderPage(DayBookPage, {})));
  ok("  and the same for the day book", outsiderDayBook.kind === "notFound", outsiderDayBook.kind);
  const overview = await as(owner, () => outcome(renderPage(OverviewPage, {})));
  ok("the Accounting overview carries Accounts at a glance", overview.kind === "rendered" && overview.html.includes("Accounts at a glance") && overview.html.includes("Accounting") && overview.html.includes("/items/stock-reports?report=valuation"), overview.kind === "rendered" ? "" : overview.html.slice(0, 300));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

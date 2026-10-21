/**
 * check:inventory — Finance → Accounts' stock engine and stock vouchers (owner, 22 Oct 2026), against a
 * scratch workspace built from the migrations beside the real one, dropped after.
 *
 * Drives the real code — the engine (src/lib/inventory/engine.ts), the stock vouchers' actions
 * (src/actions/inventory.ts) and issuing and cancelling a tax invoice (src/actions/trade-document.ts) — with
 * `Module._load` stubs for the session and Next's cache, as check:revenue does. It proves:
 *
 *   · the migration's main warehouse and units are there;
 *   · a goods receipt receives stock, its balance and a cost layer, and under perpetual inventory posts
 *     Dr Stock in Hand / Cr Goods Received Not Invoiced; posting it again moves nothing;
 *   · a tax invoice issues its goods (Dr COGS / Cr Stock in Hand), and cancelling it puts them back;
 *   · the same idempotency key moves stock once; negative stock is refused unless allowed, and never for
 *     batches; two sales of the last unit at once — one succeeds;
 *   · weighted-average and FIFO cost on a known sequence; batches first-expiry-first-out, skipping expired
 *     ones for a sale; serial numbers counted, known and never in stock twice;
 *   · a transfer sent (in transit) and received at the same value; an adjustment and a count waiting for
 *     somebody else's approval; a purchase return; cancelling a posted voucher reversing its stock and entry;
 *   · periodic inventory writing no entries; every inventory entry balanced; balances agreeing with the
 *     movements, and items' totals with their balances;
 *   · permission refusals.
 *
 *   npm run check:inventory
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { directClient } from "../src/lib/tenancy/direct-client";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const TAG = "ZZINV";

type Actor = { id: string; name: string; email: string; role: string };
let actor: Actor | null = null;
const as = (who: Actor) => {
  actor = who;
};

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
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const navigation = {
  notFound: () => {
    throw new Error("NOT_FOUND_CALLED");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT_CALLED ${to}`);
  },
};
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["next/navigation", navigation],
  ["@/lib/session", session],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("next/navigation"), navigation],
  [load.resolve("../src/lib/session"), session],
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

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
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
  const scratchName = `${realName}_inventory`;
  const scratchUrl = withDatabase(realUrl, scratchName);
  ok("  and it is not the real one", scratchName !== realName, scratchName);

  const real = directClient(realUrl, { max: 1 });
  const realBefore = await real.stockMovement.count().catch(() => -1);

  const admin = directClient(withDatabase(realUrl, "postgres"), { max: 1 });
  let appDb: { $disconnect: () => Promise<void> } | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
    const started = Date.now();
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60 * 1000 });
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
  const realAfter = await real.stockMovement.count().catch(() => -1);
  await real.$disconnect();
  ok("it has the same stock movements", realAfter === realBefore, `${realBefore} → ${realAfter}`);

  console.log(failures === 0 ? `\nAll ${passes} inventory checks passed.\n` : `\n${failures} check(s) FAILED, ${passes} passed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

async function run(scratchName: string) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const engine = require("../src/lib/inventory/engine") as typeof import("../src/lib/inventory/engine");
  const inventory = require("../src/actions/inventory") as typeof import("../src/actions/inventory");
  const docs = require("../src/actions/trade-document") as typeof import("../src/actions/trade-document");
  const { accountsSettings } = require("../src/lib/accounts/settings") as typeof import("../src/lib/accounts/settings");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const where = await db.$queryRaw<{ name: string }[]>`SELECT current_database()::text AS name`;
  ok("the app's db is the scratch database", where[0]?.name === scratchName, where[0]?.name);
  if (where[0]?.name !== scratchName) throw new Error("Refusing to go on: db is not the scratch database.");

  // ── What the migration left ────────────────────────────────────────────────────────────────────
  section("What the migration left");
  const main = await db.warehouse.findUnique({ where: { id: "wh_main" }, select: { code: true, isDefault: true, active: true } });
  ok("the main warehouse, MAIN, is there and the default", main?.code === "MAIN" && main.isDefault && main.active, main);
  const units = await db.unitOfMeasure.count();
  ok("  and the standard units", units >= 17, units);

  // ── Fixture ──────────────────────────────────────────────────────────────────────────────────
  section("Fixture");
  const user = async (key: string, role: string, extra: { isSuperAdmin?: boolean } = {}): Promise<Actor> =>
    db.user.create({
      data: { name: `${TAG} ${key}`, email: `${TAG.toLowerCase()}-${key.toLowerCase()}@example.test`, passwordHash: "!", role, ...extra },
      select: { id: true, name: true, email: true, role: true },
    }) as Promise<Actor>;
  const owner = await user("Owner", "ADMIN", { isSuperAdmin: true });
  const clerk = await user("Clerk", "ACCOUNTS");
  const boss = await user("Boss", "MANAGEMENT");
  const boss2 = await user("Boss2", "MANAGEMENT");
  const rep = await user("Rep", "SALES");
  const buyer = await user("Buyer", "PURCHASE");
  const vendor = await db.company.create({ data: { name: `${TAG} Vendor`, normalizedName: `${TAG.toLowerCase()} vendor`, createdById: owner.id, ownerUserId: owner.id }, select: { id: true } });
  const customer = await db.company.create({ data: { name: `${TAG} Customer`, normalizedName: `${TAG.toLowerCase()} customer`, createdById: owner.id, ownerUserId: owner.id }, select: { id: true } });
  const item = (sku: string, extra: { trackBatches?: boolean; trackExpiry?: boolean; trackSerials?: boolean; costPrice?: number } = {}) =>
    db.item.create({
      data: { name: `${TAG} ${sku}`, sku: `${TAG}-${sku}`, type: "GOOD", sellingPrice: 500, costPrice: extra.costPrice ?? 100, createdById: owner.id, trackInventory: true, unit: "NOS", ...extra },
      select: { id: true, name: true },
    });
  const A = await item("A");
  const C = await item("C-WA");
  const D = await item("D-FIFO");
  const N = await item("N-NEG");
  const L = await item("L-LAST");
  const B = await item("B-BATCH", { trackBatches: true, trackExpiry: true });
  const S = await item("S-SERIAL", { trackSerials: true });
  const service = await db.item.create({ data: { name: `${TAG} Service`, sku: `${TAG}-SVC`, type: "SERVICE", sellingPrice: 100, createdById: owner.id }, select: { id: true } });
  const settings = async (data: Record<string, unknown>) => {
    await db.accountsSettings.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });
    return accountsSettings();
  };
  let s = await settings({ inventoryAccounting: "PERPETUAL", costingMethod: "WEIGHTED_AVERAGE", allowNegativeStock: false, invoiceIssuesStock: true, adjustmentApprovalRequired: true });
  ok("people, a vendor and a customer, goods (plain, batch, serial) and a service; perpetual inventory on", s.migrated && s.inventoryAccounting === "PERPETUAL");

  as(boss);
  const wh2 = await inventory.saveWarehouse({ code: "godown-2", name: `${TAG} Godown 2` });
  ok("a second warehouse, with its code made upper-case", wh2.ok && (await db.warehouse.findUnique({ where: { id: wh2.ok ? wh2.data.id : "" }, select: { code: true } }))?.code === "GODOWN-2", wh2.ok ? "" : wh2.error);
  const WH2 = wh2.ok ? wh2.data.id : "";
  const clash = await inventory.saveWarehouse({ code: "MAIN", name: "Another main" });
  ok("  a code already used is refused", !clash.ok);
  as(rep);
  const repWarehouse = await inventory.saveWarehouse({ code: "REP", name: "Rep's" });
  ok("  and somebody who can't set up inventory can't add one", !repWarehouse.ok);

  // Helpers.
  const balance = async (itemId: string, warehouseId = "wh_main") => {
    const r = await db.stockBalance.aggregate({ where: { itemId, warehouseId }, _sum: { quantity: true, value: true } });
    return { qty: Number(r._sum.quantity ?? 0), value: Number(r._sum.value ?? 0) };
  };
  const onHand = async (itemId: string) => Number((await db.item.findUnique({ where: { id: itemId }, select: { stockQuantity: true } }))?.stockQuantity ?? 0);
  const entry = async (postingKey: string) => {
    const e = await db.journalEntry.findUnique({
      where: { postingKey },
      select: { id: true, source: true, lines: { select: { debit: true, credit: true, account: { select: { systemKey: true } } } } },
    });
    if (!e) return null;
    const on = (key: string) => e.lines.filter((l) => l.account.systemKey === key).reduce((t, l) => t + Number(l.debit) - Number(l.credit), 0);
    return { ...e, on };
  };
  const day = "2026-10-15";
  const draft = async (who: Actor, input: Parameters<typeof inventory.saveStockDocument>[0]) => {
    as(who);
    return inventory.saveStockDocument(input);
  };
  const move = (input: Omit<Parameters<typeof engine.moveStock>[1], "settings" | "date" | "userId" | "sourceType"> & { date?: Date; sourceType?: Parameters<typeof engine.moveStock>[1]["sourceType"] }, settingsNow = s) =>
    db.$transaction((tx) => engine.moveStock(tx, { sourceType: "MANUAL", date: new Date(`${day}T00:00:00.000Z`), userId: owner.id, settings: settingsNow, ...input }));
  const refused = async (work: () => Promise<unknown>) => {
    try {
      await work();
      return null;
    } catch (err) {
      return err instanceof engine.StockError ? err.message : `NOT A STOCK ERROR: ${(err as Error).message}`;
    }
  };

  // ── Goods receipt ──────────────────────────────────────────────────────────────────────────────
  section("A goods receipt");
  const grn = await draft(clerk, { type: "GRN", date: day, warehouseId: "wh_main", companyId: vendor.id, reference: "VCH-1", lines: [{ itemId: A.id, quantity: 10, rejectedQty: 1, unitCost: 100 }] });
  ok("drafted, numbered GRN/<FY>/0001", grn.ok && /^GRN\/\d{4}-\d{2}\/0001$/.test(grn.data.number), grn.ok ? grn.data.number : grn.error);
  const grnId = grn.ok ? grn.data.id : "";
  ok("  a draft moves nothing", (await balance(A.id)).qty === 0);
  const grnLine = await db.stockDocumentLine.findFirst({ where: { stockDocumentId: grnId }, select: { receivedQty: true, rejectedQty: true, quantity: true } });
  ok("  the line keeps received 11, rejected 1, accepted 10", Number(grnLine?.receivedQty) === 11 && Number(grnLine?.rejectedQty) === 1 && Number(grnLine?.quantity) === 10);
  as(clerk);
  const posted = await inventory.postStockDocument(grnId);
  ok("posting it receives the accepted 10", posted.ok && (await balance(A.id)).qty === 10 && (await balance(A.id)).value === 1000, posted.ok ? await balance(A.id) : posted.error);
  ok("  the item's total says 10", (await onHand(A.id)) === 10);
  const layer = await db.stockCostLayer.findFirst({ where: { itemId: A.id }, select: { remaining: true, unitCost: true } });
  ok("  with a cost layer of 10 at ₹100", Number(layer?.remaining) === 10 && Number(layer?.unitCost) === 100, layer);
  const grnEntry = await entry(`stockdoc:${grnId}`);
  ok("  and Dr Stock in Hand ₹1,000 / Cr Goods Received Not Invoiced ₹1,000", grnEntry?.source === "INVENTORY" && grnEntry.on("INVENTORY") === 1000 && grnEntry.on("GRNI") === -1000);
  const again = await inventory.postStockDocument(grnId);
  ok("posting it again is refused and moves nothing", !again.ok && (await balance(A.id)).qty === 10, again.ok ? "POSTED TWICE" : again.error);
  const detail = await inventory.getStockDocument(grnId);
  ok("  its detail shows the movement and the entry", detail?.status === "POSTED" && detail.movements.length === 1 && detail.journalEntries.length === 1);
  const edited = await draft(clerk, { id: grnId, type: "GRN", date: day, warehouseId: "wh_main", companyId: vendor.id, lines: [{ itemId: A.id, quantity: 50, unitCost: 1 }] });
  ok("  and a posted voucher can't be edited", !edited.ok);

  section("Saving refuses what posting would");
  const noVendor = await draft(clerk, { type: "GRN", date: day, warehouseId: "wh_main", lines: [{ itemId: A.id, quantity: 1 }] });
  ok("a receipt without a vendor or an order", !noVendor.ok);
  const future = await draft(clerk, { type: "GRN", date: "2099-01-01", warehouseId: "wh_main", companyId: vendor.id, lines: [{ itemId: A.id, quantity: 1 }] });
  ok("a day that hasn't come", !future.ok);
  const svc = await draft(clerk, { type: "GRN", date: day, warehouseId: "wh_main", companyId: vendor.id, lines: [{ itemId: service.id, quantity: 1 }] });
  ok("a service, which keeps no stock", !svc.ok);
  const noReason = await draft(boss, { type: "ADJUSTMENT", date: day, warehouseId: "wh_main", lines: [{ itemId: A.id, quantity: -1 }] });
  ok("an adjustment without a reason", !noReason.ok);
  const sameWh = await draft(clerk, { type: "TRANSFER", date: day, warehouseId: "wh_main", toWarehouseId: "wh_main", lines: [{ itemId: A.id, quantity: 1 }] });
  ok("a transfer to the warehouse it's in", !sameWh.ok);
  const serialCount = await draft(clerk, { type: "GRN", date: day, warehouseId: "wh_main", companyId: vendor.id, lines: [{ itemId: S.id, quantity: 2, unitCost: 1000, serialNumbers: "S1" }] });
  ok("serials that don't match the quantity", !serialCount.ok);
  const noBatch = await draft(clerk, { type: "GRN", date: day, warehouseId: "wh_main", companyId: vendor.id, lines: [{ itemId: B.id, quantity: 2, unitCost: 10 }] });
  ok("a batch item without its batch", !noBatch.ok);
  const noExpiry = await draft(clerk, { type: "GRN", date: day, warehouseId: "wh_main", companyId: vendor.id, lines: [{ itemId: B.id, quantity: 2, unitCost: 10, batchNo: "X1" }] });
  ok("  or its expiry date", !noExpiry.ok);

  // ── A tax invoice ──────────────────────────────────────────────────────────────────────────────
  section("A tax invoice issues its goods");
  const invoice = await db.tradeDocument.create({
    data: {
      docNumber: `${TAG}-INV-001`, docType: "INVOICE", direction: "SALES", status: "DRAFT", companyId: customer.id, createdById: owner.id,
      issueDate: new Date(`${day}T06:00:00.000Z`), currency: "INR", exchangeRate: 1, subtotal: 1500, taxableValue: 1500, igstAmount: 270, total: 1770,
      lines: { create: [{ name: "A", itemId: A.id, quantity: 3, unitPrice: 500, taxRatePercent: 18, taxableValue: 1500, igstAmount: 270, lineTotal: 1770, sortOrder: 0 }] },
    },
    select: { id: true },
  });
  as(owner);
  const issued = await docs.issueTradeDocument({ id: invoice.id });
  ok("issued", issued.ok, issued.ok ? "" : issued.error);
  const sold = await db.stockMovement.findMany({ where: { tradeDocumentId: invoice.id }, select: { quantityChange: true, value: true, type: true } });
  ok("  3 sold out of the main warehouse at the average cost, ₹300", sold.length === 1 && Number(sold[0]!.quantityChange) === -3 && Number(sold[0]!.value) === -300 && sold[0]!.type === "SOLD", sold);
  const cogs = await entry(`stock:doc:${invoice.id}`);
  ok("  Dr Cost of Goods Sold ₹300 / Cr Stock in Hand ₹300", cogs?.on("COGS") === 300 && cogs.on("INVENTORY") === -300);
  const reissue = await docs.issueTradeDocument({ id: invoice.id });
  ok("  issuing it again is refused, and nothing more moves", !reissue.ok && (await balance(A.id)).qty === 7);
  const cancelled = await docs.setTradeDocumentStatus(invoice.id, "CANCELLED", "Raised in error");
  ok("cancelling the invoice puts the 3 back at ₹300", cancelled.ok && (await balance(A.id)).qty === 10 && (await balance(A.id)).value === 1000, cancelled.ok ? await balance(A.id) : cancelled.error);
  ok("  and reverses the cost-of-sales entry", !!(await entry(`stock:doc:${invoice.id}:reversal`)));

  // ── Delivery challan → invoice ─────────────────────────────────────────────────────────────────
  section("A delivery challan takes the goods out; the invoice raised from it doesn't again");
  const beforeChallan = await balance(A.id);
  const salesDoc = (docNumber: string, docType: "DELIVERY_CHALLAN" | "INVOICE", sourceDocumentId: string | null = null) =>
    db.tradeDocument.create({
      data: {
        docNumber, docType, direction: "SALES", status: "DRAFT", companyId: customer.id, createdById: owner.id, sourceDocumentId,
        issueDate: new Date(`${day}T06:00:00.000Z`), currency: "INR", exchangeRate: 1, subtotal: 1000, taxableValue: 1000, igstAmount: docType === "INVOICE" ? 180 : 0, total: docType === "INVOICE" ? 1180 : 1000,
        lines: { create: [{ name: "A", itemId: A.id, quantity: 2, unitPrice: 500, taxRatePercent: 18, taxableValue: 1000, igstAmount: docType === "INVOICE" ? 180 : 0, lineTotal: docType === "INVOICE" ? 1180 : 1000, sortOrder: 0 }] },
      },
      select: { id: true },
    });
  const challan = await salesDoc(`${TAG}-DC-001`, "DELIVERY_CHALLAN");
  as(owner);
  const challanIssued = await docs.issueTradeDocument({ id: challan.id });
  ok("issuing the challan takes 2 out", challanIssued.ok && (await balance(A.id)).qty === beforeChallan.qty - 2, challanIssued.ok ? await balance(A.id) : challanIssued.error);
  const challanCogs = await entry(`stock:doc:${challan.id}`);
  ok("  Dr Cost of Goods Sold / Cr Stock in Hand ₹200", challanCogs?.on("COGS") === 200 && challanCogs.on("INVENTORY") === -200);
  const fromChallan = await salesDoc(`${TAG}-INV-002`, "INVOICE", challan.id);
  const invoiceIssued = await docs.issueTradeDocument({ id: fromChallan.id });
  ok("the invoice raised from it issues without moving stock again", invoiceIssued.ok && (await balance(A.id)).qty === beforeChallan.qty - 2 && (await db.stockMovement.count({ where: { tradeDocumentId: fromChallan.id } })) === 0, invoiceIssued.ok ? "" : invoiceIssued.error);
  ok("  nor costing it twice", !(await entry(`stock:doc:${fromChallan.id}`)));
  const challanCancel = await docs.setTradeDocumentStatus(challan.id, "CANCELLED", "Raised in error");
  ok("the challan can't be cancelled while its invoice stands", !challanCancel.ok && /cancel the invoice first/.test(challanCancel.ok ? "" : challanCancel.error), challanCancel.ok ? "CANCELLED" : challanCancel.error);
  ok("  and nothing moved", (await balance(A.id)).qty === beforeChallan.qty - 2 && (await db.tradeDocument.findUnique({ where: { id: challan.id }, select: { status: true } }))?.status === "ISSUED");
  const invoiceCancel = await docs.setTradeDocumentStatus(fromChallan.id, "CANCELLED", "Raised in error");
  ok("cancelling the invoice moves no stock — it never moved any", invoiceCancel.ok && (await balance(A.id)).qty === beforeChallan.qty - 2, invoiceCancel.ok ? "" : invoiceCancel.error);
  const challanCancel2 = await docs.setTradeDocumentStatus(challan.id, "CANCELLED", "Goods came back");
  ok("then the challan cancels, and the 2 come back at their value", challanCancel2.ok && (await balance(A.id)).qty === beforeChallan.qty && (await balance(A.id)).value === beforeChallan.value, challanCancel2.ok ? await balance(A.id) : challanCancel2.error);
  ok("  its cost-of-sales entry reversed", !!(await entry(`stock:doc:${challan.id}:reversal`)));

  // ── Idempotency ────────────────────────────────────────────────────────────────────────────────
  section("The same key moves stock once");
  const first = await move({ itemId: A.id, warehouseId: "wh_main", quantity: 2, type: "RECEIVED", idempotencyKey: `${TAG}:once`, unitCost: 100 });
  const second = await move({ itemId: A.id, warehouseId: "wh_main", quantity: 2, type: "RECEIVED", idempotencyKey: `${TAG}:once`, unitCost: 100 });
  ok("two calls, one movement", first[0]?.id === second[0]?.id && (await db.stockMovement.count({ where: { idempotencyKey: `${TAG}:once` } })) === 1);
  ok("  and the item moved by 2, not 4", (await onHand(A.id)) === 12 && (await balance(A.id)).qty === 12);

  // ── Negative stock ─────────────────────────────────────────────────────────────────────────────
  section("Negative stock");
  await move({ itemId: N.id, warehouseId: "wh_main", quantity: 1, type: "RECEIVED", idempotencyKey: `${TAG}:n1`, unitCost: 50 });
  const tooMuch = await refused(() => move({ itemId: N.id, warehouseId: "wh_main", quantity: -3, type: "ADJUSTMENT", idempotencyKey: `${TAG}:n2` }));
  ok("taking 3 of 1 is refused", !!tooMuch && /Not enough/.test(tooMuch), tooMuch);
  s = await settings({ allowNegativeStock: true });
  const negative = await refused(() => move({ itemId: N.id, warehouseId: "wh_main", quantity: -3, type: "ADJUSTMENT", idempotencyKey: `${TAG}:n3` }));
  ok("allowed when the company allows it", negative === null && (await balance(N.id)).qty === -2, negative);
  await move({ itemId: N.id, warehouseId: "wh_main", quantity: 5, type: "RECEIVED", idempotencyKey: `${TAG}:n4`, unitCost: 60 });
  const nLayers = await db.stockCostLayer.aggregate({ where: { itemId: N.id }, _sum: { remaining: true } });
  ok("  a receipt fills what was owed first: 3 on hand, 3 in layers", (await balance(N.id)).qty === 3 && Number(nLayers._sum.remaining) === 3, { balance: await balance(N.id), layers: Number(nLayers._sum.remaining) });
  await move({ itemId: B.id, warehouseId: "wh_main", quantity: 1, type: "RECEIVED", idempotencyKey: `${TAG}:b0`, unitCost: 10, batch: { batchNo: "B-OLD", expiryDate: new Date("2025-01-01") } });
  const batchNeg = await refused(() => move({ itemId: B.id, warehouseId: "wh_main", quantity: -5, type: "ADJUSTMENT", idempotencyKey: `${TAG}:bneg` }));
  ok("  but never for batches", !!batchNeg && /Batches can't go below nothing|Not enough/.test(batchNeg), batchNeg);
  s = await settings({ allowNegativeStock: false });

  // ── Concurrency ────────────────────────────────────────────────────────────────────────────────
  section("Two sales of the last unit at once");
  await move({ itemId: L.id, warehouseId: "wh_main", quantity: 1, type: "RECEIVED", idempotencyKey: `${TAG}:l0`, unitCost: 10 });
  const race = await Promise.allSettled([
    move({ itemId: L.id, warehouseId: "wh_main", quantity: -1, type: "SOLD", idempotencyKey: `${TAG}:l1` }),
    move({ itemId: L.id, warehouseId: "wh_main", quantity: -1, type: "SOLD", idempotencyKey: `${TAG}:l2` }),
  ]);
  const won = race.filter((r) => r.status === "fulfilled").length;
  const lost = race.filter((r) => r.status === "rejected" && r.reason instanceof engine.StockError).length;
  ok("one succeeds, the other is told there isn't enough", won === 1 && lost === 1, race.map((r) => r.status));
  ok("  and the balance is nothing, not below", (await balance(L.id)).qty === 0 && (await onHand(L.id)) === 0);

  // ── Costing ────────────────────────────────────────────────────────────────────────────────────
  section("Weighted average and FIFO");
  for (const [it, settingsNow] of [[C, s], [D, { ...s, costingMethod: "FIFO" as const }]] as const) {
    await move({ itemId: it.id, warehouseId: "wh_main", quantity: 10, type: "RECEIVED", idempotencyKey: `${TAG}:${it.id}:r1`, unitCost: 100 }, settingsNow);
    await move({ itemId: it.id, warehouseId: "wh_main", quantity: 10, type: "RECEIVED", idempotencyKey: `${TAG}:${it.id}:r2`, unitCost: 130 }, settingsNow);
  }
  const wa = await move({ itemId: C.id, warehouseId: "wh_main", quantity: -15, type: "SOLD", idempotencyKey: `${TAG}:wa` });
  ok("weighted average: 15 of 10 @ ₹100 and 10 @ ₹130 cost ₹1,725 (₹115 each)", wa[0]?.valuePaise === 172500, wa[0]?.valuePaise);
  ok("  leaving 5 worth ₹575", (await balance(C.id)).qty === 5 && (await balance(C.id)).value === 575, await balance(C.id));
  const fifo = await move({ itemId: D.id, warehouseId: "wh_main", quantity: -15, type: "SOLD", idempotencyKey: `${TAG}:fifo` }, { ...s, costingMethod: "FIFO" });
  ok("FIFO: the same 15 cost ₹1,650 — 10 @ ₹100, then 5 @ ₹130", fifo[0]?.valuePaise === 165000, fifo[0]?.valuePaise);
  ok("  leaving 5 worth ₹650, all in the ₹130 layer", (await balance(D.id)).value === 650 && Number((await db.stockCostLayer.aggregate({ where: { itemId: D.id, remaining: { gt: 0 } }, _min: { unitCost: true } }))._min.unitCost) === 130);

  // ── Batches ────────────────────────────────────────────────────────────────────────────────────
  section("Batches, first to expire first out");
  await move({ itemId: B.id, warehouseId: "wh_main", quantity: 5, type: "RECEIVED", idempotencyKey: `${TAG}:b1`, unitCost: 10, batch: { batchNo: "B-DEC", expiryDate: new Date("2026-12-31") } });
  await move({ itemId: B.id, warehouseId: "wh_main", quantity: 5, type: "RECEIVED", idempotencyKey: `${TAG}:b2`, unitCost: 12, batch: { batchNo: "B-NOV", expiryDate: new Date("2026-11-30") } });
  const fefo = await move({ itemId: B.id, warehouseId: "wh_main", quantity: -6, type: "SOLD", idempotencyKey: `${TAG}:fefo`, skipExpired: true });
  const batchNo = async (id: string | null) => (id ? (await db.itemBatch.findUnique({ where: { id }, select: { batchNo: true } }))?.batchNo : null);
  const picked = await Promise.all(fefo.map(async (m) => `${await batchNo(m.batchId)}:${m.quantity}`));
  ok("a sale of 6 takes November's 5, then 1 of December's — past the expired batch", picked.join(",") === "B-NOV:-5,B-DEC:-1", picked);
  ok("  two movements, keyed <key>#1 and #2", (await db.stockMovement.count({ where: { idempotencyKey: { in: [`${TAG}:fefo#1`, `${TAG}:fefo#2`] } } })) === 2);
  const expiredOnly = await refused(() => move({ itemId: B.id, warehouseId: "wh_main", quantity: -5, type: "SOLD", idempotencyKey: `${TAG}:fefo2`, skipExpired: true }));
  ok("selling 5 more of the 4 unexpired is refused, naming the expired batch", !!expiredOnly && /Expired batches/.test(expiredOnly), expiredOnly);
  const writeOff = await refused(() => move({ itemId: B.id, warehouseId: "wh_main", quantity: -1, type: "DAMAGED", idempotencyKey: `${TAG}:expired`, batch: { batchNo: "B-OLD" } }));
  ok("  but the expired batch can be written off by naming it", writeOff === null, writeOff);
  const noExpiryEngine = await refused(() => move({ itemId: B.id, warehouseId: "wh_main", quantity: 1, type: "RECEIVED", idempotencyKey: `${TAG}:b3`, batch: { batchNo: "B-NEW" } }));
  ok("a new batch of an item that keeps expiry needs its date", !!noExpiryEngine && /expiry/.test(noExpiryEngine), noExpiryEngine);

  // ── Serials ────────────────────────────────────────────────────────────────────────────────────
  section("Serial numbers");
  await move({ itemId: S.id, warehouseId: "wh_main", quantity: 2, type: "RECEIVED", idempotencyKey: `${TAG}:s1`, unitCost: 1000, serials: ["SN-1", "SN-2"] });
  ok("two received, two serials in stock", (await db.itemSerial.count({ where: { itemId: S.id, status: "IN_STOCK" } })) === 2);
  const twice = await refused(() => move({ itemId: S.id, warehouseId: "wh_main", quantity: 1, type: "RECEIVED", idempotencyKey: `${TAG}:s2`, unitCost: 1000, serials: ["SN-1"] }));
  ok("a serial already in stock can't come in again", !!twice && /already in stock/.test(twice), twice);
  const wrongCount = await refused(() => move({ itemId: S.id, warehouseId: "wh_main", quantity: -2, type: "SOLD", idempotencyKey: `${TAG}:s3`, serials: ["SN-1"] }));
  ok("the wrong number of serials is refused", !!wrongCount && /give one for each/.test(wrongCount), wrongCount);
  const unknown = await refused(() => move({ itemId: S.id, warehouseId: "wh_main", quantity: -1, type: "SOLD", idempotencyKey: `${TAG}:s4`, serials: ["SN-9"] }));
  ok("a serial that isn't in stock is refused", !!unknown && /isn't in stock/.test(unknown), unknown);
  const dup = await refused(() => move({ itemId: S.id, warehouseId: "wh_main", quantity: -2, type: "SOLD", idempotencyKey: `${TAG}:s5`, serials: ["SN-1", "SN-1"] }));
  ok("the same serial twice is refused", !!dup && /twice/.test(dup), dup);
  const fraction = await refused(() => move({ itemId: S.id, warehouseId: "wh_main", quantity: -0.5, type: "SOLD", idempotencyKey: `${TAG}:s6`, serials: [] }));
  ok("half a serialised unit is refused", !!fraction && /whole units/.test(fraction), fraction);
  await move({ itemId: S.id, warehouseId: "wh_main", quantity: -1, type: "SOLD", idempotencyKey: `${TAG}:s7`, serials: ["SN-2"] });
  ok("selling SN-2 marks it issued", (await db.itemSerial.findFirst({ where: { itemId: S.id, serialNo: "SN-2" }, select: { status: true } }))?.status === "ISSUED");

  // ── Transfer ───────────────────────────────────────────────────────────────────────────────────
  section("A transfer");
  const before = await balance(A.id);
  const trf = await draft(clerk, { type: "TRANSFER", date: day, warehouseId: "wh_main", toWarehouseId: WH2, lines: [{ itemId: A.id, quantity: 2 }] });
  ok("drafted", trf.ok, trf.ok ? trf.data.number : trf.error);
  const trfId = trf.ok ? trf.data.id : "";
  as(clerk);
  const sent = await inventory.postStockDocument(trfId);
  const trfDoc = await db.stockDocument.findUnique({ where: { id: trfId }, select: { status: true } });
  ok("sending it takes 2 out and leaves it in transit", sent.ok && trfDoc?.status === "IN_TRANSIT" && (await balance(A.id)).qty === before.qty - 2 && (await balance(A.id, WH2)).qty === 0, sent.ok ? trfDoc : sent.error);
  const received = await inventory.receiveStockTransfer(trfId);
  ok("receiving it puts 2 into the godown", received.ok && (await balance(A.id, WH2)).qty === 2, received.ok ? "" : received.error);
  const trfMoves = await db.stockMovement.findMany({ where: { stockDocumentId: trfId }, select: { type: true, value: true } });
  const outValue = trfMoves.find((m) => m.type === "TRANSFER_OUT")?.value;
  const inValue = trfMoves.find((m) => m.type === "TRANSFER_IN")?.value;
  ok("  at the value it left with", Number(outValue) === -Number(inValue) && Number(inValue) === 200, { outValue: Number(outValue), inValue: Number(inValue) });
  ok("  and a transfer writes no entry", !(await entry(`stockdoc:${trfId}`)));
  const receivedTwice = await inventory.receiveStockTransfer(trfId);
  ok("  receiving it again is refused", !receivedTwice.ok);

  // ── Adjustment with approval ───────────────────────────────────────────────────────────────────
  section("An adjustment waits for somebody else's approval");
  const adj = await draft(boss, { type: "ADJUSTMENT", date: day, warehouseId: "wh_main", reason: "Damaged in the store", lines: [{ itemId: A.id, quantity: -1 }] });
  const adjId = adj.ok ? adj.data.id : "";
  as(boss);
  const straight = await inventory.postStockDocument(adjId);
  ok("posting it straight away is refused", !straight.ok, straight.ok ? "POSTED" : straight.error);
  const submitted = await inventory.submitStockDocument(adjId);
  ok("sent for approval", submitted.ok && (await db.stockDocument.findUnique({ where: { id: adjId }, select: { status: true } }))?.status === "PENDING_APPROVAL");
  const own = await inventory.approveStockDocument(adjId);
  ok("its author can't approve it", !own.ok && /own/.test(own.ok ? "" : own.error), own.ok ? "APPROVED" : own.error);
  as(clerk);
  const noRight = await inventory.approveStockDocument(adjId);
  ok("nor can somebody without “Approve stock adjustments”", !noRight.ok, noRight.ok ? "APPROVED" : noRight.error);
  const beforeAdj = await balance(A.id);
  as(boss2);
  const approved = await inventory.approveStockDocument(adjId);
  ok("another manager approves it, and it posts", approved.ok && (await balance(A.id)).qty === beforeAdj.qty - 1, approved.ok ? "" : approved.error);
  const adjMove = await db.stockMovement.findFirst({ where: { stockDocumentId: adjId }, select: { type: true } });
  ok("  as damage, since its reason says so", adjMove?.type === "DAMAGED", adjMove?.type);
  const adjEntry = await entry(`stockdoc:${adjId}`);
  ok("  Dr Stock Adjustments / Cr Stock in Hand ₹100", adjEntry?.on("STOCK_ADJUSTMENT") === 100 && adjEntry.on("INVENTORY") === -100);
  const adjDoc = await db.stockDocument.findUnique({ where: { id: adjId }, select: { approvedById: true, postedById: true } });
  ok("  approved and posted by the approver", adjDoc?.approvedById === boss2.id && adjDoc.postedById === boss2.id);

  // ── Physical count ─────────────────────────────────────────────────────────────────────────────
  section("A physical count");
  const books = (await balance(A.id)).qty;
  const count = await draft(boss, { type: "PHYSICAL_COUNT", date: day, warehouseId: "wh_main", reason: "Quarterly count", lines: [{ itemId: A.id, countedQty: books - 2 }] });
  const countId = count.ok ? count.data.id : "";
  as(boss);
  await inventory.submitStockDocument(countId);
  as(boss2);
  const counted = await inventory.approveStockDocument(countId);
  const countLine = await db.stockDocumentLine.findFirst({ where: { stockDocumentId: countId }, select: { systemQty: true, quantity: true } });
  ok("approved, it posts the difference: 2 missing", counted.ok && (await balance(A.id)).qty === books - 2 && Number(countLine?.systemQty) === books && Number(countLine?.quantity) === -2, counted.ok ? countLine : counted.error);

  // ── Purchase return ────────────────────────────────────────────────────────────────────────────
  section("A purchase return");
  const buyerReturn = await draft(buyer, { type: "PURCHASE_RETURN", date: day, warehouseId: "wh_main", companyId: vendor.id, reason: "Wrong model", lines: [{ itemId: A.id, quantity: 1 }] });
  ok("a buyer without “Adjust stock” can't write a return to a vendor", !buyerReturn.ok, buyerReturn.ok ? "DRAFTED" : buyerReturn.error);
  const ret = await draft(clerk, { type: "PURCHASE_RETURN", date: day, warehouseId: "wh_main", companyId: vendor.id, reason: "Wrong model", lines: [{ itemId: A.id, quantity: 1 }] });
  const retId = ret.ok ? ret.data.id : "";
  const beforeReturn = await balance(A.id);
  as(buyer);
  const returned = await inventory.postStockDocument(retId);
  ok("  nor post one", !returned.ok, returned.ok ? "POSTED" : returned.error);
  as(clerk);
  const returned2 = await inventory.postStockDocument(retId);
  const retEntry = await entry(`stockdoc:${retId}`);
  ok("accounts posts it: 1 out, Dr Purchases / Cr Stock in Hand ₹100", returned2.ok && (await balance(A.id)).qty === beforeReturn.qty - 1 && retEntry?.on("PURCHASES") === 100 && retEntry.on("INVENTORY") === -100, returned2.ok ? "" : returned2.error);

  // ── Cancelling a posted voucher ────────────────────────────────────────────────────────────────
  section("Cancelling a posted voucher");
  const grn2 = await draft(buyer, { type: "GRN", date: day, warehouseId: "wh_main", companyId: vendor.id, lines: [{ itemId: A.id, quantity: 4, unitCost: 90 }] });
  const grn2Id = grn2.ok ? grn2.data.id : "";
  const beforeGrn2 = await balance(A.id);
  as(buyer);
  const buyerPosted = await inventory.postStockDocument(grn2Id);
  ok("a buyer receives goods", buyerPosted.ok, buyerPosted.ok ? "" : buyerPosted.error);
  const buyerCancel = await inventory.cancelStockDocument(grn2Id, "Wrong vendor");
  ok("  but cancelling stock that has moved needs “Adjust stock”", !buyerCancel.ok);
  as(boss);
  const noWhy = await inventory.cancelStockDocument(grn2Id, " ");
  ok("  and a reason", !noWhy.ok);
  const cancelledGrn = await inventory.cancelStockDocument(grn2Id, "Wrong vendor");
  const afterCancel = await balance(A.id);
  ok("cancelled: the 4 come back out, balance and value as before", cancelledGrn.ok && afterCancel.qty === beforeGrn2.qty && afterCancel.value === beforeGrn2.value, { before: beforeGrn2, after: afterCancel, error: cancelledGrn.ok ? "" : cancelledGrn.error });
  const reversal = await entry(`stockdoc:${grn2Id}:reversal`);
  ok("  and its entry is reversed", reversal?.on("INVENTORY") === -360 && reversal.on("GRNI") === 360);
  ok("  the movements are kept, each with its reversal", (await db.stockMovement.count({ where: { stockDocumentId: grn2Id } })) === 2 && (await db.stockMovement.count({ where: { stockDocumentId: grn2Id, reversesId: { not: null } } })) === 1);
  const recancel = await inventory.cancelStockDocument(grn2Id, "Again");
  ok("  cancelling again changes nothing", recancel.ok && (await balance(A.id)).qty === afterCancel.qty);
  const draftOnly = await draft(clerk, { type: "GRN", date: day, warehouseId: "wh_main", companyId: vendor.id, lines: [{ itemId: A.id, quantity: 1, unitCost: 1 }] });
  as(clerk);
  const draftCancel = await inventory.cancelStockDocument(draftOnly.ok ? draftOnly.data.id : "", "Not needed");
  ok("a draft is simply cancelled by its maker", draftCancel.ok && (await db.stockDocument.findUnique({ where: { id: draftOnly.ok ? draftOnly.data.id : "" }, select: { status: true } }))?.status === "CANCELLED");

  // ── Periodic inventory ─────────────────────────────────────────────────────────────────────────
  section("Periodic inventory writes no entries");
  s = await settings({ inventoryAccounting: "PERIODIC" });
  const grn3 = await draft(clerk, { type: "GRN", date: day, warehouseId: "wh_main", companyId: vendor.id, lines: [{ itemId: A.id, quantity: 1, unitCost: 100 }] });
  as(clerk);
  const p3 = await inventory.postStockDocument(grn3.ok ? grn3.data.id : "");
  ok("a receipt under periodic inventory moves stock but posts nothing", p3.ok && !(await entry(`stockdoc:${grn3.ok ? grn3.data.id : ""}`)), p3.ok ? "" : p3.error);

  // ── Permissions ────────────────────────────────────────────────────────────────────────────────
  section("Permissions");
  const repGrn = await draft(rep, { type: "GRN", date: day, warehouseId: "wh_main", companyId: vendor.id, lines: [{ itemId: A.id, quantity: 1, unitCost: 1 }] });
  ok("a salesperson can't write a goods receipt", !repGrn.ok, repGrn.ok ? "DRAFTED" : repGrn.error);
  as(rep);
  const repCaps = await inventory.inventoryCapabilities();
  ok("  but can look at stock", repCaps.view && !repCaps.receive && !repCaps.adjust);
  const repTracking = await inventory.setItemTracking(A.id, { trackBatches: false, trackExpiry: false, trackSerials: false });
  ok("  and can't change how an item is tracked", !repTracking.ok);
  as(boss);
  const withStock = await inventory.setItemTracking(A.id, { trackBatches: true, trackExpiry: false, trackSerials: false });
  ok("batches can't be switched on while there is stock", !withStock.ok);
  const emptyTracking = await inventory.setItemTracking(L.id, { trackBatches: true, trackExpiry: true, trackSerials: false, reorderQuantity: 5 });
  ok("  but can with none", emptyTracking.ok, emptyTracking.ok ? "" : emptyTracking.error);

  // ── Integrity ──────────────────────────────────────────────────────────────────────────────────
  section("Everything agrees");
  const entries = await db.journalEntry.findMany({ where: { source: "INVENTORY" }, select: { entryNumber: true, lines: { select: { debit: true, credit: true } } } });
  const unbalanced = entries.filter((e) => Math.round(e.lines.reduce((t, l) => t + Number(l.debit) - Number(l.credit), 0) * 100) !== 0);
  ok("every inventory entry balances", entries.length > 0 && unbalanced.length === 0, { entries: entries.length, unbalanced: unbalanced.map((e) => e.entryNumber) });
  const byKey = await db.$queryRaw<{ itemId: string; warehouseId: string; batchKey: string; mq: string; mv: string; bq: string | null; bv: string | null }[]>`
    SELECT m."itemId", m."warehouseId", COALESCE(m."batchId", '') AS "batchKey", SUM(m."quantityChange")::text AS mq, SUM(COALESCE(m."value", 0))::text AS mv,
           MAX(b."quantity")::text AS bq, MAX(b."value")::text AS bv
    FROM "stock_movements" m
    LEFT JOIN "stock_balances" b ON b."itemId" = m."itemId" AND b."warehouseId" = m."warehouseId" AND b."batchKey" = COALESCE(m."batchId", '')
    WHERE m."warehouseId" IS NOT NULL
    GROUP BY 1, 2, 3`;
  const off = byKey.filter((r) => Number(r.mq) !== Number(r.bq ?? 0) || Math.round(Number(r.mv) * 100) !== Math.round(Number(r.bv ?? 0) * 100));
  ok("balances are the sum of their movements — quantity and value", byKey.length > 0 && off.length === 0, off.slice(0, 3));
  const items = await db.item.findMany({ where: { trackInventory: true }, select: { id: true, name: true, stockQuantity: true } });
  const sums = await db.stockBalance.groupBy({ by: ["itemId"], _sum: { quantity: true } });
  const itemOff = items.filter((i) => Number(i.stockQuantity) !== Number(sums.find((x) => x.itemId === i.id)?._sum.quantity ?? 0));
  ok("each item's total is the sum of its balances", itemOff.length === 0, itemOff.map((i) => i.name));
  const negativeLayers = await db.stockCostLayer.count({ where: { remaining: { lt: 0 } } });
  ok("no cost layer below nothing", negativeLayers === 0, negativeLayers);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

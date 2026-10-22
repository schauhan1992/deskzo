"use server";

import type { Prisma, StockMovementType, StockSourceType, SerialStatus, StockDocumentStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { logActivity } from "@/lib/activity";
import { getSecurityPolicy } from "@/lib/security/store";
import { exportDecision } from "@/lib/security/policy";
import { notMigratedYet } from "@/lib/not-migrated";
import { indiaClock, calendarDayRange } from "@/lib/time/zone";
import { financialYearBounds } from "@/lib/india-time";
import { bookingRate } from "@/lib/ledger/posting";
import { fromMilli, fromPaise, round2, round3, toCost4, toMilli, toPaise, valuePaise } from "@/lib/accounts/money";
import { AGING_BUCKETS, ageInDays, agingBucketOf } from "@/lib/inventory/costing";
import { resolvePage, resolvePageSize } from "@/lib/pagination";
import { dateParam, tableToCsv, type Cell, type ReportColumn, type ReportResult, type ReportRow, type ReportTable } from "@/components/reports/accounts/table";
import type { ActionResult } from "@/actions/company";

/**
 * Stock reports, under Finance → Accounts (owner, 22 Oct 2026): what is on hand and what it is worth, where it
 * is, how it moved, what is expiring, what needs ordering, what sits unsold, and what each item earns.
 *
 * Read-only, built from the stock engine's own records (src/lib/inventory): the balances it keeps per item,
 * warehouse and batch, the movement log every change goes through, and the cost layers FIFO draws from. A
 * valuation "as of" a date is the sum of the movements up to it — each at the value it was booked at — so it
 * agrees with today's balances when the date is today, and isn't a guess for a day gone by.
 *
 * Reading is `inventory.view` (or any stock permission, as the inventory screens take it); item profitability
 * shows sales and margins, so it needs the books' `ledger.viewReports` too. Downloading any of them as CSV is
 * `data.exportFinance` as well, under the workspace's export row limit, and logged either way.
 */

export type StockReportKey =
  | "summary"
  | "warehouses"
  | "ledger"
  | "movements"
  | "transfers"
  | "batches"
  | "serials"
  | "reorder"
  | "variance"
  | "valuation"
  | "aging"
  | "slow"
  | "profitability";

export type StockReportParams = {
  page?: string | number;
  pageSize?: string | number;
  q?: string;
  warehouse?: string;
  category?: string;
  brand?: string;
  item?: string;
  from?: string;
  to?: string;
  asOf?: string;
  type?: string;
  source?: string;
  status?: string;
  expiry?: string;
  days?: string | number;
};

const KEYS: readonly StockReportKey[] = ["summary", "warehouses", "ledger", "movements", "transfers", "batches", "serials", "reorder", "variance", "valuation", "aging", "slow", "profitability"];
/** The most rows one download can carry, whatever the workspace's own limit says. */
const EXPORT_CAP = 100_000;

const MOVEMENT_TYPES: readonly StockMovementType[] = ["OPENING", "RECEIVED", "SOLD", "RETURNED", "ADJUSTMENT", "DAMAGED", "TRANSFER_IN", "TRANSFER_OUT", "PURCHASE_RETURN"];
const SOURCE_TYPES: readonly StockSourceType[] = ["MANUAL", "OPENING", "SALES_INVOICE", "CREDIT_NOTE", "PURCHASE_BILL", "GRN", "TRANSFER", "ADJUSTMENT", "PHYSICAL_COUNT", "PURCHASE_RETURN", "MIGRATION"];
const SERIAL_STATUSES: readonly SerialStatus[] = ["IN_STOCK", "ISSUED", "RETURNED_TO_VENDOR", "SCRAPPED"];
const TRANSFER_STATUSES: readonly StockDocumentStatus[] = ["DRAFT", "IN_TRANSIT", "POSTED", "CANCELLED"];

const movementLabel: Record<StockMovementType, string> = {
  OPENING: "Opening",
  RECEIVED: "Received",
  SOLD: "Sold",
  RETURNED: "Returned",
  ADJUSTMENT: "Adjustment",
  DAMAGED: "Damaged / written off",
  TRANSFER_IN: "Transfer in",
  TRANSFER_OUT: "Transfer out",
  PURCHASE_RETURN: "Returned to vendor",
};
const sourceLabel: Record<StockSourceType, string> = {
  MANUAL: "Manual",
  OPENING: "Opening stock",
  SALES_INVOICE: "Sales invoice",
  CREDIT_NOTE: "Credit note",
  PURCHASE_BILL: "Vendor bill",
  GRN: "Goods receipt",
  TRANSFER: "Transfer",
  ADJUSTMENT: "Adjustment",
  PHYSICAL_COUNT: "Physical count",
  PURCHASE_RETURN: "Purchase return",
  MIGRATION: "Brought forward",
};
const serialLabel: Record<SerialStatus, string> = {
  IN_STOCK: "In stock",
  ISSUED: "Sold / issued",
  RETURNED_TO_VENDOR: "Returned to vendor",
  SCRAPPED: "Written off",
};
const transferLabel: Record<StockDocumentStatus, string> = {
  DRAFT: "Draft",
  PENDING_APPROVAL: "Waiting for approval",
  IN_TRANSIT: "In transit",
  POSTED: "Received",
  CANCELLED: "Cancelled",
};

const REPORT_TITLES: Record<StockReportKey, string> = {
  summary: "Stock summary",
  warehouses: "Warehouse-wise stock",
  ledger: "Item stock ledger",
  movements: "Stock movements",
  transfers: "Stock transfers",
  batches: "Batches & expiry",
  serials: "Serial numbers",
  reorder: "Low stock & reorder",
  variance: "Physical count variance",
  valuation: "Stock valuation",
  aging: "Stock aging",
  slow: "Slow-moving & dead stock",
  profitability: "Item profitability",
};

// ─── Who may read ────────────────────────────────────────────────────────────────────────────────

async function access() {
  const user = await requireModuleUser("items");
  const [view, receive, transfer, adjust, manage, books, exportFinance] = await Promise.all([
    can(user.id, "inventory.view"),
    can(user.id, "inventory.receive"),
    can(user.id, "inventory.transfer"),
    can(user.id, "inventory.adjust"),
    can(user.id, "inventory.manage"),
    can(user.id, "ledger.viewReports"),
    can(user.id, "data.exportFinance"),
  ]);
  return { user, view: view || receive || transfer || adjust || manage, books, exportFinance };
}

/** What the stock reports page may show this person. */
export async function stockReportAccess() {
  const a = await access();
  let migrated = true;
  try {
    await db.warehouse.count();
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
    migrated = false;
  }
  return { view: a.view, profitability: a.view && a.books, export: a.view && a.exportFinance, migrated };
}

/** The filters' choices: warehouses, item categories, and brands (when there are few enough to list). */
export async function stockReportOptions() {
  const a = await access();
  if (!a.view) return { warehouses: [], categories: [], brands: [] };
  try {
    const [warehouses, categories, brandCount] = await Promise.all([
      db.warehouse.findMany({ orderBy: [{ isDefault: "desc" }, { name: "asc" }], select: { id: true, name: true, code: true, active: true } }),
      db.item.findMany({ where: { type: "GOOD", trackInventory: true, category: { not: null } }, distinct: ["category"], orderBy: { category: "asc" }, select: { category: true } }),
      db.brand.count(),
    ]);
    const brands = brandCount <= 200 ? await db.brand.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }) : [];
    return {
      warehouses: warehouses.map((w) => ({ value: w.id, label: `${w.name}${w.active ? "" : " (closed)"}` })),
      categories: categories.map((c) => ({ value: c.category!, label: c.category! })),
      brands: brands.map((b) => ({ value: b.id, label: b.name })),
    };
  } catch (err) {
    if (notMigratedYet(err)) return { warehouses: [], categories: [], brands: [] };
    throw err;
  }
}

/** One stock report, a page of it, with totals over everything the filters match. */
export async function stockReport(key: StockReportKey, params: StockReportParams = {}): Promise<ReportResult> {
  const a = await access();
  if (!KEYS.includes(key)) return { status: "invalid", message: "There's no such stock report." };
  if (!a.view || (key === "profitability" && !a.books)) return { status: "forbidden" };
  try {
    return { status: "ok", table: await build(key, params, false) };
  } catch (err) {
    if (notMigratedYet(err)) return { status: "not-migrated" };
    if (err instanceof ReportInputError) return { status: "invalid", message: err.message };
    throw err;
  }
}

/**
 * A stock report as CSV — every row the filters match, not one page — for whoever may read it and holds the
 * finance export permission, within the workspace's export row limit. Logged as an export, or as a refusal.
 */
export async function exportStockReportCsv(key: StockReportKey, params: StockReportParams = {}): Promise<ActionResult<{ filename: string; csv: string; rows: number }>> {
  const a = await access();
  if (!KEYS.includes(key)) return { ok: false, error: "There's no such stock report." };
  if (!a.view || (key === "profitability" && !a.books)) return { ok: false, error: "You don't have permission to see this report." };
  const title = REPORT_TITLES[key];
  if (!a.exportFinance) {
    await logActivity({ kind: "PERMISSION_DENIED", severity: "WARNING", summary: `${a.user.name} tried to download the ${title.toLowerCase()} without the export permission`, metadata: { report: `stock-${key}` } });
    return { ok: false, error: "You can read this report but not download it. Downloading financial data needs the export permission." };
  }
  let table: ReportTable;
  try {
    table = await build(key, params, true);
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: "This workspace's database hasn't been brought up to date for inventory yet." };
    if (err instanceof ReportInputError) return { ok: false, error: err.message };
    throw err;
  }
  const verdict = exportDecision(table.rows.length, await getSecurityPolicy());
  const filters = await describeFilters(params);
  if (!verdict.allowed) {
    await logActivity({ kind: "EXPORT", severity: "WARNING", summary: `${a.user.name} was refused a download of the ${title.toLowerCase()} — ${table.rows.length} rows, over the limit`, metadata: { report: `stock-${key}`, rows: table.rows.length, filters: filters.meta } });
    return { ok: false, error: verdict.reason };
  }
  const csv = tableToCsv(table, [...filters.lines, ["Run by", a.user.name ?? ""]]);
  await logActivity({
    kind: "EXPORT",
    severity: "NOTICE",
    summary: `${a.user.name} downloaded the ${title.toLowerCase()} — ${table.rows.length} row(s)`,
    metadata: { report: `stock-${key}`, rows: table.rows.length, filters: filters.meta },
  });
  return { ok: true, data: { filename: `stock-${key}-${indiaClock.today()}.csv`, csv, rows: table.rows.length } };
}

/** The filters in words, for the file's heading, and as plain values for the activity log — never the search text itself. */
async function describeFilters(p: StockReportParams) {
  const lines: [string, string][] = [];
  const meta: Record<string, string | number | boolean> = {};
  if (p.warehouse) {
    const w = await db.warehouse.findUnique({ where: { id: p.warehouse }, select: { name: true } });
    lines.push(["Warehouse", w?.name ?? p.warehouse]);
    meta.warehouse = p.warehouse;
  }
  if (p.item) {
    const it = await db.item.findUnique({ where: { id: p.item }, select: { name: true } });
    lines.push(["Item", it?.name ?? p.item]);
    meta.item = p.item;
  }
  for (const [k, label] of [["category", "Category"], ["from", "From"], ["to", "To"], ["asOf", "As of"], ["type", "Type"], ["source", "Source"], ["status", "Status"], ["expiry", "Expiry"], ["days", "Days"]] as const) {
    const v = p[k];
    if (v !== undefined && v !== null && String(v) !== "") {
      lines.push([label, String(v)]);
      meta[k] = String(v);
    }
  }
  if (p.brand) meta.brand = p.brand;
  if (p.q?.trim()) {
    lines.push(["Search", p.q.trim()]);
    meta.search = true;
  }
  return { lines, meta };
}

// ─── The reports ─────────────────────────────────────────────────────────────────────────────────

/** A filter that can't be answered — an item that's gone — said on the page rather than thrown. */
class ReportInputError extends Error {}

type Paging = { page: number; pageSize: number; skip: number; take: number };

function paging(p: StockReportParams, all: boolean): Paging {
  if (all) return { page: 1, pageSize: EXPORT_CAP, skip: 0, take: EXPORT_CAP };
  const page = resolvePage(p.page === undefined ? undefined : String(p.page));
  const pageSize = resolvePageSize(p.pageSize === undefined ? undefined : String(p.pageSize));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

function slice<T>(rows: T[], pg: Paging): T[] {
  return rows.slice(pg.skip, pg.skip + pg.take);
}

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const itemCell = (item: { id: string; name: string; sku?: string | null }): Cell => ({ text: item.name, href: `/items/${item.id}`, sub: item.sku ?? null });
const day = (d: Date | null | undefined) => (d ? indiaClock.dateKey(d) : null);
/** A `@db.Date` column's day — held as midnight UTC, so its UTC date is the day. */
const calDay = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const avg = (qty: number, value: number) => (qty > 0 ? Math.round((value / qty) * 10000) / 10000 : null);

function itemWhere(p: StockReportParams): Prisma.ItemWhereInput {
  const q = p.q?.trim();
  return {
    type: "GOOD",
    trackInventory: true,
    ...(p.category ? { category: p.category } : {}),
    ...(p.brand ? { brandId: p.brand } : {}),
    ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { sku: { contains: q, mode: "insensitive" } }, { barcode: { contains: q } }] } : {}),
  };
}

/** A day range on a moment column, India's days, both ends in. */
function momentRange(from: string | null, to: string | null): Prisma.DateTimeFilter | undefined {
  const r = indiaClock.dayRange(from, to);
  return r ? { ...(r.gte ? { gte: r.gte } : {}), ...(r.lt ? { lt: r.lt } : {}) } : undefined;
}

function periodLabel(from: string | null, to: string | null) {
  if (from && to) return `${indiaClock.date(indiaClock.startOfDay(from)!)} to ${indiaClock.date(indiaClock.startOfDay(to)!)}`;
  if (from) return `From ${indiaClock.date(indiaClock.startOfDay(from)!)}`;
  if (to) return `Up to ${indiaClock.date(indiaClock.startOfDay(to)!)}`;
  return "All dates";
}

/** Where a movement came from, linked: its stock voucher, its invoice or bill, or what it was. */
function voucherCell(m: { sourceType: StockSourceType | null; reason: string | null; stockDocument: { id: string; number: string } | null; tradeDocument: { id: string; docNumber: string } | null }): Cell {
  if (m.stockDocument) return { text: m.stockDocument.number, href: `/items/stock/${m.stockDocument.id}`, sub: m.sourceType ? sourceLabel[m.sourceType] : null };
  if (m.tradeDocument) return { text: m.tradeDocument.docNumber, href: `/documents/${m.tradeDocument.id}`, sub: m.sourceType ? sourceLabel[m.sourceType] : null };
  return { text: m.sourceType ? sourceLabel[m.sourceType] : "Manual", sub: m.reason };
}

async function build(key: StockReportKey, p: StockReportParams, all: boolean): Promise<ReportTable> {
  const pg = paging(p, all);
  switch (key) {
    case "summary":
      return summary(p, pg);
    case "warehouses":
      return warehouseWise(p, pg);
    case "ledger":
      return itemLedger(p, pg);
    case "movements":
      return movements(p, pg);
    case "transfers":
      return transfers(p, pg);
    case "batches":
      return batches(p, pg);
    case "serials":
      return serials(p, pg);
    case "reorder":
      return reorder(p, pg);
    case "variance":
      return variance(p, pg);
    case "valuation":
      return valuation(p, pg);
    case "aging":
      return aging(p, pg);
    case "slow":
      return slow(p, pg);
    case "profitability":
      return profitability(p, pg);
  }
}

const base = (key: StockReportKey, pg: Paging, rest: Omit<ReportTable, "key" | "title" | "page" | "pageSize">): ReportTable => ({
  key,
  title: REPORT_TITLES[key],
  page: pg.page,
  pageSize: pg.pageSize,
  ...rest,
});

// Stock summary: every good that keeps stock, what's on hand and at what cost.
async function summary(p: StockReportParams, pg: Paging): Promise<ReportTable> {
  const where = itemWhere(p);
  const inWarehouse = p.warehouse ? { warehouseId: p.warehouse } : {};
  const [items, total, totals, reorderItems] = await Promise.all([
    db.item.findMany({
      where,
      orderBy: { name: "asc" },
      skip: pg.skip,
      take: pg.take,
      select: { id: true, name: true, sku: true, unit: true, category: true, reorderLevel: true, stockQuantity: true, active: true },
    }),
    db.item.count({ where }),
    db.stockBalance.aggregate({ where: { item: where, ...inWarehouse }, _sum: { quantity: true, value: true } }),
    db.item.findMany({ where: { ...where, reorderLevel: { not: null } }, select: { reorderLevel: true, stockQuantity: true } }),
  ]);
  const balances = await db.stockBalance.groupBy({ by: ["itemId"], where: { itemId: { in: items.map((i) => i.id) }, ...inWarehouse }, _sum: { quantity: true, value: true } });
  const below = reorderItems.filter((i) => n(i.stockQuantity) <= n(i.reorderLevel)).length;
  const rows: ReportRow[] = items.map((i) => {
    const b = balances.find((x) => x.itemId === i.id);
    const qty = round3(n(b?._sum.quantity));
    const value = round2(n(b?._sum.value));
    const onHandAll = n(i.stockQuantity);
    const isBelow = i.reorderLevel !== null && onHandAll <= i.reorderLevel;
    return {
      id: i.id,
      tone: qty < 0 ? "danger" : isBelow ? "warning" : undefined,
      cells: {
        item: itemCell(i),
        category: i.category,
        unit: i.unit,
        onHand: qty,
        avgCost: avg(qty, value),
        value,
        reorderLevel: i.reorderLevel,
        status: qty < 0 ? "Below nothing" : isBelow ? "Below reorder level" : i.active ? "" : "Inactive",
      },
    };
  });
  return base("summary", pg, {
    subtitle: p.warehouse ? "One warehouse" : "Every warehouse",
    columns: [
      { key: "item", label: "Item" },
      { key: "category", label: "Category" },
      { key: "unit", label: "Unit" },
      { key: "onHand", label: "On hand", kind: "qty" },
      { key: "avgCost", label: "Average cost", kind: "cost" },
      { key: "value", label: "Value", kind: "money" },
      { key: "reorderLevel", label: "Reorder level", kind: "qty" },
      { key: "status", label: "Status" },
    ],
    rows,
    totals: { onHand: round3(n(totals._sum.quantity)), value: round2(n(totals._sum.value)) },
    total,
    unit: "items",
    notes: [`${below} item(s) at or below their reorder level.`, "Value is the stock engine's own balance at cost — weighted average or FIFO, as Accounts settings say."],
  });
}

// Warehouse-wise: item by warehouse, a column each.
async function warehouseWise(p: StockReportParams, pg: Paging): Promise<ReportTable> {
  const where: Prisma.ItemWhereInput = { ...itemWhere(p), stockBalances: { some: { quantity: { not: 0 } } } };
  const warehouses = await db.warehouse.findMany({
    where: { OR: [{ active: true }, { balances: { some: { quantity: { not: 0 } } } }], ...(p.warehouse ? { id: p.warehouse } : {}) },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    select: { id: true, name: true, code: true },
  });
  const [items, total, perWarehouse] = await Promise.all([
    db.item.findMany({ where, orderBy: { name: "asc" }, skip: pg.skip, take: pg.take, select: { id: true, name: true, sku: true, unit: true } }),
    db.item.count({ where }),
    db.stockBalance.groupBy({ by: ["warehouseId"], where: { item: where }, _sum: { quantity: true, value: true } }),
  ]);
  const cells = await db.stockBalance.groupBy({ by: ["itemId", "warehouseId"], where: { itemId: { in: items.map((i) => i.id) } }, _sum: { quantity: true, value: true } });
  const shown = new Set(warehouses.map((w) => w.id));
  const rows: ReportRow[] = items.map((i) => {
    const mine = cells.filter((c) => c.itemId === i.id && shown.has(c.warehouseId));
    return {
      id: i.id,
      cells: {
        item: itemCell(i),
        unit: i.unit,
        ...Object.fromEntries(warehouses.map((w) => [`w_${w.id}`, round3(n(mine.find((c) => c.warehouseId === w.id)?._sum.quantity))])),
        quantity: round3(mine.reduce((t, c) => t + n(c._sum.quantity), 0)),
        value: round2(mine.reduce((t, c) => t + n(c._sum.value), 0)),
      },
    };
  });
  const shownTotals = perWarehouse.filter((w) => shown.has(w.warehouseId));
  return base("warehouses", pg, {
    columns: [
      { key: "item", label: "Item" },
      { key: "unit", label: "Unit" },
      ...warehouses.map((w): ReportColumn => ({ key: `w_${w.id}`, label: w.name, kind: "qty" })),
      { key: "quantity", label: "Total", kind: "qty" },
      { key: "value", label: "Value", kind: "money" },
    ],
    rows,
    totals: {
      ...Object.fromEntries(warehouses.map((w) => [`w_${w.id}`, round3(n(perWarehouse.find((x) => x.warehouseId === w.id)?._sum.quantity))])),
      quantity: round3(shownTotals.reduce((t, w) => t + n(w._sum.quantity), 0)),
      value: round2(shownTotals.reduce((t, w) => t + n(w._sum.value), 0)),
    },
    total,
    unit: "items",
  });
}

// The item stock ledger: one item's movements with a running balance, from an opening figure.
async function itemLedger(p: StockReportParams, pg: Paging): Promise<ReportTable> {
  if (!p.item) {
    const q = p.q?.trim();
    const items = await db.item.findMany({
      where: itemWhere(p),
      orderBy: { name: "asc" },
      take: q ? 50 : 25,
      select: { id: true, name: true, sku: true, unit: true, stockQuantity: true },
    });
    return base("ledger", pg, {
      subtitle: "Pick an item",
      columns: [
        { key: "item", label: "Item" },
        { key: "unit", label: "Unit" },
        { key: "onHand", label: "On hand", kind: "qty" },
      ],
      rows: items.map((i) => ({
        id: i.id,
        cells: { item: { text: i.name, href: `/items/stock-reports?report=ledger&item=${i.id}`, sub: i.sku }, unit: i.unit, onHand: round3(n(i.stockQuantity)) },
      })),
      total: items.length,
      unit: "items",
      notes: ["Choose an item to see every movement of it, with the balance after each. Search to narrow the list."],
    });
  }
  const item = await db.item.findUnique({ where: { id: p.item }, select: { id: true, name: true, sku: true, unit: true } });
  if (!item) throw new ReportInputError("That item no longer exists.");
  const from = dateParam(p.from);
  const to = dateParam(p.to);
  const scope: Prisma.StockMovementWhereInput = { itemId: item.id, ...(p.warehouse ? { warehouseId: p.warehouse } : {}) };
  const range = momentRange(from, to);
  const inRange: Prisma.StockMovementWhereInput = { ...scope, ...(range ? { movementDate: range } : {}) };
  const order: Prisma.StockMovementOrderByWithRelationInput[] = [{ movementDate: "asc" }, { createdAt: "asc" }, { id: "asc" }];
  const openingStart = range?.gte;
  const [opening, total, ins, outs, earlier, rows] = await Promise.all([
    openingStart ? db.stockMovement.aggregate({ where: { ...scope, movementDate: { lt: openingStart } }, _sum: { quantityChange: true, value: true } }) : null,
    db.stockMovement.count({ where: inRange }),
    db.stockMovement.aggregate({ where: { ...inRange, quantityChange: { gt: 0 } }, _sum: { quantityChange: true, value: true } }),
    db.stockMovement.aggregate({ where: { ...inRange, quantityChange: { lt: 0 } }, _sum: { quantityChange: true, value: true } }),
    pg.skip > 0 ? db.stockMovement.findMany({ where: inRange, orderBy: order, take: pg.skip, select: { quantityChange: true, value: true } }) : [],
    db.stockMovement.findMany({
      where: inRange,
      orderBy: order,
      skip: pg.skip,
      take: pg.take,
      select: {
        id: true, type: true, quantityChange: true, value: true, unitCost: true, movementDate: true, reason: true, sourceType: true,
        warehouse: { select: { name: true } }, batch: { select: { batchNo: true } },
        stockDocument: { select: { id: true, number: true } }, tradeDocument: { select: { id: true, docNumber: true } },
      },
    }),
  ]);
  const openQty = toMilli(n(opening?._sum.quantityChange));
  const openValue = toPaise(n(opening?._sum.value));
  let qty = openQty + earlier.reduce((t, m) => t + toMilli(n(m.quantityChange)), 0);
  let value = openValue + earlier.reduce((t, m) => t + toPaise(n(m.value)), 0);
  const out: ReportRow[] = [];
  if (pg.page === 1) {
    out.push({ id: "opening", tone: "muted", cells: { date: from, type: "Opening balance", balanceQty: fromMilli(openQty), balanceValue: fromPaise(openValue) } });
  }
  for (const m of rows) {
    const q = toMilli(n(m.quantityChange));
    const v = toPaise(n(m.value));
    qty += q;
    value += v;
    out.push({
      id: m.id,
      cells: {
        date: day(m.movementDate),
        type: movementLabel[m.type],
        voucher: voucherCell(m),
        warehouse: m.warehouse?.name ?? null,
        batch: m.batch?.batchNo ?? null,
        inQty: q > 0 ? fromMilli(q) : null,
        outQty: q < 0 ? fromMilli(-q) : null,
        balanceQty: fromMilli(qty),
        unitCost: m.unitCost === null ? null : n(m.unitCost),
        inValue: v > 0 ? fromPaise(v) : null,
        outValue: v < 0 ? fromPaise(-v) : null,
        balanceValue: fromPaise(value),
      },
    });
  }
  const closingQty = openQty + toMilli(n(ins._sum.quantityChange)) + toMilli(n(outs._sum.quantityChange));
  const closingValue = openValue + toPaise(n(ins._sum.value)) + toPaise(n(outs._sum.value));
  return {
    key: "ledger",
    title: `Stock ledger — ${item.name}`,
    subtitle: `${periodLabel(from, to)}${item.unit ? ` · in ${item.unit}` : ""}`,
    page: pg.page,
    pageSize: pg.pageSize,
    columns: [
      { key: "date", label: "Date", kind: "date" },
      { key: "type", label: "Movement" },
      { key: "voucher", label: "Voucher" },
      { key: "warehouse", label: "Warehouse" },
      { key: "batch", label: "Batch" },
      { key: "inQty", label: "In", kind: "qty" },
      { key: "outQty", label: "Out", kind: "qty" },
      { key: "balanceQty", label: "Balance", kind: "qty" },
      { key: "unitCost", label: "Unit cost", kind: "cost" },
      { key: "inValue", label: "Value in", kind: "money" },
      { key: "outValue", label: "Value out", kind: "money" },
      { key: "balanceValue", label: "Balance value", kind: "money" },
    ],
    rows: out,
    totals: {
      inQty: round3(n(ins._sum.quantityChange)),
      outQty: round3(-n(outs._sum.quantityChange)),
      balanceQty: fromMilli(closingQty),
      inValue: round2(n(ins._sum.value)),
      outValue: round2(-n(outs._sum.value)),
      balanceValue: fromPaise(closingValue),
    },
    total,
    unit: "movements",
  };
}

// The movement register.
async function movements(p: StockReportParams, pg: Paging): Promise<ReportTable> {
  const from = dateParam(p.from);
  const to = dateParam(p.to);
  const range = momentRange(from, to);
  const q = p.q?.trim();
  const where: Prisma.StockMovementWhereInput = {
    ...(MOVEMENT_TYPES.includes(p.type as StockMovementType) ? { type: p.type as StockMovementType } : {}),
    ...(SOURCE_TYPES.includes(p.source as StockSourceType) ? { sourceType: p.source as StockSourceType } : {}),
    ...(p.warehouse ? { warehouseId: p.warehouse } : {}),
    ...(p.item ? { itemId: p.item } : {}),
    ...(range ? { movementDate: range } : {}),
    ...(q ? { item: { OR: [{ name: { contains: q, mode: "insensitive" } }, { sku: { contains: q, mode: "insensitive" } }] } } : {}),
  };
  const [rows, total, ins, outs] = await Promise.all([
    db.stockMovement.findMany({
      where,
      orderBy: [{ movementDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      skip: pg.skip,
      take: pg.take,
      select: {
        id: true, type: true, quantityChange: true, value: true, unitCost: true, movementDate: true, reason: true, sourceType: true, reversesId: true,
        item: { select: { id: true, name: true, sku: true } }, warehouse: { select: { name: true } }, batch: { select: { batchNo: true } },
        stockDocument: { select: { id: true, number: true } }, tradeDocument: { select: { id: true, docNumber: true } },
        createdBy: { select: { name: true } },
      },
    }),
    db.stockMovement.count({ where }),
    db.stockMovement.aggregate({ where: { ...where, quantityChange: { gt: 0 } }, _sum: { quantityChange: true, value: true } }),
    db.stockMovement.aggregate({ where: { ...where, quantityChange: { lt: 0 } }, _sum: { quantityChange: true, value: true } }),
  ]);
  return base("movements", pg, {
    subtitle: periodLabel(from, to),
    columns: [
      { key: "date", label: "Date", kind: "date" },
      { key: "item", label: "Item" },
      { key: "type", label: "Movement" },
      { key: "voucher", label: "Voucher" },
      { key: "warehouse", label: "Warehouse" },
      { key: "batch", label: "Batch" },
      { key: "inQty", label: "In", kind: "qty" },
      { key: "outQty", label: "Out", kind: "qty" },
      { key: "value", label: "Value", kind: "money" },
      { key: "by", label: "By" },
    ],
    rows: rows.map((m) => {
      const q = n(m.quantityChange);
      return {
        id: m.id,
        tone: m.reversesId ? "muted" : undefined,
        cells: {
          date: day(m.movementDate),
          item: itemCell(m.item),
          type: `${movementLabel[m.type]}${m.reversesId ? " (reversal)" : ""}`,
          voucher: voucherCell(m),
          warehouse: m.warehouse?.name ?? null,
          batch: m.batch?.batchNo ?? null,
          inQty: q > 0 ? q : null,
          outQty: q < 0 ? -q : null,
          value: m.value === null ? null : n(m.value),
          by: m.createdBy?.name ?? null,
        },
      };
    }),
    totals: {
      inQty: round3(n(ins._sum.quantityChange)),
      outQty: round3(-n(outs._sum.quantityChange)),
      value: round2(n(ins._sum.value) + n(outs._sum.value)),
    },
    total,
    unit: "movements",
    notes: ["Value is signed: what came in at cost is positive, what went out negative."],
  });
}

// Transfers between warehouses: in transit, received, cancelled.
async function transfers(p: StockReportParams, pg: Paging): Promise<ReportTable> {
  const from = dateParam(p.from);
  const to = dateParam(p.to);
  const range = calendarDayRange(from, to);
  const where: Prisma.StockDocumentWhereInput = {
    type: "TRANSFER",
    ...(TRANSFER_STATUSES.includes(p.status as StockDocumentStatus) ? { status: p.status as StockDocumentStatus } : {}),
    ...(p.warehouse ? { OR: [{ warehouseId: p.warehouse }, { toWarehouseId: p.warehouse }] } : {}),
    ...(range ? { date: range } : {}),
  };
  const [docs, total, everyId] = await Promise.all([
    db.stockDocument.findMany({
      where,
      orderBy: [{ date: "desc" }, { number: "desc" }],
      skip: pg.skip,
      take: pg.take,
      select: {
        id: true, number: true, date: true, status: true, dispatchedAt: true, receivedAt: true,
        warehouse: { select: { name: true } }, toWarehouse: { select: { name: true } }, _count: { select: { lines: true } },
      },
    }),
    db.stockDocument.count({ where }),
    db.stockDocument.findMany({ where, select: { id: true } }),
  ]);
  const ids = docs.map((d) => d.id);
  const [qtys, values, allQty, allValue] = await Promise.all([
    db.stockDocumentLine.groupBy({ by: ["stockDocumentId"], where: { stockDocumentId: { in: ids } }, _sum: { quantity: true } }),
    db.stockMovement.groupBy({ by: ["stockDocumentId"], where: { stockDocumentId: { in: ids }, type: "TRANSFER_OUT" }, _sum: { value: true } }),
    db.stockDocumentLine.aggregate({ where: { stockDocumentId: { in: everyId.map((d) => d.id) } }, _sum: { quantity: true } }),
    db.stockMovement.aggregate({ where: { stockDocumentId: { in: everyId.map((d) => d.id) }, type: "TRANSFER_OUT" }, _sum: { value: true } }),
  ]);
  return base("transfers", pg, {
    subtitle: periodLabel(from, to),
    columns: [
      { key: "date", label: "Date", kind: "date" },
      { key: "number", label: "Transfer" },
      { key: "from", label: "From" },
      { key: "to", label: "To" },
      { key: "status", label: "Status" },
      { key: "dispatched", label: "Sent", kind: "date" },
      { key: "received", label: "Received", kind: "date" },
      { key: "lines", label: "Lines", kind: "int" },
      { key: "quantity", label: "Quantity", kind: "qty" },
      { key: "value", label: "Value", kind: "money" },
    ],
    rows: docs.map((d) => ({
      id: d.id,
      tone: d.status === "IN_TRANSIT" ? "warning" : d.status === "CANCELLED" ? "muted" : undefined,
      cells: {
        date: calDay(d.date),
        number: { text: d.number, href: `/items/stock/${d.id}` },
        from: d.warehouse.name,
        to: d.toWarehouse?.name ?? null,
        status: transferLabel[d.status],
        dispatched: day(d.dispatchedAt),
        received: day(d.receivedAt),
        lines: d._count.lines,
        quantity: round3(n(qtys.find((x) => x.stockDocumentId === d.id)?._sum.quantity)),
        value: round2(-n(values.find((x) => x.stockDocumentId === d.id)?._sum.value)),
      },
    })),
    totals: { quantity: round3(n(allQty._sum.quantity)), value: round2(-n(allValue._sum.value)) },
    total,
    unit: "transfers",
    notes: ["Value is what left the sending warehouse at cost, net of any reversal; a cancelled transfer nets to nothing."],
  });
}

/** Today, as a `@db.Date` column holds a day. */
function todayAsDate() {
  return new Date(`${indiaClock.today()}T00:00:00.000Z`);
}

// Batches with stock, soonest to expire first.
async function batches(p: StockReportParams, pg: Paging): Promise<ReportTable> {
  const today = todayAsDate();
  const q = p.q?.trim();
  const within = Number(p.expiry);
  const expiry: Prisma.DateTimeNullableFilter | undefined =
    p.expiry === "expired" ? { lt: today } : Number.isFinite(within) && within > 0 ? { gte: today, lte: new Date(today.getTime() + within * 86_400_000) } : undefined;
  const where: Prisma.StockBalanceWhereInput = {
    batchId: { not: null },
    quantity: { gt: 0 },
    ...(p.warehouse ? { warehouseId: p.warehouse } : {}),
    ...(q || expiry
      ? {
          batch: {
            ...(expiry ? { expiryDate: expiry } : {}),
            ...(q ? { OR: [{ batchNo: { contains: q, mode: "insensitive" } }, { item: { name: { contains: q, mode: "insensitive" } } }, { item: { sku: { contains: q, mode: "insensitive" } } }] } : {}),
          },
        }
      : {}),
  };
  const [rows, total, totals] = await Promise.all([
    db.stockBalance.findMany({
      where,
      orderBy: [{ batch: { expiryDate: { sort: "asc", nulls: "last" } } }, { item: { name: "asc" } }],
      skip: pg.skip,
      take: pg.take,
      select: {
        id: true, quantity: true, value: true,
        item: { select: { id: true, name: true, sku: true } },
        warehouse: { select: { name: true } },
        batch: { select: { batchNo: true, mfgDate: true, expiryDate: true } },
      },
    }),
    db.stockBalance.count({ where }),
    db.stockBalance.aggregate({ where, _sum: { quantity: true, value: true } }),
  ]);
  return base("batches", pg, {
    subtitle: p.expiry === "expired" ? "Expired, still in stock" : Number.isFinite(within) && within > 0 ? `Expiring within ${within} days` : "Every batch in stock",
    columns: [
      { key: "item", label: "Item" },
      { key: "batch", label: "Batch" },
      { key: "mfg", label: "Made", kind: "date" },
      { key: "expiry", label: "Expires", kind: "date" },
      { key: "daysLeft", label: "Days left", kind: "days" },
      { key: "warehouse", label: "Warehouse" },
      { key: "quantity", label: "Quantity", kind: "qty" },
      { key: "value", label: "Value", kind: "money" },
      { key: "status", label: "Status" },
    ],
    rows: rows.map((r) => {
      const exp = r.batch?.expiryDate ?? null;
      const left = exp ? Math.round((exp.getTime() - today.getTime()) / 86_400_000) : null;
      const status = left === null ? "No expiry" : left < 0 ? "Expired" : left <= 30 ? "Expiring soon" : "";
      return {
        id: r.id,
        tone: left !== null && left < 0 ? "danger" : left !== null && left <= 30 ? "warning" : undefined,
        cells: {
          item: itemCell(r.item),
          batch: r.batch?.batchNo ?? null,
          mfg: calDay(r.batch?.mfgDate),
          expiry: calDay(exp),
          daysLeft: left,
          warehouse: r.warehouse.name,
          quantity: round3(n(r.quantity)),
          value: round2(n(r.value)),
          status,
        },
      };
    }),
    totals: { quantity: round3(n(totals._sum.quantity)), value: round2(n(totals._sum.value)) },
    total,
    unit: "batches",
  });
}

// Serial numbers: where each is, and when it came and went.
async function serials(p: StockReportParams, pg: Paging): Promise<ReportTable> {
  const q = p.q?.trim();
  const where: Prisma.ItemSerialWhereInput = {
    ...(SERIAL_STATUSES.includes(p.status as SerialStatus) ? { status: p.status as SerialStatus } : {}),
    ...(p.warehouse ? { warehouseId: p.warehouse } : {}),
    ...(p.item ? { itemId: p.item } : {}),
    ...(q ? { OR: [{ serialNo: { contains: q, mode: "insensitive" } }, { item: { name: { contains: q, mode: "insensitive" } } }] } : {}),
  };
  const [rows, total, byStatus] = await Promise.all([
    db.itemSerial.findMany({
      where,
      orderBy: [{ item: { name: "asc" } }, { serialNo: "asc" }],
      skip: pg.skip,
      take: pg.take,
      select: {
        id: true, serialNo: true, status: true, inMovementId: true, outMovementId: true,
        item: { select: { id: true, name: true, sku: true } }, warehouse: { select: { name: true } }, batch: { select: { batchNo: true } },
      },
    }),
    db.itemSerial.count({ where }),
    db.itemSerial.groupBy({ by: ["status"], where, _count: { _all: true } }),
  ]);
  const movementIds = rows.flatMap((r) => [r.inMovementId, r.outMovementId]).filter((x): x is string => !!x);
  const moves = movementIds.length
    ? await db.stockMovement.findMany({
        where: { id: { in: movementIds } },
        select: { id: true, movementDate: true, sourceType: true, reason: true, stockDocument: { select: { id: true, number: true } }, tradeDocument: { select: { id: true, docNumber: true } } },
      })
    : [];
  const move = (id: string | null) => (id ? moves.find((m) => m.id === id) : undefined);
  return base("serials", pg, {
    columns: [
      { key: "serial", label: "Serial / IMEI" },
      { key: "item", label: "Item" },
      { key: "status", label: "Status" },
      { key: "warehouse", label: "Warehouse" },
      { key: "batch", label: "Batch" },
      { key: "inDate", label: "Came in", kind: "date" },
      { key: "inVoucher", label: "On" },
      { key: "outDate", label: "Went out", kind: "date" },
      { key: "outVoucher", label: "On" },
    ],
    rows: rows.map((r) => {
      const i = move(r.inMovementId);
      const o = r.status === "IN_STOCK" ? undefined : move(r.outMovementId);
      return {
        id: r.id,
        tone: r.status === "SCRAPPED" ? "muted" : undefined,
        cells: {
          serial: r.serialNo,
          item: itemCell(r.item),
          status: serialLabel[r.status],
          warehouse: r.warehouse?.name ?? null,
          batch: r.batch?.batchNo ?? null,
          inDate: day(i?.movementDate),
          inVoucher: i ? voucherCell(i) : null,
          outDate: day(o?.movementDate),
          outVoucher: o ? voucherCell(o) : null,
        },
      };
    }),
    totals: null,
    total,
    unit: "serials",
    notes: [SERIAL_STATUSES.map((s) => `${serialLabel[s]}: ${byStatus.find((b) => b.status === s)?._count._all ?? 0}`).join(" · ")],
  });
}

// Low stock: at or below the reorder level, with what to order.
async function reorder(p: StockReportParams, pg: Paging): Promise<ReportTable> {
  const items = await db.item.findMany({
    where: { ...itemWhere(p), active: true, reorderLevel: { not: null } },
    orderBy: { name: "asc" },
    select: { id: true, name: true, sku: true, unit: true, reorderLevel: true, reorderQuantity: true, stockQuantity: true, costPrice: true },
  });
  const ids = items.map((i) => i.id);
  const [balances, reserved] = await Promise.all([
    db.stockBalance.groupBy({ by: ["itemId"], where: { itemId: { in: ids }, ...(p.warehouse ? { warehouseId: p.warehouse } : {}) }, _sum: { quantity: true, value: true } }),
    db.stockReservation.groupBy({ by: ["itemId"], where: { itemId: { in: ids }, status: "ACTIVE", ...(p.warehouse ? { warehouseId: p.warehouse } : {}) }, _sum: { quantity: true } }),
  ]);
  const low = items
    .map((i) => {
      const b = balances.find((x) => x.itemId === i.id);
      const onHand = p.warehouse ? round3(n(b?._sum.quantity)) : round3(n(i.stockQuantity));
      const held = round3(n(reserved.find((x) => x.itemId === i.id)?._sum.quantity));
      const level = n(i.reorderLevel);
      const suggested = i.reorderQuantity !== null ? round3(n(i.reorderQuantity)) : round3(Math.max(0, level - onHand + held));
      const avgCost = avg(round3(n(b?._sum.quantity)), round2(n(b?._sum.value)));
      const cost = avgCost ?? (i.costPrice === null ? null : n(i.costPrice));
      return { i, onHand, held, available: round3(onHand - held), level, suggested, cost, estimate: cost === null ? null : round2(suggested * cost) };
    })
    .filter((r) => r.onHand <= r.level)
    .sort((a, b) => b.level - b.onHand - (a.level - a.onHand) || a.i.name.localeCompare(b.i.name));
  return base("reorder", pg, {
    subtitle: p.warehouse ? "One warehouse" : "Every warehouse",
    columns: [
      { key: "item", label: "Item" },
      { key: "unit", label: "Unit" },
      { key: "onHand", label: "On hand", kind: "qty" },
      { key: "reserved", label: "Reserved", kind: "qty" },
      { key: "available", label: "Available", kind: "qty" },
      { key: "reorderLevel", label: "Reorder level", kind: "qty" },
      { key: "suggested", label: "Order", kind: "qty" },
      { key: "cost", label: "Last cost", kind: "cost" },
      { key: "estimate", label: "Estimated cost", kind: "money" },
    ],
    rows: slice(low, pg).map((r) => ({
      id: r.i.id,
      tone: r.onHand <= 0 ? "danger" : "warning",
      cells: { item: itemCell(r.i), unit: r.i.unit, onHand: r.onHand, reserved: r.held, available: r.available, reorderLevel: r.level, suggested: r.suggested, cost: r.cost, estimate: r.estimate },
    })),
    totals: { estimate: round2(low.reduce((t, r) => t + (r.estimate ?? 0), 0)) },
    total: low.length,
    unit: "items",
    notes: ["What to order is the item's reorder quantity, or else enough to bring it back to its reorder level after what orders hold."],
  });
}

// Physical count variance: what the count found against what the books said.
async function variance(p: StockReportParams, pg: Paging): Promise<ReportTable> {
  const from = dateParam(p.from);
  const to = dateParam(p.to);
  const range = calendarDayRange(from, to);
  const q = p.q?.trim();
  const docWhere: Prisma.StockDocumentWhereInput = { type: "PHYSICAL_COUNT", status: "POSTED", ...(range ? { date: range } : {}), ...(p.warehouse ? { warehouseId: p.warehouse } : {}) };
  const where: Prisma.StockDocumentLineWhereInput = {
    stockDocument: docWhere,
    ...(q ? { item: { OR: [{ name: { contains: q, mode: "insensitive" } }, { sku: { contains: q, mode: "insensitive" } }] } } : {}),
  };
  const [lines, total, valueAll] = await Promise.all([
    db.stockDocumentLine.findMany({
      where,
      orderBy: [{ stockDocument: { date: "desc" } }, { stockDocument: { number: "desc" } }, { sortOrder: "asc" }],
      skip: pg.skip,
      take: pg.take,
      select: {
        id: true, itemId: true, batchId: true, systemQty: true, countedQty: true, quantity: true,
        item: { select: { id: true, name: true, sku: true } }, batch: { select: { batchNo: true } },
        stockDocument: { select: { id: true, number: true, date: true, warehouse: { select: { name: true } } } },
      },
    }),
    db.stockDocumentLine.count({ where }),
    db.stockMovement.aggregate({ where: { stockDocument: docWhere, reversesId: null, ...(q ? { item: { OR: [{ name: { contains: q, mode: "insensitive" } }, { sku: { contains: q, mode: "insensitive" } }] } } : {}) }, _sum: { value: true } }),
  ]);
  const docIds = [...new Set(lines.map((l) => l.stockDocument.id))];
  const moved = docIds.length
    ? await db.stockMovement.groupBy({ by: ["stockDocumentId", "itemId", "batchId"], where: { stockDocumentId: { in: docIds }, reversesId: null }, _sum: { value: true } })
    : [];
  return base("variance", pg, {
    subtitle: periodLabel(from, to),
    columns: [
      { key: "date", label: "Date", kind: "date" },
      { key: "voucher", label: "Count" },
      { key: "warehouse", label: "Warehouse" },
      { key: "item", label: "Item" },
      { key: "batch", label: "Batch" },
      { key: "system", label: "Books said", kind: "qty" },
      { key: "counted", label: "Counted", kind: "qty" },
      { key: "difference", label: "Difference", kind: "qty" },
      { key: "value", label: "Value", kind: "money" },
    ],
    rows: lines.map((l) => {
      const system = l.systemQty === null ? null : round3(n(l.systemQty));
      const counted = l.countedQty === null ? null : round3(n(l.countedQty));
      const diff = system !== null && counted !== null ? round3(counted - system) : round3(n(l.quantity));
      const v = moved.find((m) => m.stockDocumentId === l.stockDocument.id && m.itemId === l.itemId && (m.batchId ?? null) === (l.batchId ?? null));
      return {
        id: l.id,
        tone: diff < 0 ? "danger" : diff > 0 ? "warning" : undefined,
        cells: {
          date: calDay(l.stockDocument.date),
          voucher: { text: l.stockDocument.number, href: `/items/stock/${l.stockDocument.id}` },
          warehouse: l.stockDocument.warehouse.name,
          item: itemCell(l.item),
          batch: l.batch?.batchNo ?? null,
          system,
          counted,
          difference: diff,
          value: round2(n(v?._sum.value)),
        },
      };
    }),
    totals: { value: round2(n(valueAll._sum.value)) },
    total,
    unit: "lines",
    notes: ["A shortage is negative and written off at cost; an excess is taken in at the item's cost. Only posted counts."],
  });
}

// Valuation as of a date: every movement up to it, at the value it was booked at.
async function valuation(p: StockReportParams, pg: Paging): Promise<ReportTable> {
  const asOf = dateParam(p.asOf) ?? indiaClock.today();
  const end = indiaClock.endOfDay(asOf)!;
  const groups = await db.stockMovement.groupBy({
    by: ["itemId"],
    where: { movementDate: { lt: end }, item: itemWhere(p), ...(p.warehouse ? { warehouseId: p.warehouse } : {}) },
    _sum: { quantityChange: true, value: true },
  });
  const live = groups.filter((g) => n(g._sum.quantityChange) !== 0 || n(g._sum.value) !== 0);
  const items = await db.item.findMany({ where: { id: { in: live.map((g) => g.itemId) } }, select: { id: true, name: true, sku: true, unit: true } });
  const rows = live
    .map((g) => ({ item: items.find((i) => i.id === g.itemId)!, qty: round3(n(g._sum.quantityChange)), value: round2(n(g._sum.value)) }))
    .filter((r) => r.item)
    .sort((a, b) => a.item.name.localeCompare(b.item.name));
  const totalValue = fromPaise(rows.reduce((t, r) => t + toPaise(r.value), 0));
  return base("valuation", pg, {
    subtitle: `As of ${indiaClock.date(indiaClock.startOfDay(asOf)!)}${p.warehouse ? " · one warehouse" : ""}`,
    columns: [
      { key: "item", label: "Item" },
      { key: "unit", label: "Unit" },
      { key: "quantity", label: "Quantity", kind: "qty" },
      { key: "avgCost", label: "Average cost", kind: "cost" },
      { key: "value", label: "Value", kind: "money" },
    ],
    rows: slice(rows, pg).map((r) => ({
      id: r.item.id,
      tone: r.qty < 0 ? "danger" : undefined,
      cells: { item: itemCell(r.item), unit: r.item.unit, quantity: r.qty, avgCost: avg(r.qty, r.value), value: r.value },
    })),
    totals: { value: totalValue },
    total: rows.length,
    unit: "items",
    notes: ["The sum of every movement dated on or before the day, each at the value it was booked at — today's figure is the stock balances' own."],
  });
}

// Aging: what's left of each receipt, by how long ago it came in.
async function aging(p: StockReportParams, pg: Paging): Promise<ReportTable> {
  const now = new Date();
  const layers = await db.stockCostLayer.findMany({
    where: { remaining: { gt: 0 }, item: itemWhere(p), ...(p.warehouse ? { warehouseId: p.warehouse } : {}) },
    select: { itemId: true, receivedAt: true, remaining: true, unitCost: true, item: { select: { id: true, name: true, sku: true, unit: true } } },
  });
  type Row = { item: { id: string; name: string; sku: string; unit: string | null }; qtyMilli: number; paise: number; buckets: Record<string, number> };
  const byItem = new Map<string, Row>();
  const bucketTotals: Record<string, number> = Object.fromEntries(AGING_BUCKETS.map((b) => [b.key, 0]));
  for (const l of layers) {
    const qtyMilli = toMilli(n(l.remaining));
    const paise = valuePaise(qtyMilli, toCost4(n(l.unitCost)));
    const bucket = agingBucketOf(ageInDays(l.receivedAt, now));
    const row = byItem.get(l.itemId) ?? { item: l.item, qtyMilli: 0, paise: 0, buckets: Object.fromEntries(AGING_BUCKETS.map((b) => [b.key, 0])) };
    row.qtyMilli += qtyMilli;
    row.paise += paise;
    row.buckets[bucket]! += paise;
    bucketTotals[bucket]! += paise;
    byItem.set(l.itemId, row);
  }
  const rows = [...byItem.values()].sort((a, b) => a.item.name.localeCompare(b.item.name));
  return base("aging", pg, {
    subtitle: `As of ${indiaClock.date(now)}`,
    columns: [
      { key: "item", label: "Item" },
      { key: "quantity", label: "Quantity", kind: "qty" },
      { key: "value", label: "Value", kind: "money" },
      ...AGING_BUCKETS.map((b): ReportColumn => ({ key: `b_${b.key}`, label: b.label, kind: "money" })),
    ],
    rows: slice(rows, pg).map((r) => ({
      id: r.item.id,
      cells: { item: itemCell(r.item), quantity: fromMilli(r.qtyMilli), value: fromPaise(r.paise), ...Object.fromEntries(AGING_BUCKETS.map((b) => [`b_${b.key}`, fromPaise(r.buckets[b.key]!)])) },
    })),
    totals: {
      value: fromPaise(rows.reduce((t, r) => t + r.paise, 0)),
      ...Object.fromEntries(AGING_BUCKETS.map((b) => [`b_${b.key}`, fromPaise(bucketTotals[b.key]!)])),
    },
    total: rows.length,
    unit: "items",
    notes: ["Each receipt's remaining quantity at what it cost, by how long ago it came in (first in, first out). Under weighted-average costing the stock's value is the average, so this can differ from the summary's value."],
  });
}

// Slow-moving and dead stock: on hand, nothing sold or used for a while.
async function slow(p: StockReportParams, pg: Paging): Promise<ReportTable> {
  const days = Math.max(1, Math.min(3650, Math.floor(Number(p.days) || 90)));
  const now = new Date();
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const items = await db.item.findMany({ where: { ...itemWhere(p), stockQuantity: { gt: 0 } }, select: { id: true, name: true, sku: true, unit: true, stockQuantity: true } });
  const ids = items.map((i) => i.id);
  const [outs, ins, values] = await Promise.all([
    db.stockMovement.groupBy({ by: ["itemId"], where: { itemId: { in: ids }, quantityChange: { lt: 0 }, type: { not: "TRANSFER_OUT" }, reversesId: null }, _max: { movementDate: true } }),
    db.stockMovement.groupBy({ by: ["itemId"], where: { itemId: { in: ids }, quantityChange: { gt: 0 }, type: { not: "TRANSFER_IN" }, reversesId: null }, _max: { movementDate: true } }),
    db.stockBalance.groupBy({ by: ["itemId"], where: { itemId: { in: ids } }, _sum: { quantity: true, value: true } }),
  ]);
  const rows = items
    .map((i) => {
      const lastOut = outs.find((o) => o.itemId === i.id)?._max.movementDate ?? null;
      const lastIn = ins.find((o) => o.itemId === i.id)?._max.movementDate ?? null;
      const since = lastOut ?? lastIn;
      const idle = since ? indiaClock.daysBetween(since, now) : null;
      const b = values.find((v) => v.itemId === i.id);
      return { i, lastOut, lastIn, idle, qty: round3(n(b?._sum.quantity ?? i.stockQuantity)), value: round2(n(b?._sum.value)) };
    })
    .filter((r) => !r.lastOut || r.lastOut < cutoff)
    .sort((a, b) => (b.idle ?? Infinity) - (a.idle ?? Infinity) || b.value - a.value);
  return base("slow", pg, {
    subtitle: `Nothing out in ${days} days`,
    columns: [
      { key: "item", label: "Item" },
      { key: "unit", label: "Unit" },
      { key: "onHand", label: "On hand", kind: "qty" },
      { key: "value", label: "Value", kind: "money" },
      { key: "lastIn", label: "Last in", kind: "date" },
      { key: "lastOut", label: "Last out", kind: "date" },
      { key: "idle", label: "Days idle", kind: "days" },
      { key: "status", label: "Status" },
    ],
    rows: slice(rows, pg).map((r) => ({
      id: r.i.id,
      tone: r.lastOut ? "warning" : "danger",
      cells: {
        item: itemCell(r.i),
        unit: r.i.unit,
        onHand: r.qty,
        value: r.value,
        lastIn: day(r.lastIn),
        lastOut: day(r.lastOut),
        idle: r.idle,
        status: r.lastOut ? "Slow-moving" : "Never gone out",
      },
    })),
    totals: { value: round2(rows.reduce((t, r) => t + r.value, 0)) },
    total: rows.length,
    unit: "items",
    notes: ["Going out means sold, used, written off or returned — a transfer between warehouses isn't, and neither is a reversal."],
  });
}

// Item profitability: what each item sold for, less what it cost.
async function profitability(p: StockReportParams, pg: Paging): Promise<ReportTable> {
  const fy = financialYearBounds(new Date());
  const from = dateParam(p.from) ?? fy.from;
  const to = dateParam(p.to) ?? indiaClock.today();
  const range = momentRange(from, to)!;
  const itemFilter = itemWhere(p);
  const [lines, costs] = await Promise.all([
    db.tradeDocumentLine.findMany({
      where: {
        itemId: { not: null },
        item: itemFilter,
        document: { docType: { in: ["INVOICE", "CREDIT_NOTE"] }, status: { notIn: ["DRAFT", "CANCELLED", "EXPIRED", "REJECTED"] }, issueDate: range },
      },
      select: { itemId: true, quantity: true, taxableValue: true, document: { select: { docType: true, currency: true, exchangeRate: true } } },
    }),
    db.stockMovement.groupBy({
      by: ["itemId"],
      where: { type: { in: ["SOLD", "RETURNED"] }, sourceType: { in: ["SALES_INVOICE", "CREDIT_NOTE"] }, movementDate: range, item: itemFilter },
      _sum: { value: true },
    }),
  ]);
  const acc = new Map<string, { qtyMilli: number; salesPaise: number; cogsPaise: number }>();
  const slot = (id: string) => acc.get(id) ?? acc.set(id, { qtyMilli: 0, salesPaise: 0, cogsPaise: 0 }).get(id)!;
  for (const l of lines) {
    const sign = l.document.docType === "CREDIT_NOTE" ? -1 : 1;
    const s = slot(l.itemId!);
    s.qtyMilli += sign * toMilli(n(l.quantity));
    s.salesPaise += sign * toPaise(n(l.taxableValue) * bookingRate(l.document));
  }
  for (const c of costs) slot(c.itemId).cogsPaise += -toPaise(n(c._sum.value));
  const items = await db.item.findMany({ where: { id: { in: [...acc.keys()] } }, select: { id: true, name: true, sku: true, unit: true } });
  const rows = [...acc.entries()]
    .map(([id, s]) => ({ item: items.find((i) => i.id === id)!, ...s, marginPaise: s.salesPaise - s.cogsPaise }))
    .filter((r) => r.item)
    .sort((a, b) => b.salesPaise - a.salesPaise || a.item.name.localeCompare(b.item.name));
  const sum = (k: "salesPaise" | "cogsPaise" | "marginPaise") => rows.reduce((t, r) => t + r[k], 0);
  const pct = (margin: number, sales: number) => (sales !== 0 ? Math.round((margin / sales) * 1000) / 10 : null);
  return base("profitability", pg, {
    subtitle: periodLabel(from, to),
    columns: [
      { key: "item", label: "Item" },
      { key: "unit", label: "Unit" },
      { key: "quantity", label: "Sold", kind: "qty" },
      { key: "sales", label: "Sales", kind: "money" },
      { key: "cogs", label: "Cost of goods sold", kind: "money" },
      { key: "margin", label: "Margin", kind: "money" },
      { key: "marginPct", label: "Margin %", kind: "int" },
    ],
    rows: slice(rows, pg).map((r) => ({
      id: r.item.id,
      tone: r.marginPaise < 0 ? "danger" : undefined,
      cells: {
        item: itemCell(r.item),
        unit: r.item.unit,
        quantity: fromMilli(r.qtyMilli),
        sales: fromPaise(r.salesPaise),
        cogs: fromPaise(r.cogsPaise),
        margin: fromPaise(r.marginPaise),
        marginPct: pct(r.marginPaise, r.salesPaise),
      },
    })),
    totals: { sales: fromPaise(sum("salesPaise")), cogs: fromPaise(sum("cogsPaise")), margin: fromPaise(sum("marginPaise")), marginPct: pct(sum("marginPaise"), sum("salesPaise")) },
    total: rows.length,
    unit: "items",
    notes: [
      "Sales are invoices' taxable values in rupees, less credit notes. Cost of goods sold is what those invoices took out of stock, at cost, less what credit notes put back.",
      "Cost appears only where invoices issue stock (Accounts settings); otherwise the margin is the whole sale.",
    ],
  });
}

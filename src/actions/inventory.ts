"use server";

import { revalidatePath } from "next/cache";
import type { Prisma, StockDocumentStatus, StockDocumentType } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { toPlain } from "@/lib/serialize";
import { notMigratedYet } from "@/lib/not-migrated";
import { round3, toMilli } from "@/lib/accounts/money";
import { accountsSettings } from "@/lib/accounts/settings";
import { nextAccountsNumber } from "@/lib/accounts/numbering";
import { StockError } from "@/lib/inventory/engine";
import {
  cancelStockDocument as cancelInLedger,
  needsApproval,
  postApprovedStockDocument,
  postStockDocument as postInLedger,
  receiveTransfer,
  stockDocumentLabels,
} from "@/lib/inventory/stock-documents";
import { workspaceClock } from "@/lib/time/workspace";
import type { ActionResult } from "@/actions/company";

/**
 * Inventory, under Finance → Accounts (owner, 22 Oct 2026): warehouses, units, how items are tracked, and the
 * stock vouchers — goods receipts, transfers, adjustments, physical counts and purchase returns.
 *
 * Every action asks the plan for Items & Inventory, then its own permission:
 *   · reading anything is `inventory.view`;
 *   · a goods receipt is `inventory.receive`; a transfer, `inventory.transfer`;
 *   · an adjustment, a count or a return to a vendor, `inventory.adjust` — and, where Accounts settings ask
 *     for it, approval by somebody else holding `inventory.approveAdjustments`;
 *   · warehouses, units and item tracking, `inventory.manage`.
 * Stock itself only ever changes through src/lib/inventory, inside one transaction per voucher.
 */

async function caps() {
  const user = await requireModuleUser("items");
  const [view, receive, transfer, adjust, approve, manage, configure] = await Promise.all([
    hasEffectivePermission(user.id, "inventory.view"),
    hasEffectivePermission(user.id, "inventory.receive"),
    hasEffectivePermission(user.id, "inventory.transfer"),
    hasEffectivePermission(user.id, "inventory.adjust"),
    hasEffectivePermission(user.id, "inventory.approveAdjustments"),
    hasEffectivePermission(user.id, "inventory.manage"),
    hasEffectivePermission(user.id, "accounts.configure"),
  ]);
  return { user, view: view || receive || transfer || adjust || manage, receive, transfer, adjust, approve, manage, configure };
}

/** What the inventory screens may show and do for this person, and whether the workspace is ready for them. */
export async function inventoryCapabilities() {
  const c = await caps();
  const settings = await accountsSettings();
  return {
    view: c.view, receive: c.receive, transfer: c.transfer, adjust: c.adjust, approve: c.approve, manage: c.manage, configure: c.configure,
    migrated: settings.migrated,
    settings: {
      inventoryAccounting: settings.inventoryAccounting,
      costingMethod: settings.costingMethod,
      allowNegativeStock: settings.allowNegativeStock,
      adjustmentApprovalRequired: settings.adjustmentApprovalRequired,
      quantityDecimals: settings.quantityDecimals,
    },
  };
}

const permissionFor: Record<StockDocumentType, "receive" | "transfer" | "adjust"> = {
  GRN: "receive",
  TRANSFER: "transfer",
  ADJUSTMENT: "adjust",
  PHYSICAL_COUNT: "adjust",
  PURCHASE_RETURN: "adjust",
};
const refusal: Record<"receive" | "transfer" | "adjust", string> = {
  receive: "Goods receipts need “Receive stock”.",
  transfer: "Transfers need “Transfer stock”.",
  adjust: "Adjustments, counts and returns need “Adjust stock”.",
};

function message(err: unknown, fallback: string) {
  if (err instanceof StockError) return err.message;
  if (notMigratedYet(err)) return "This workspace's database hasn't been brought up to date for inventory yet.";
  if (err instanceof Error && err.message && !/prisma|invalid `/i.test(err.message)) return err.message;
  return fallback;
}

// ─── Warehouses ──────────────────────────────────────────────────────────────────────────────────

export async function listWarehouses(options: { includeClosed?: boolean } = {}) {
  const c = await caps();
  if (!c.view) return [];
  try {
    const rows = await db.warehouse.findMany({
      where: options.includeClosed ? {} : { active: true },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
      select: { id: true, code: true, name: true, address: true, isDefault: true, active: true, branch: { select: { id: true, name: true } } },
    });
    const totals = await db.stockBalance.groupBy({ by: ["warehouseId"], _sum: { quantity: true, value: true } });
    return toPlain(
      rows.map((w) => {
        const t = totals.find((x) => x.warehouseId === w.id);
        return { ...w, quantity: Number(t?._sum.quantity ?? 0), value: Number(t?._sum.value ?? 0) };
      }),
    );
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

export async function saveWarehouse(input: { id?: string; code: string; name: string; branchId?: string | null; address?: string | null; isDefault?: boolean; active?: boolean }): Promise<ActionResult<{ id: string }>> {
  const c = await caps();
  if (!c.manage) return { ok: false, error: "Warehouses are set up with “Set up inventory”." };
  const code = (input.code ?? "").trim().toUpperCase();
  const name = (input.name ?? "").trim();
  if (!/^[A-Z0-9_-]{1,12}$/.test(code)) return { ok: false, error: "A code is up to 12 letters, digits, dashes or underscores — MAIN, GODOWN-2." };
  if (!name || name.length > 80) return { ok: false, error: "Name the warehouse, in under 80 characters." };
  try {
    const saved = await db.$transaction(async (tx) => {
      const clash = await tx.warehouse.findFirst({ where: { code, ...(input.id ? { id: { not: input.id } } : {}) }, select: { name: true } });
      if (clash) throw new StockError(`${clash.name} already uses the code ${code}.`);
      if (input.id && input.active === false) {
        const held = await tx.stockBalance.aggregate({ where: { warehouseId: input.id }, _sum: { quantity: true } });
        if (Number(held._sum.quantity ?? 0) !== 0) throw new StockError("There's stock in this warehouse — transfer it out before closing it.");
      }
      const data = { code, name, branchId: input.branchId || null, address: input.address?.trim() || null, isDefault: !!input.isDefault, active: input.active ?? true };
      // One default at a time.
      if (data.isDefault) await tx.warehouse.updateMany({ where: { isDefault: true, ...(input.id ? { id: { not: input.id } } : {}) }, data: { isDefault: false } });
      return input.id ? tx.warehouse.update({ where: { id: input.id }, data, select: { id: true } }) : tx.warehouse.create({ data, select: { id: true } });
    });
    await recordAudit({ userId: c.user.id, action: input.id ? "UPDATE" : "CREATE", entityType: "Warehouse", entityId: saved.id, entityLabel: `Warehouse ${code} — ${name}` });
    revalidatePath("/items/warehouses");
    return { ok: true, data: saved };
  } catch (err) {
    return { ok: false, error: message(err, "Could not save the warehouse.") };
  }
}

// ─── Units of measure ────────────────────────────────────────────────────────────────────────────

export async function listUnits() {
  const c = await caps();
  if (!c.view) return [];
  try {
    return toPlain(await db.unitOfMeasure.findMany({ orderBy: { code: "asc" } }));
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

export async function saveUnit(input: { id?: string; code: string; name: string; decimals: number; active?: boolean }): Promise<ActionResult<{ id: string }>> {
  const c = await caps();
  if (!c.manage) return { ok: false, error: "Units are set up with “Set up inventory”." };
  const code = (input.code ?? "").trim().toUpperCase();
  const name = (input.name ?? "").trim();
  const decimals = Math.floor(Number(input.decimals));
  if (!/^[A-Z0-9]{1,8}$/.test(code)) return { ok: false, error: "A unit's code is up to 8 letters or digits — KGS, BOX." };
  if (!name) return { ok: false, error: "Name the unit." };
  if (!(decimals >= 0 && decimals <= 3)) return { ok: false, error: "Decimals are 0 to 3." };
  try {
    const clash = await db.unitOfMeasure.findFirst({ where: { code, ...(input.id ? { id: { not: input.id } } : {}) }, select: { id: true } });
    if (clash) return { ok: false, error: `There's already a unit ${code}.` };
    const data = { code, name, decimals, active: input.active ?? true };
    const saved = input.id
      ? await db.unitOfMeasure.update({ where: { id: input.id }, data, select: { id: true } })
      : await db.unitOfMeasure.create({ data, select: { id: true } });
    await recordAudit({ userId: c.user.id, action: input.id ? "UPDATE" : "CREATE", entityType: "UnitOfMeasure", entityId: saved.id, entityLabel: `Unit ${code} — ${name}` });
    revalidatePath("/items/units");
    return { ok: true, data: saved };
  } catch (err) {
    return { ok: false, error: message(err, "Could not save the unit.") };
  }
}

// ─── How an item is tracked ──────────────────────────────────────────────────────────────────────

export async function itemInventory(itemId: string) {
  const c = await caps();
  if (!c.view) return null;
  try {
    const item = await db.item.findUnique({
      where: { id: itemId },
      select: {
        id: true, name: true, unit: true, type: true, trackInventory: true, reorderLevel: true, stockQuantity: true,
        trackBatches: true, trackExpiry: true, trackSerials: true, barcode: true, reorderQuantity: true,
        unitConversions: { orderBy: { unit: "asc" }, select: { id: true, unit: true, factor: true } },
      },
    });
    if (!item) return null;
    const [balances, reservations, serials, movements] = await Promise.all([
      db.stockBalance.findMany({
        where: { itemId, quantity: { not: 0 } },
        orderBy: [{ warehouse: { name: "asc" } }],
        select: { quantity: true, value: true, warehouse: { select: { id: true, name: true, code: true } }, batch: { select: { id: true, batchNo: true, expiryDate: true } } },
      }),
      db.stockReservation.findMany({ where: { itemId, status: "ACTIVE" }, select: { quantity: true, sourceType: true, sourceId: true, note: true, warehouse: { select: { name: true } } } }),
      item.trackSerials ? db.itemSerial.findMany({ where: { itemId, status: "IN_STOCK" }, orderBy: { serialNo: "asc" }, take: 200, select: { serialNo: true, warehouse: { select: { name: true } }, batch: { select: { batchNo: true } } } }) : Promise.resolve([]),
      db.stockMovement.findMany({
        where: { itemId },
        orderBy: [{ movementDate: "desc" }, { createdAt: "desc" }],
        take: 50,
        select: {
          id: true, type: true, quantityChange: true, reason: true, movementDate: true, createdAt: true, unitCost: true, value: true, sourceType: true,
          serialNumbers: true, warehouse: { select: { name: true } }, batch: { select: { batchNo: true } }, createdBy: { select: { name: true } },
          tradeDocument: { select: { id: true, docNumber: true } }, stockDocument: { select: { id: true, number: true, type: true } }, reversesId: true,
        },
      }),
    ]);
    return toPlain({ item, balances, reservations, serials, movements, canManage: c.manage, canAdjust: c.adjust, canReceive: c.receive });
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

export async function setItemTracking(itemId: string, input: { trackBatches: boolean; trackExpiry: boolean; trackSerials: boolean; barcode?: string | null; reorderQuantity?: number | null }): Promise<ActionResult<null>> {
  const c = await caps();
  if (!c.manage) return { ok: false, error: "How an item is tracked is set with “Set up inventory”." };
  const item = await db.item.findUnique({ where: { id: itemId }, select: { name: true, type: true, trackInventory: true, trackBatches: true, trackSerials: true, trackExpiry: true, stockQuantity: true } });
  if (!item) return { ok: false, error: "That item no longer exists." };
  if (item.type !== "GOOD" || !item.trackInventory) return { ok: false, error: "Only goods that keep stock can keep batches or serial numbers." };
  if (input.trackExpiry && !input.trackBatches) return { ok: false, error: "Expiry dates are kept per batch — keep batches too." };
  const turningOn = (input.trackBatches && !item.trackBatches) || (input.trackSerials && !item.trackSerials);
  const turningOff = (!input.trackBatches && item.trackBatches) || (!input.trackSerials && item.trackSerials);
  if ((turningOn || turningOff) && Number(item.stockQuantity) !== 0) {
    return { ok: false, error: `${item.name} has stock on hand — batches and serial numbers can only be switched on or off with none, so every unit has them or none does. Count it out to nothing, change this, and take it back in with them.` };
  }
  const barcode = input.barcode?.trim() || null;
  if (barcode && barcode.length > 64) return { ok: false, error: "A barcode is up to 64 characters." };
  const reorderQuantity = input.reorderQuantity == null || String(input.reorderQuantity) === "" ? null : round3(input.reorderQuantity);
  if (reorderQuantity != null && !(reorderQuantity > 0)) return { ok: false, error: "A reorder quantity is more than nothing." };
  try {
    await db.item.update({ where: { id: itemId }, data: { trackBatches: input.trackBatches, trackExpiry: input.trackExpiry, trackSerials: input.trackSerials, barcode, reorderQuantity } });
  } catch (err) {
    return { ok: false, error: message(err, "Could not save how the item is tracked.") };
  }
  await recordAudit({
    userId: c.user.id, action: "UPDATE", entityType: "Item", entityId: itemId,
    entityLabel: `${item.name}: ${[input.trackBatches && "batches", input.trackExpiry && "expiry", input.trackSerials && "serials"].filter(Boolean).join(", ") || "no batch or serial tracking"}`,
  });
  revalidatePath(`/items/${itemId}`);
  return { ok: true, data: null };
}

export async function saveItemUnit(itemId: string, unit: string, factor: number): Promise<ActionResult<null>> {
  const c = await caps();
  if (!c.manage) return { ok: false, error: "An item's units are set with “Set up inventory”." };
  const code = unit.trim().toUpperCase();
  const f = Number(factor);
  if (!code) return { ok: false, error: "Name the unit." };
  if (!(f > 0) || f > 1_000_000) return { ok: false, error: "How many of the base unit one holds — more than nothing." };
  const item = await db.item.findUnique({ where: { id: itemId }, select: { unit: true, name: true } });
  if (!item) return { ok: false, error: "That item no longer exists." };
  if (item.unit && item.unit.trim().toUpperCase() === code) return { ok: false, error: `${code} is ${item.name}'s own unit.` };
  try {
    await db.itemUnit.upsert({ where: { itemId_unit: { itemId, unit: code } }, create: { itemId, unit: code, factor: f }, update: { factor: f } });
  } catch (err) {
    return { ok: false, error: message(err, "Could not save the unit.") };
  }
  await recordAudit({ userId: c.user.id, action: "UPDATE", entityType: "Item", entityId: itemId, entityLabel: `${item.name}: 1 ${code} = ${f} ${item.unit ?? "units"}` });
  revalidatePath(`/items/${itemId}`);
  return { ok: true, data: null };
}

export async function deleteItemUnit(id: string): Promise<ActionResult<null>> {
  const c = await caps();
  if (!c.manage) return { ok: false, error: "An item's units are set with “Set up inventory”." };
  const row = await db.itemUnit.findUnique({ where: { id }, select: { itemId: true, unit: true } });
  if (!row) return { ok: true, data: null };
  await db.itemUnit.delete({ where: { id } });
  await recordAudit({ userId: c.user.id, action: "DELETE", entityType: "Item", entityId: row.itemId, entityLabel: `Unit ${row.unit} removed` });
  revalidatePath(`/items/${row.itemId}`);
  return { ok: true, data: null };
}

// ─── Stock vouchers ──────────────────────────────────────────────────────────────────────────────

export type StockDocumentFilters = { type?: string; status?: string; warehouseId?: string; from?: string; to?: string; search?: string; page?: number; pageSize?: number };

const TYPES = ["GRN", "TRANSFER", "ADJUSTMENT", "PHYSICAL_COUNT", "PURCHASE_RETURN"] as const;
const STATUSES = ["DRAFT", "PENDING_APPROVAL", "IN_TRANSIT", "POSTED", "CANCELLED"] as const;

export async function listStockDocuments(filters: StockDocumentFilters = {}) {
  const c = await caps();
  if (!c.view) return null;
  const pageSize = Math.min(100, Math.max(10, Number(filters.pageSize) || 25));
  const page = Math.max(1, Math.floor(Number(filters.page) || 1));
  const where: Prisma.StockDocumentWhereInput = {
    ...((TYPES as readonly string[]).includes(filters.type ?? "") ? { type: filters.type as StockDocumentType } : {}),
    ...((STATUSES as readonly string[]).includes(filters.status ?? "") ? { status: filters.status as StockDocumentStatus } : {}),
    ...(filters.warehouseId ? { OR: [{ warehouseId: filters.warehouseId }, { toWarehouseId: filters.warehouseId }] } : {}),
    ...(filters.from || filters.to ? { date: { ...(filters.from ? { gte: new Date(filters.from) } : {}), ...(filters.to ? { lte: new Date(filters.to) } : {}) } } : {}),
    ...(filters.search?.trim()
      ? { AND: [{ OR: [{ number: { contains: filters.search.trim(), mode: "insensitive" } }, { reference: { contains: filters.search.trim(), mode: "insensitive" } }, { reason: { contains: filters.search.trim(), mode: "insensitive" } }] }] }
      : {}),
  };
  try {
    const [rows, total, pending] = await Promise.all([
      db.stockDocument.findMany({
        where,
        orderBy: [{ date: "desc" }, { number: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true, type: true, number: true, date: true, status: true, reference: true, reason: true,
          warehouse: { select: { name: true } }, toWarehouse: { select: { name: true } }, company: { select: { id: true, name: true } },
          purchaseOrder: { select: { id: true, docNumber: true } }, createdBy: { select: { name: true } },
          _count: { select: { lines: true } },
        },
      }),
      db.stockDocument.count({ where }),
      db.stockDocument.count({ where: { status: "PENDING_APPROVAL", ...((TYPES as readonly string[]).includes(filters.type ?? "") ? { type: filters.type as StockDocumentType } : {}) } }),
    ]);
    return toPlain({ rows, total, page, pageSize, pending });
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

export async function getStockDocument(id: string) {
  const c = await caps();
  if (!c.view) return null;
  const doc = await db.stockDocument.findUnique({
    where: { id },
    include: {
      warehouse: { select: { id: true, name: true } },
      toWarehouse: { select: { id: true, name: true } },
      company: { select: { id: true, name: true } },
      purchaseOrder: { select: { id: true, docNumber: true } },
      bill: { select: { id: true, docNumber: true } },
      createdBy: { select: { id: true, name: true } },
      lines: { orderBy: { sortOrder: "asc" }, include: { item: { select: { id: true, name: true, sku: true, unit: true, trackBatches: true, trackExpiry: true, trackSerials: true } }, batch: { select: { batchNo: true, expiryDate: true } } } },
      movements: {
        orderBy: { createdAt: "asc" },
        select: { id: true, type: true, quantityChange: true, value: true, item: { select: { name: true } }, warehouse: { select: { name: true } }, batch: { select: { batchNo: true } }, reversesId: true },
      },
      journalEntries: { select: { id: true, entryNumber: true, reversesId: true } },
    },
  });
  if (!doc) return null;
  const ids = [doc.submittedById, doc.approvedById, doc.postedById, doc.cancelledById].filter((x): x is string => !!x);
  const people = ids.length ? await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  const name = (id: string | null) => people.find((p) => p.id === id)?.name ?? null;
  const settings = await accountsSettings();
  return toPlain({
    ...doc,
    submittedBy: name(doc.submittedById),
    approvedBy: name(doc.approvedById),
    postedBy: name(doc.postedById),
    cancelledBy: name(doc.cancelledById),
    needsApproval: needsApproval(doc.type, settings),
    can: {
      edit: c[permissionFor[doc.type]] && doc.status === "DRAFT",
      post: c[permissionFor[doc.type]],
      approve: c.approve && doc.createdById !== c.user.id,
      cancel: c[permissionFor[doc.type]] && (doc.status === "DRAFT" || doc.status === "PENDING_APPROVAL" || c.adjust),
    },
  });
}

/**
 * The stock voucher beside this one in its list (BUSY's Page Up / Page Down, src/lib/shortcuts/busy.ts): the
 * list shows the newest first (date, then number, descending), so "previous" — Page Up — is the one above it,
 * newer, and "next" the one below, older. Only of the same kind, as the list a voucher was opened from shows.
 */
export async function adjacentStockDocument(id: string, direction: "previous" | "next"): Promise<{ id: string; number: string } | null> {
  const c = await caps();
  if (!c.view) return null;
  const doc = await db.stockDocument.findUnique({ where: { id }, select: { type: true, date: true, number: true } });
  if (!doc) return null;
  const newer = direction === "previous";
  return db.stockDocument.findFirst({
    where: {
      type: doc.type,
      id: { not: id },
      OR: newer
        ? [{ date: { gt: doc.date } }, { date: doc.date, number: { gt: doc.number } }]
        : [{ date: { lt: doc.date } }, { date: doc.date, number: { lt: doc.number } }],
    },
    orderBy: newer ? [{ date: "asc" }, { number: "asc" }] : [{ date: "desc" }, { number: "desc" }],
    select: { id: true, number: true },
  });
}

/**
 * What a stock voucher pasted from the copy one (BUSY's Alt + F12) needs to show: its items, if they are still
 * goods that keep stock, and its vendor's name.
 */
export async function stockPasteContext(input: { itemIds: string[]; companyId: string | null }) {
  const c = await caps();
  if (!c.view) return { items: [], company: null };
  const ids = [...new Set((input.itemIds ?? []).filter((x) => typeof x === "string"))].slice(0, 200);
  const [items, company] = await Promise.all([
    ids.length
      ? db.item.findMany({
          where: { id: { in: ids }, type: "GOOD", trackInventory: true, active: true },
          select: { id: true, name: true, sku: true, unit: true, costPrice: true, trackBatches: true, trackExpiry: true, trackSerials: true },
        })
      : Promise.resolve([]),
    input.companyId ? db.company.findUnique({ where: { id: input.companyId }, select: { id: true, name: true } }) : Promise.resolve(null),
  ]);
  return toPlain({ items, company });
}

export type StockDocumentLineInput = {
  itemId: string;
  quantity?: number | string | null;
  orderedQty?: number | string | null;
  rejectedQty?: number | string | null;
  countedQty?: number | string | null;
  unitCost?: number | string | null;
  poLineId?: string | null;
  batchId?: string | null;
  batchNo?: string | null;
  mfgDate?: string | null;
  expiryDate?: string | null;
  serialNumbers?: string[] | string | null;
  note?: string | null;
};

export type SaveStockDocumentInput = {
  id?: string;
  type: StockDocumentType;
  date: string;
  warehouseId: string;
  toWarehouseId?: string | null;
  companyId?: string | null;
  purchaseOrderId?: string | null;
  billId?: string | null;
  reference?: string | null;
  reason?: string | null;
  notes?: string | null;
  lines: StockDocumentLineInput[];
  requestId?: string;
};

const num = (v: unknown) => (v == null || String(v).trim() === "" ? null : round3(Number(v)));
const day = (v: string | null | undefined) => (v ? new Date(`${v.slice(0, 10)}T00:00:00.000Z`) : null);
const serialList = (v: string[] | string | null | undefined) =>
  (Array.isArray(v) ? v : String(v ?? "").split(/[\s,;]+/)).map((s) => s.trim()).filter(Boolean);

/** Writes or rewrites a draft stock voucher. Checks everything posting would, so a draft that saves will post. */
export async function saveStockDocument(input: SaveStockDocumentInput): Promise<ActionResult<{ id: string; number: string }>> {
  const c = await caps();
  if (!(TYPES as readonly string[]).includes(input.type)) return { ok: false, error: "Choose the kind of stock voucher." };
  const need = permissionFor[input.type];
  if (!c[need]) return { ok: false, error: refusal[need] };
  const settings = await accountsSettings();
  if (!settings.migrated) return { ok: false, error: "This workspace's database hasn't been brought up to date for inventory yet." };

  const date = day(input.date);
  if (!date || Number.isNaN(date.getTime())) return { ok: false, error: "Pick the date." };
  if (input.date.slice(0, 10) > (await workspaceClock()).today()) return { ok: false, error: "Stock can't move on a day that hasn't come yet." };
  const reason = input.reason?.trim() || null;
  if ((input.type === "ADJUSTMENT" || input.type === "PURCHASE_RETURN") && !reason) return { ok: false, error: "Say why — every stock correction keeps its reason." };
  const warehouse = await db.warehouse.findUnique({ where: { id: input.warehouseId }, select: { id: true, active: true, name: true } });
  if (!warehouse) return { ok: false, error: "Choose the warehouse." };
  if (input.type === "TRANSFER") {
    if (!input.toWarehouseId || input.toWarehouseId === input.warehouseId) return { ok: false, error: "A transfer goes to a different warehouse." };
    const to = await db.warehouse.findUnique({ where: { id: input.toWarehouseId }, select: { active: true, name: true } });
    if (!to?.active) return { ok: false, error: "The warehouse it goes to is closed." };
  }
  if ((input.type === "GRN" || input.type === "PURCHASE_RETURN") && !input.companyId && !input.purchaseOrderId) {
    return { ok: false, error: "Choose the vendor, or the purchase order it's against." };
  }
  let companyId = input.companyId || null;
  if (input.purchaseOrderId) {
    const po = await db.tradeDocument.findUnique({ where: { id: input.purchaseOrderId }, select: { docType: true, companyId: true, status: true } });
    if (!po || po.docType !== "PURCHASE_ORDER") return { ok: false, error: "That isn't a purchase order." };
    if (po.status === "DRAFT" || po.status === "CANCELLED") return { ok: false, error: "Receive against an issued purchase order." };
    companyId = po.companyId;
  }
  if (input.billId) {
    const bill = await db.tradeDocument.findUnique({ where: { id: input.billId }, select: { docType: true } });
    if (!bill || bill.docType !== "BILL") return { ok: false, error: "That isn't a vendor bill." };
  }

  const raw = (input.lines ?? []).filter((l) => l.itemId);
  if (raw.length === 0) return { ok: false, error: "Add at least one item." };
  if (raw.length > 200) return { ok: false, error: "Up to 200 lines on one voucher." };
  const items = await db.item.findMany({
    where: { id: { in: raw.map((l) => l.itemId) } },
    select: { id: true, name: true, type: true, trackInventory: true, trackBatches: true, trackExpiry: true, trackSerials: true, unit: true },
  });
  const lines: Prisma.StockDocumentLineCreateWithoutStockDocumentInput[] = [];
  for (const [i, l] of raw.entries()) {
    const item = items.find((x) => x.id === l.itemId);
    const n = `Line ${i + 1}`;
    if (!item) return { ok: false, error: `${n}: that item no longer exists.` };
    if (item.type !== "GOOD" || !item.trackInventory) return { ok: false, error: `${n}: ${item.name} doesn't keep stock.` };
    const serials = serialList(l.serialNumbers);
    let quantity = num(l.quantity) ?? 0;
    const counted = num(l.countedQty);
    const rejected = num(l.rejectedQty);
    if (input.type === "GRN") {
      const received = quantity + (rejected ?? 0);
      if (!(quantity >= 0) || !(received > 0)) return { ok: false, error: `${n}: how many of ${item.name} came in, and how many were accepted.` };
      if (rejected != null && rejected < 0) return { ok: false, error: `${n}: rejected can't be negative.` };
    } else if (input.type === "ADJUSTMENT") {
      if (quantity === 0) return { ok: false, error: `${n}: by how much — more found is positive, missing or written off is negative.` };
    } else if (input.type === "PHYSICAL_COUNT") {
      if (counted == null || counted < 0) return { ok: false, error: `${n}: how many of ${item.name} were counted.` };
      quantity = 0;
    } else if (!(quantity > 0)) {
      return { ok: false, error: `${n}: how many of ${item.name}.` };
    }
    const incoming = input.type === "GRN" || (input.type === "ADJUSTMENT" && quantity > 0);
    if (item.trackSerials && input.type !== "PHYSICAL_COUNT") {
      const units = Math.abs(quantity);
      if (toMilli(units) % 1000 !== 0) return { ok: false, error: `${n}: ${item.name} keeps serial numbers, so it moves in whole units.` };
      if (serials.length !== units) return { ok: false, error: `${n}: give ${item.name}'s ${units} serial number(s) — ${serials.length} given.` };
    }
    if (item.trackBatches) {
      if (incoming && !l.batchNo?.trim() && !l.batchId) return { ok: false, error: `${n}: ${item.name} keeps batches — give the batch number.` };
      if (incoming && item.trackExpiry && !l.expiryDate && !l.batchId) {
        const known = l.batchNo ? await db.itemBatch.findUnique({ where: { itemId_batchNo: { itemId: item.id, batchNo: l.batchNo.trim() } }, select: { expiryDate: true } }) : null;
        if (!known?.expiryDate) return { ok: false, error: `${n}: ${item.name} keeps expiry dates — give the batch's expiry date.` };
      }
      if (input.type === "PHYSICAL_COUNT" && !l.batchId) return { ok: false, error: `${n}: ${item.name} keeps batches — count each batch on its own line.` };
    }
    const cost = num(l.unitCost);
    if (cost != null && cost < 0) return { ok: false, error: `${n}: a cost can't be negative.` };
    lines.push({
      item: { connect: { id: item.id } },
      sortOrder: i,
      quantity,
      orderedQty: num(l.orderedQty),
      receivedQty: input.type === "GRN" ? round3(quantity + (rejected ?? 0)) : null,
      rejectedQty: rejected,
      countedQty: counted,
      unitCost: cost,
      unit: item.unit,
      poLineId: l.poLineId || null,
      ...(l.batchId ? { batch: { connect: { id: l.batchId } } } : {}),
      batchNo: l.batchNo?.trim() || null,
      mfgDate: day(l.mfgDate ?? null),
      expiryDate: day(l.expiryDate ?? null),
      serialNumbers: serials,
      note: l.note?.trim().slice(0, 200) || null,
    });
  }

  const data = {
    date,
    warehouse: { connect: { id: warehouse.id } },
    toWarehouse: input.type === "TRANSFER" && input.toWarehouseId ? { connect: { id: input.toWarehouseId } } : undefined,
    company: companyId ? { connect: { id: companyId } } : undefined,
    purchaseOrder: input.purchaseOrderId ? { connect: { id: input.purchaseOrderId } } : undefined,
    bill: input.billId ? { connect: { id: input.billId } } : undefined,
    reference: input.reference?.trim().slice(0, 80) || null,
    reason: reason?.slice(0, 300) ?? null,
    notes: input.notes?.trim().slice(0, 1000) || null,
  };

  try {
    const saved = await db.$transaction(async (tx) => {
      if (input.id) {
        const existing = await tx.stockDocument.findUnique({ where: { id: input.id }, select: { status: true, type: true, number: true } });
        if (!existing) throw new StockError("That voucher no longer exists.");
        if (existing.status !== "DRAFT") throw new StockError("Only a draft can be changed.");
        if (existing.type !== input.type) throw new StockError("A voucher keeps its kind.");
        await tx.stockDocumentLine.deleteMany({ where: { stockDocumentId: input.id } });
        await tx.stockDocument.update({
          where: { id: input.id },
          data: {
            ...data,
            toWarehouse: data.toWarehouse ?? { disconnect: true },
            company: data.company ?? { disconnect: true },
            purchaseOrder: data.purchaseOrder ?? { disconnect: true },
            bill: data.bill ?? { disconnect: true },
            lines: { create: lines },
          },
        });
        return { id: input.id, number: existing.number, created: false };
      }
      const number = await nextAccountsNumber(tx, input.type, date, settings.seriesPrefixes);
      const created = await tx.stockDocument.create({
        data: { ...data, type: input.type, number, createdBy: { connect: { id: c.user.id } }, lines: { create: lines } },
        select: { id: true, number: true },
      });
      return { ...created, created: true };
    });
    await recordAudit({ userId: c.user.id, action: saved.created ? "CREATE" : "UPDATE", entityType: "StockDocument", entityId: saved.id, entityLabel: `${stockDocumentLabels[input.type]} ${saved.number} drafted` });
    revalidatePath("/items/stock");
    return { ok: true, data: { id: saved.id, number: saved.number } };
  } catch (err) {
    return { ok: false, error: message(err, "Could not save the voucher.") };
  }
}

/** Posts a stock voucher: receives, sends (a transfer), adjusts, counts or returns. */
export async function postStockDocument(id: string): Promise<ActionResult<{ moved: number }>> {
  const c = await caps();
  const doc = await db.stockDocument.findUnique({ where: { id }, select: { type: true, number: true } });
  if (!doc) return { ok: false, error: "That voucher no longer exists." };
  if (!c[permissionFor[doc.type]]) return { ok: false, error: refusal[permissionFor[doc.type]] };
  const settings = await accountsSettings();
  try {
    const moved = await db.$transaction((tx) => postInLedger(tx, id, c.user.id, settings), { timeout: 60_000 });
    await recordAudit({ userId: c.user.id, action: "UPDATE", entityType: "StockDocument", entityId: id, entityLabel: `${stockDocumentLabels[doc.type]} ${doc.number} ${doc.type === "TRANSFER" ? "sent" : "posted"} — ${moved.length} movement(s)` });
    revalidatePath("/items/stock");
    return { ok: true, data: { moved: moved.length } };
  } catch (err) {
    return { ok: false, error: message(err, "Could not post the voucher.") };
  }
}

/** Sends an adjustment or a count for approval. */
export async function submitStockDocument(id: string): Promise<ActionResult<null>> {
  const c = await caps();
  if (!c.adjust) return { ok: false, error: refusal.adjust };
  const settings = await accountsSettings();
  const doc = await db.stockDocument.findUnique({ where: { id }, select: { type: true, number: true, status: true } });
  if (!doc) return { ok: false, error: "That voucher no longer exists." };
  if (!needsApproval(doc.type, settings)) return { ok: false, error: "This doesn't need approving — post it." };
  const moved = await db.stockDocument.updateMany({ where: { id, status: "DRAFT" }, data: { status: "PENDING_APPROVAL", submittedById: c.user.id, submittedAt: new Date() } });
  if (moved.count === 0) return { ok: false, error: "Only a draft can be sent for approval." };
  await recordAudit({ userId: c.user.id, action: "UPDATE", entityType: "StockDocument", entityId: id, entityLabel: `${stockDocumentLabels[doc.type]} ${doc.number} sent for approval` });
  revalidatePath("/items/stock");
  return { ok: true, data: null };
}

/** Approves an adjustment or count somebody else wrote — and posts it, in the same transaction. */
export async function approveStockDocument(id: string): Promise<ActionResult<{ moved: number }>> {
  const c = await caps();
  if (!c.approve) return { ok: false, error: "Approving stock adjustments needs “Approve stock adjustments”." };
  const doc = await db.stockDocument.findUnique({ where: { id }, select: { type: true, number: true, status: true, createdById: true } });
  if (!doc) return { ok: false, error: "That voucher no longer exists." };
  if (doc.createdById === c.user.id) return { ok: false, error: "You can't approve your own adjustment — somebody else has to." };
  if (doc.status !== "PENDING_APPROVAL") return { ok: false, error: "Only a voucher waiting for approval can be approved." };
  const settings = await accountsSettings();
  try {
    const moved = await db.$transaction(async (tx) => {
      await tx.stockDocument.update({ where: { id }, data: { approvedById: c.user.id, approvedAt: new Date() } });
      return postApprovedStockDocument(tx, id, c.user.id, settings);
    }, { timeout: 60_000 });
    await recordAudit({ userId: c.user.id, action: "UPDATE", entityType: "StockDocument", entityId: id, entityLabel: `${stockDocumentLabels[doc.type]} ${doc.number} approved and posted — ${moved.length} movement(s)` });
    revalidatePath("/items/stock");
    return { ok: true, data: { moved: moved.length } };
  } catch (err) {
    return { ok: false, error: message(err, "Could not approve the voucher.") };
  }
}

/** Sends a voucher waiting for approval back to draft. */
export async function returnStockDocument(id: string, note?: string): Promise<ActionResult<null>> {
  const c = await caps();
  if (!c.approve) return { ok: false, error: "Sending adjustments back needs “Approve stock adjustments”." };
  const moved = await db.stockDocument.updateMany({ where: { id, status: "PENDING_APPROVAL" }, data: { status: "DRAFT", submittedById: null, submittedAt: null } });
  if (moved.count === 0) return { ok: false, error: "Only a voucher waiting for approval can be sent back." };
  await recordAudit({ userId: c.user.id, action: "UPDATE", entityType: "StockDocument", entityId: id, entityLabel: `Sent back to draft${note?.trim() ? `: ${note.trim()}` : ""}` });
  revalidatePath("/items/stock");
  return { ok: true, data: null };
}

/** A transfer in transit, received at its destination. */
export async function receiveStockTransfer(id: string): Promise<ActionResult<{ moved: number }>> {
  const c = await caps();
  if (!c.transfer) return { ok: false, error: refusal.transfer };
  const settings = await accountsSettings();
  const doc = await db.stockDocument.findUnique({ where: { id }, select: { number: true } });
  try {
    const moved = await db.$transaction((tx) => receiveTransfer(tx, id, c.user.id, settings, new Date()), { timeout: 60_000 });
    await recordAudit({ userId: c.user.id, action: "UPDATE", entityType: "StockDocument", entityId: id, entityLabel: `Stock transfer ${doc?.number ?? ""} received` });
    revalidatePath("/items/stock");
    return { ok: true, data: { moved: moved.length } };
  } catch (err) {
    return { ok: false, error: message(err, "Could not receive the transfer.") };
  }
}

/** Cancels a voucher: a draft simply stops; a posted one, or a transfer in transit, is reversed. */
export async function cancelStockDocument(id: string, reason: string): Promise<ActionResult<null>> {
  const c = await caps();
  const why = reason?.trim();
  if (!why) return { ok: false, error: "Say why it's being cancelled." };
  const doc = await db.stockDocument.findUnique({ where: { id }, select: { type: true, number: true, status: true } });
  if (!doc) return { ok: false, error: "That voucher no longer exists." };
  if (!c[permissionFor[doc.type]]) return { ok: false, error: refusal[permissionFor[doc.type]] };
  // Undoing stock that has moved is a correction, whatever moved it.
  if ((doc.status === "POSTED" || doc.status === "IN_TRANSIT") && !c.adjust) return { ok: false, error: "Reversing stock that has moved needs “Adjust stock”." };
  const settings = await accountsSettings();
  try {
    await db.$transaction((tx) => cancelInLedger(tx, id, c.user.id, why.slice(0, 300), settings), { timeout: 60_000 });
    await recordAudit({ userId: c.user.id, action: "UPDATE", entityType: "StockDocument", entityId: id, entityLabel: `${stockDocumentLabels[doc.type]} ${doc.number} cancelled: ${why}` });
    revalidatePath("/items/stock");
    return { ok: true, data: null };
  } catch (err) {
    return { ok: false, error: message(err, "Could not cancel the voucher.") };
  }
}

// ─── What the forms pick from ────────────────────────────────────────────────────────────────────

/** Goods that keep stock, matching `term`, for a voucher's lines. */
export async function searchStockItems(term: string) {
  const c = await caps();
  if (!c.view) return [];
  const q = term.trim();
  try {
    return toPlain(
      await db.item.findMany({
        where: {
          type: "GOOD",
          trackInventory: true,
          active: true,
          ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { sku: { contains: q, mode: "insensitive" } }, { barcode: { contains: q } }] } : {}),
        },
        orderBy: { name: "asc" },
        take: 20,
        select: { id: true, name: true, sku: true, unit: true, costPrice: true, trackBatches: true, trackExpiry: true, trackSerials: true },
      }),
    );
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

/** An item's batches with stock in a warehouse, soonest to expire first. */
export async function batchesOnHand(itemId: string, warehouseId: string) {
  const c = await caps();
  if (!c.view) return [];
  const rows = await db.stockBalance.findMany({
    where: { itemId, warehouseId, batchId: { not: null }, quantity: { gt: 0 } },
    select: { quantity: true, batch: { select: { id: true, batchNo: true, expiryDate: true } } },
  });
  return toPlain(
    rows
      .filter((r) => r.batch)
      .map((r) => ({ id: r.batch!.id, batchNo: r.batch!.batchNo, expiryDate: r.batch!.expiryDate, quantity: Number(r.quantity) }))
      .sort((a, b) => (a.expiryDate?.getTime() ?? Infinity) - (b.expiryDate?.getTime() ?? Infinity)),
  );
}

/** What a warehouse holds, item by item (and batch by batch), for a count sheet. */
export async function countSheet(warehouseId: string) {
  const c = await caps();
  if (!c.adjust) return [];
  const rows = await db.stockBalance.findMany({
    where: { warehouseId, item: { active: true, trackInventory: true } },
    orderBy: [{ item: { name: "asc" } }],
    select: { quantity: true, item: { select: { id: true, name: true, sku: true, unit: true, trackBatches: true, trackExpiry: true, trackSerials: true } }, batch: { select: { id: true, batchNo: true } } },
  });
  return toPlain(
    rows.map((r) => ({
      itemId: r.item.id, name: r.item.name, sku: r.item.sku, unit: r.item.unit, trackBatches: r.item.trackBatches, trackExpiry: r.item.trackExpiry, trackSerials: r.item.trackSerials,
      batchId: r.batch?.id ?? null, batchNo: r.batch?.batchNo ?? null, systemQty: Number(r.quantity),
    })),
  );
}

/**
 * A purchase order's lines for a goods receipt: what was ordered, what earlier receipts accepted, and what is
 * still to come, at the order's price.
 */
export async function receiptLinesFromPurchaseOrder(purchaseOrderId: string) {
  const c = await caps();
  if (!c.receive) return null;
  const po = await db.tradeDocument.findUnique({
    where: { id: purchaseOrderId },
    select: {
      id: true, docNumber: true, docType: true, status: true, companyId: true, company: { select: { name: true } },
      lines: { orderBy: { sortOrder: "asc" }, select: { id: true, itemId: true, name: true, quantity: true, unitPrice: true, taxableValue: true, item: { select: { type: true, trackInventory: true, trackBatches: true, trackExpiry: true, trackSerials: true, unit: true, name: true } } } },
    },
  });
  if (!po || po.docType !== "PURCHASE_ORDER") return null;
  const earlier = await db.stockDocumentLine.groupBy({
    by: ["poLineId"],
    where: { stockDocument: { purchaseOrderId, type: "GRN", status: "POSTED" }, poLineId: { not: null } },
    _sum: { quantity: true },
  });
  return toPlain({
    id: po.id, docNumber: po.docNumber, status: po.status, companyId: po.companyId, companyName: po.company.name,
    lines: po.lines
      .filter((l) => l.itemId && l.item?.type === "GOOD" && l.item.trackInventory)
      .map((l) => {
        const ordered = Number(l.quantity);
        const received = Number(earlier.find((e) => e.poLineId === l.id)?._sum.quantity ?? 0);
        const qty = Number(l.quantity) || 1;
        return {
          poLineId: l.id, itemId: l.itemId!, name: l.item!.name, unit: l.item!.unit, ordered, received, pending: round3(Math.max(0, ordered - received)),
          unitCost: Math.round((Number(l.taxableValue) / qty) * 10000) / 10000,
          trackBatches: l.item!.trackBatches, trackExpiry: l.item!.trackExpiry, trackSerials: l.item!.trackSerials,
        };
      }),
  });
}

/** Issued purchase orders still open, for a receipt to be against. */
export async function openPurchaseOrders(term = "") {
  const c = await caps();
  if (!c.receive) return [];
  const q = term.trim();
  return toPlain(
    await db.tradeDocument.findMany({
      where: { docType: "PURCHASE_ORDER", status: { in: ["ISSUED", "ACCEPTED"] }, ...(q ? { OR: [{ docNumber: { contains: q, mode: "insensitive" } }, { company: { name: { contains: q, mode: "insensitive" } } }] } : {}) },
      orderBy: { issueDate: "desc" },
      take: 20,
      select: { id: true, docNumber: true, issueDate: true, company: { select: { id: true, name: true } } },
    }),
  );
}

/** Vendors, for a receipt or a return not against an order. */
export async function searchVendors(term: string) {
  const c = await caps();
  if (!c.view) return [];
  const q = term.trim();
  if (q.length < 2) return [];
  return db.company.findMany({ where: { name: { contains: q, mode: "insensitive" } }, orderBy: { name: "asc" }, take: 15, select: { id: true, name: true } });
}

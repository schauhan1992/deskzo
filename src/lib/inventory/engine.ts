import type { Prisma, SerialStatus, StockMovementType, StockSourceType } from "@prisma/client";
import { fromCost4, fromMilli, fromPaise, proportionPaise, toCost4, toMilli, toPaise, unitCost4, valuePaise } from "@/lib/accounts/money";
import type { AccountsSettings } from "@/lib/accounts/settings";
import { costIssue, type CostLayer } from "@/lib/inventory/costing";
import { pair, postInventoryEntry } from "@/lib/inventory/posting";

/**
 * The stock engine (owner, 22 Oct 2026): the one door every change to what is on hand goes through.
 *
 * `moveStock` runs inside the caller's transaction, so a sale's stock and its ledger entry commit together or
 * not at all, and it:
 *
 *   1. finds the movement already written when its idempotency key has been seen — a retried invoice or a
 *      double-clicked receipt moves the stock once;
 *   2. takes a lock on the item in that warehouse, so two sales of the last unit can't both succeed;
 *   3. refuses to take stock below nothing unless the company allows negative stock, counting what is
 *      reserved for other orders as gone;
 *   4. picks batches first-expiry-first-out where the item keeps batches and none was named, and checks
 *      serial numbers where it keeps those;
 *   5. costs the movement (src/lib/inventory/costing.ts), writes it, and moves the balance, the cost layers,
 *      the serials and the item's cached total by the same amount.
 *
 * Nothing here edits or deletes a movement: `reverseMovement` writes the opposite one.
 */

type Tx = Prisma.TransactionClient;

export class StockError extends Error {}

export type MoveStockInput = {
  itemId: string;
  warehouseId: string;
  /** Signed, in the item's base unit: positive comes in, negative goes out. */
  quantity: number;
  type: StockMovementType;
  sourceType: StockSourceType;
  sourceId?: string | null;
  sourceLineId?: string | null;
  tradeDocumentId?: string | null;
  stockDocumentId?: string | null;
  date: Date;
  userId: string;
  reason?: string | null;
  /** What makes this the one movement of its kind — "doc:<id>:line:<id>", "stockdoc:<id>:line:<id>". */
  idempotencyKey: string;
  /** For stock coming in: what one unit cost, in rupees. Left out, the current average or the cost price. */
  unitCost?: number | null;
  /** The movement's value at cost, in paise, positive — when it is already known: a transfer's arriving side, a return at its sale's cost. */
  valuePaise?: number | null;
  /** For an item that keeps batches: the batch coming in, or the one going out. Left out going out, picked first-expiry-first-out. */
  batch?: { batchNo: string; mfgDate?: Date | null; expiryDate?: Date | null } | null;
  batchId?: string | null;
  /** For an item that keeps serials: one per unit. Going out, they must be in stock in this warehouse. */
  serials?: string[];
  /** The reservation this issue fills, which doesn't count against it. */
  reservation?: { sourceType: string; sourceId: string } | null;
  /** Where a serial goes when it leaves: sold, back to the vendor, written off. */
  serialOutStatus?: SerialStatus;
  /** Expired batches are skipped when picking for a sale, and can still be written off by naming them. */
  skipExpired?: boolean;
  /** The movement this one undoes — taking a receipt back out draws on that receipt's own cost layer first. */
  reversesId?: string | null;
  /** Under perpetual inventory, a receipt that fills stock issued before it came posts the difference it reveals. */
  settings: Pick<AccountsSettings, "costingMethod" | "allowNegativeStock"> & { inventoryAccounting?: AccountsSettings["inventoryAccounting"] };
};

export type MovementWritten = {
  id: string;
  itemId: string;
  warehouseId: string;
  batchId: string | null;
  quantity: number;
  valuePaise: number;
};

const ITEM_SELECT = {
  id: true,
  name: true,
  type: true,
  trackInventory: true,
  costPrice: true,
  trackBatches: true,
  trackExpiry: true,
  trackSerials: true,
} as const;

/** A lock on one item's stock in one warehouse, until the transaction ends. Taken in a fixed order by callers moving several. */
export async function lockStock(tx: Tx, itemId: string, warehouseId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`deskzo:stock:${itemId}:${warehouseId}`}))`;
}

/** Locks every (item, warehouse) pair a document will move, sorted, so two documents can't deadlock. */
export async function lockStockPairs(tx: Tx, pairs: readonly { itemId: string; warehouseId: string }[]) {
  const keys = [...new Set(pairs.map((p) => `${p.itemId}:${p.warehouseId}`))].sort();
  for (const key of keys) {
    const [itemId, warehouseId] = key.split(":") as [string, string];
    await lockStock(tx, itemId, warehouseId);
  }
}

async function lockKey(tx: Tx, key: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`deskzo:stock-key:${key}`}))`;
}

const movementSelect = { id: true, itemId: true, warehouseId: true, batchId: true, quantityChange: true, value: true } as const;

function written(row: { id: string; itemId: string; warehouseId: string | null; batchId: string | null; quantityChange: unknown; value: unknown }): MovementWritten {
  return {
    id: row.id,
    itemId: row.itemId,
    warehouseId: row.warehouseId ?? "",
    batchId: row.batchId,
    quantity: Number(row.quantityChange),
    valuePaise: Math.abs(toPaise(Number(row.value ?? 0))),
  };
}

/** What other orders hold of an item in a warehouse — not counting the reservation an issue fills. */
async function reservedByOthers(tx: Tx, itemId: string, warehouseId: string, own?: { sourceType: string; sourceId: string } | null) {
  const rows = await tx.stockReservation.findMany({
    where: { itemId, warehouseId, status: "ACTIVE" },
    select: { quantity: true, sourceType: true, sourceId: true },
  });
  return rows
    .filter((r) => !(own && r.sourceType === own.sourceType && r.sourceId === own.sourceId))
    .reduce((t, r) => t + toMilli(Number(r.quantity)), 0);
}

/**
 * Moves stock once. Returns the movements written — or those already written under the same key — and
 * refuses (StockError) anything the rules don't allow.
 */
export async function moveStock(tx: Tx, input: MoveStockInput): Promise<MovementWritten[]> {
  if (!input.idempotencyKey) throw new StockError("A stock movement needs its idempotency key.");
  await lockKey(tx, input.idempotencyKey);
  const already = await tx.stockMovement.findMany({
    where: { OR: [{ idempotencyKey: input.idempotencyKey }, { idempotencyKey: { startsWith: `${input.idempotencyKey}#` } }] },
    select: movementSelect,
    orderBy: { createdAt: "asc" },
  });
  if (already.length > 0) return already.map(written);

  const qtyMilli = toMilli(input.quantity);
  if (qtyMilli === 0) throw new StockError("A stock movement needs a quantity.");

  const item = await tx.item.findUnique({ where: { id: input.itemId }, select: ITEM_SELECT });
  if (!item) throw new StockError("That item no longer exists.");
  if (!item.trackInventory || item.type !== "GOOD") throw new StockError(`${item.name} doesn't keep stock.`);
  const warehouse = await tx.warehouse.findUnique({ where: { id: input.warehouseId }, select: { id: true, name: true, active: true } });
  if (!warehouse) throw new StockError("That warehouse no longer exists.");
  if (!warehouse.active && qtyMilli > 0) throw new StockError(`${warehouse.name} is closed, so nothing can be received into it.`);

  await lockStock(tx, item.id, warehouse.id);

  const serials = (input.serials ?? []).map((s) => s.trim()).filter(Boolean);
  if (item.trackSerials) {
    if (qtyMilli % 1000 !== 0) throw new StockError(`${item.name} keeps serial numbers, so it moves in whole units.`);
    if (new Set(serials).size !== serials.length) throw new StockError(`A serial number for ${item.name} is listed twice.`);
    if (serials.length !== Math.abs(qtyMilli) / 1000) {
      throw new StockError(`${item.name} keeps serial numbers — give one for each of the ${fromMilli(Math.abs(qtyMilli))} unit(s) (${serials.length} given).`);
    }
  }

  // Stock going out: enough of it, after what other orders hold.
  if (qtyMilli < 0) {
    const onHand = await tx.stockBalance.aggregate({ where: { itemId: item.id, warehouseId: warehouse.id }, _sum: { quantity: true } });
    const available = toMilli(Number(onHand._sum.quantity ?? 0)) - (await reservedByOthers(tx, item.id, warehouse.id, input.reservation));
    if (-qtyMilli > available && (!input.settings.allowNegativeStock || item.trackBatches)) {
      const why = item.trackBatches && input.settings.allowNegativeStock ? " Batches can't go below nothing." : "";
      throw new StockError(
        `Not enough ${item.name} in ${warehouse.name}: ${fromMilli(Math.max(0, available))} available, ${fromMilli(-qtyMilli)} needed.${why}`,
      );
    }
  }

  // Which batch, or batches.
  let parts: { batchId: string | null; batchKey: string; qtyMilli: number; serials: string[] }[];
  if (!item.trackBatches) {
    parts = [{ batchId: null, batchKey: "", qtyMilli, serials }];
  } else if (qtyMilli > 0) {
    const batchId = input.batchId ?? (await batchFor(tx, item, input.batch ?? null));
    parts = [{ batchId, batchKey: batchId, qtyMilli, serials }];
  } else if (input.batchId) {
    parts = [{ batchId: input.batchId, batchKey: input.batchId, qtyMilli, serials }];
  } else if (input.batch?.batchNo) {
    const batch = await tx.itemBatch.findUnique({ where: { itemId_batchNo: { itemId: item.id, batchNo: input.batch.batchNo.trim() } }, select: { id: true } });
    if (!batch) throw new StockError(`There's no batch ${input.batch.batchNo} of ${item.name}.`);
    parts = [{ batchId: batch.id, batchKey: batch.id, qtyMilli, serials }];
  } else {
    parts = await pickBatches(tx, item, warehouse.id, -qtyMilli, input.date, !!input.skipExpired, serials);
  }

  const out: MovementWritten[] = [];
  for (const [i, part] of parts.entries()) {
    out.push(
      await moveOne(tx, item, warehouse.id, part, {
        ...input,
        idempotencyKey: parts.length === 1 ? input.idempotencyKey : `${input.idempotencyKey}#${i + 1}`,
      }),
    );
  }

  // The item's total on hand, moved by the same amount.
  await tx.item.update({ where: { id: item.id }, data: { stockQuantity: { increment: fromMilli(qtyMilli) } }, select: { id: true } });
  return out;
}

type ItemRow = { id: string; name: string; costPrice: unknown; trackBatches: boolean; trackExpiry: boolean; trackSerials: boolean };

/** The batch stock is coming into, made the first time it's seen. */
async function batchFor(tx: Tx, item: ItemRow, batch: MoveStockInput["batch"]): Promise<string> {
  const batchNo = batch?.batchNo?.trim();
  if (!batchNo) throw new StockError(`${item.name} keeps batches — give the batch number.`);
  const existing = await tx.itemBatch.findUnique({ where: { itemId_batchNo: { itemId: item.id, batchNo } }, select: { id: true, expiryDate: true, mfgDate: true } });
  if (existing) {
    // A batch's dates are filled in where it had none; a date it already has isn't changed by a later receipt.
    const fill: Prisma.ItemBatchUpdateInput = {};
    if (!existing.expiryDate && batch?.expiryDate) fill.expiryDate = batch.expiryDate;
    if (!existing.mfgDate && batch?.mfgDate) fill.mfgDate = batch.mfgDate;
    if (Object.keys(fill).length > 0) await tx.itemBatch.update({ where: { id: existing.id }, data: fill });
    if (item.trackExpiry && !existing.expiryDate && !batch?.expiryDate) throw new StockError(`${item.name} keeps expiry dates — give batch ${batchNo}'s expiry date.`);
    return existing.id;
  }
  if (item.trackExpiry && !batch?.expiryDate) throw new StockError(`${item.name} keeps expiry dates — give batch ${batchNo}'s expiry date.`);
  if (batch?.mfgDate && batch?.expiryDate && batch.expiryDate < batch.mfgDate) throw new StockError(`Batch ${batchNo} can't expire before it was made.`);
  const created = await tx.itemBatch.create({
    data: { itemId: item.id, batchNo, mfgDate: batch?.mfgDate ?? null, expiryDate: batch?.expiryDate ?? null },
    select: { id: true },
  });
  return created.id;
}

/**
 * The batches an issue comes from when none was named: first to expire first, then oldest batch number —
 * skipping expired batches for a sale. Serials, where the item keeps them, decide the batch themselves.
 */
async function pickBatches(tx: Tx, item: ItemRow, warehouseId: string, needMilli: number, date: Date, skipExpired: boolean, serials: string[]) {
  if (item.trackSerials && serials.length > 0) {
    const rows = await tx.itemSerial.findMany({ where: { itemId: item.id, serialNo: { in: serials } }, select: { serialNo: true, batchId: true } });
    const byBatch = new Map<string, string[]>();
    for (const s of serials) {
      const batchId = rows.find((r) => r.serialNo === s)?.batchId;
      if (!batchId) throw new StockError(`Serial ${s} of ${item.name} isn't in stock in a batch.`);
      byBatch.set(batchId, [...(byBatch.get(batchId) ?? []), s]);
    }
    return [...byBatch.entries()].map(([batchId, list]) => ({ batchId, batchKey: batchId, qtyMilli: -list.length * 1000, serials: list }));
  }
  const balances = await tx.stockBalance.findMany({
    where: { itemId: item.id, warehouseId, quantity: { gt: 0 }, batchId: { not: null } },
    select: { batchId: true, quantity: true, batch: { select: { batchNo: true, expiryDate: true } } },
  });
  const usable = balances
    .filter((b) => !(skipExpired && b.batch?.expiryDate && b.batch.expiryDate < startOfDay(date)))
    .sort((a, b) => {
      const ea = a.batch?.expiryDate?.getTime() ?? Number.POSITIVE_INFINITY;
      const eb = b.batch?.expiryDate?.getTime() ?? Number.POSITIVE_INFINITY;
      return ea - eb || (a.batch?.batchNo ?? "").localeCompare(b.batch?.batchNo ?? "");
    });
  const parts: { batchId: string | null; batchKey: string; qtyMilli: number; serials: string[] }[] = [];
  let left = needMilli;
  for (const b of usable) {
    if (left <= 0) break;
    const take = Math.min(left, toMilli(Number(b.quantity)));
    parts.push({ batchId: b.batchId!, batchKey: b.batchId!, qtyMilli: -take, serials: [] });
    left -= take;
  }
  if (left > 0) {
    const expired = balances.length > usable.length ? " Expired batches aren't sold — write them off with an adjustment." : "";
    throw new StockError(`Not enough unexpired batches of ${item.name}: ${fromMilli(needMilli - left)} of ${fromMilli(needMilli)} found.${expired}`);
  }
  return parts;
}

function startOfDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** One movement in one batch (or none): costed, written, and the balance, layers and serials moved with it. */
async function moveOne(
  tx: Tx,
  item: ItemRow,
  warehouseId: string,
  part: { batchId: string | null; batchKey: string; qtyMilli: number; serials: string[] },
  input: MoveStockInput,
): Promise<MovementWritten> {
  const key = { itemId_warehouseId_batchKey: { itemId: item.id, warehouseId, batchKey: part.batchKey } };
  const balanceRow = await tx.stockBalance.findUnique({ where: key, select: { quantity: true, value: true } });
  const balance = { qtyMilli: toMilli(Number(balanceRow?.quantity ?? 0)), valuePaise: toPaise(Number(balanceRow?.value ?? 0)) };
  const fallbackCost4 = toCost4(Number(item.costPrice ?? 0));

  let movementPaise: number; // signed, like the quantity
  let takes: { layerId: string; takeMilli: number }[] = [];
  if (part.qtyMilli > 0) {
    const paise =
      input.valuePaise != null
        ? Math.abs(input.valuePaise)
        : input.unitCost != null
          ? valuePaise(part.qtyMilli, toCost4(input.unitCost))
          : valuePaise(part.qtyMilli, balance.qtyMilli > 0 ? unitCost4(balance.valuePaise, balance.qtyMilli) : fallbackCost4);
    movementPaise = paise;
  } else {
    const layers = await tx.stockCostLayer.findMany({
      where: { itemId: item.id, warehouseId, batchKey: part.batchKey, remaining: { gt: 0 } },
      orderBy: [{ receivedAt: "asc" }, { createdAt: "asc" }],
      select: { id: true, remaining: true, unitCost: true, movementId: true },
    });
    // Taking a receipt back out takes its own layer first.
    const own = input.reversesId;
    if (own) layers.sort((a, b) => Number(b.movementId === own) - Number(a.movementId === own));
    const costLayers: CostLayer[] = layers.map((l) => ({ id: l.id, remainingMilli: toMilli(Number(l.remaining)), cost4: toCost4(Number(l.unitCost)) }));
    const costing = costIssue(input.settings.costingMethod, balance, costLayers, -part.qtyMilli, fallbackCost4);
    movementPaise = -(input.valuePaise != null ? Math.abs(input.valuePaise) : costing.valuePaise);
    takes = costing.takes.map((t) => ({ layerId: layers[t.index]!.id, takeMilli: t.takeMilli }));
  }

  const movement = await tx.stockMovement.create({
    data: {
      itemId: item.id,
      warehouseId,
      batchId: part.batchId,
      type: input.type,
      quantityChange: fromMilli(part.qtyMilli),
      reason: input.reason ?? null,
      createdByUserId: input.userId,
      movementDate: input.date,
      unitCost: fromCost4(unitCost4(Math.abs(movementPaise), Math.abs(part.qtyMilli))),
      value: fromPaise(movementPaise),
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      sourceLineId: input.sourceLineId ?? null,
      tradeDocumentId: input.tradeDocumentId ?? null,
      stockDocumentId: input.stockDocumentId ?? null,
      idempotencyKey: input.idempotencyKey,
      serialNumbers: part.serials,
      ...(input.reversesId ? { reversesId: input.reversesId } : {}),
    },
    select: { id: true },
  });

  /**
   * A receipt filling stock issued before it came (negative stock, where allowed): those units went out at the
   * cost known then, and this receipt says what they really cost. The difference is theirs, not the stock
   * left's — so it is taken off (or put back on) the balance by a revaluation of no quantity, and under
   * perpetual inventory moved between Stock in Hand and Cost of Goods Sold. Without it, what is left on hand
   * would carry the earlier issue's under- or over-costing, and drift from its cost layers.
   */
  const fillMilli = part.qtyMilli > 0 ? Math.min(part.qtyMilli, Math.max(0, -balance.qtyMilli)) : 0;
  const revaluePaise =
    fillMilli > 0 ? proportionPaise(movementPaise, fillMilli, part.qtyMilli) - proportionPaise(-balance.valuePaise, fillMilli, -balance.qtyMilli) : 0;

  await tx.stockBalance.upsert({
    where: key,
    create: {
      itemId: item.id,
      warehouseId,
      batchKey: part.batchKey,
      batchId: part.batchId,
      quantity: fromMilli(part.qtyMilli),
      value: fromPaise(movementPaise),
    },
    update: { quantity: { increment: fromMilli(part.qtyMilli) }, value: { increment: fromPaise(movementPaise - revaluePaise) } },
  });

  if (revaluePaise !== 0) {
    // Its own key, apart from the receipt's: the receipt's callers cost what they moved, and this is not that.
    const revaluation = await tx.stockMovement.create({
      data: {
        itemId: item.id,
        warehouseId,
        batchId: part.batchId,
        type: "ADJUSTMENT",
        quantityChange: 0,
        reason: `Revalued: ${fromMilli(fillMilli)} issued before this receipt came, at its cost`,
        createdByUserId: input.userId,
        movementDate: input.date,
        unitCost: 0,
        value: fromPaise(-revaluePaise),
        sourceType: input.sourceType,
        sourceId: input.sourceId ?? null,
        sourceLineId: input.sourceLineId ?? null,
        idempotencyKey: `revalue:${movement.id}`,
      },
      select: { id: true },
    });
    if (input.settings.inventoryAccounting === "PERPETUAL") {
      await postInventoryEntry(tx, {
        postingKey: `stock:revalue:${revaluation.id}`,
        date: input.date,
        narration: `${item.name}: stock issued before it was received, revalued at the receipt's cost`,
        userId: input.userId,
        lines: revaluePaise > 0 ? pair("COGS", "INVENTORY", revaluePaise) : pair("INVENTORY", "COGS", -revaluePaise),
      });
    }
  }

  if (part.qtyMilli > 0) {
    // What a receipt adds to stock on hand: all of it, less whatever it fills of a balance below nothing.
    const fillsOwed = Math.min(part.qtyMilli, Math.max(0, -balance.qtyMilli));
    const remaining = part.qtyMilli - fillsOwed;
    if (remaining > 0) {
      await tx.stockCostLayer.create({
        data: {
          itemId: item.id,
          warehouseId,
          batchKey: part.batchKey,
          movementId: movement.id,
          receivedAt: input.date,
          quantity: fromMilli(part.qtyMilli),
          remaining: fromMilli(remaining),
          unitCost: fromCost4(unitCost4(movementPaise, part.qtyMilli)),
        },
      });
    }
  } else {
    for (const t of takes) {
      await tx.stockCostLayer.update({ where: { id: t.layerId }, data: { remaining: { decrement: fromMilli(t.takeMilli) } } });
    }
  }

  if (item.trackSerials) await moveSerials(tx, item, warehouseId, part, movement.id, input.serialOutStatus ?? "ISSUED");

  return { id: movement.id, itemId: item.id, warehouseId, batchId: part.batchId, quantity: fromMilli(part.qtyMilli), valuePaise: Math.abs(movementPaise) };
}

async function moveSerials(
  tx: Tx,
  item: ItemRow,
  warehouseId: string,
  part: { batchId: string | null; qtyMilli: number; serials: string[] },
  movementId: string,
  outStatus: SerialStatus,
) {
  const rows = await tx.itemSerial.findMany({
    where: { itemId: item.id, serialNo: { in: part.serials } },
    select: { id: true, serialNo: true, status: true, warehouseId: true },
  });
  for (const serialNo of part.serials) {
    const row = rows.find((r) => r.serialNo === serialNo);
    if (part.qtyMilli > 0) {
      if (row?.status === "IN_STOCK") throw new StockError(`Serial ${serialNo} of ${item.name} is already in stock.`);
      if (row) {
        await tx.itemSerial.update({ where: { id: row.id }, data: { status: "IN_STOCK", warehouseId, batchId: part.batchId, inMovementId: movementId, outMovementId: null } });
      } else {
        await tx.itemSerial.create({ data: { itemId: item.id, serialNo, status: "IN_STOCK", warehouseId, batchId: part.batchId, inMovementId: movementId } });
      }
    } else {
      if (!row || row.status !== "IN_STOCK" || row.warehouseId !== warehouseId) {
        throw new StockError(`Serial ${serialNo} of ${item.name} isn't in stock in this warehouse.`);
      }
      await tx.itemSerial.update({ where: { id: row.id }, data: { status: outStatus, outMovementId: movementId } });
    }
  }
}

/**
 * Writes the opposite of a movement — the only way one is undone. At its own value, so taking a receipt back
 * out or putting a sale back leaves the cost of stock where it was; once, by its key.
 */
export async function reverseMovement(
  tx: Tx,
  movementId: string,
  params: { userId: string; reason: string; date?: Date; settings: MoveStockInput["settings"] },
): Promise<MovementWritten | null> {
  const original = await tx.stockMovement.findUnique({
    where: { id: movementId },
    select: {
      id: true, itemId: true, warehouseId: true, batchId: true, type: true, quantityChange: true, value: true,
      sourceType: true, sourceId: true, sourceLineId: true, tradeDocumentId: true, stockDocumentId: true,
      serialNumbers: true, reversedBy: { select: { id: true } }, reversesId: true,
    },
  });
  if (!original || original.reversedBy || original.reversesId || !original.warehouseId) return null;
  const qty = -Number(original.quantityChange);
  const [movement] = await moveStock(tx, {
    itemId: original.itemId,
    warehouseId: original.warehouseId,
    quantity: qty,
    type: original.type,
    sourceType: original.sourceType ?? "MANUAL",
    sourceId: original.sourceId,
    sourceLineId: original.sourceLineId,
    tradeDocumentId: original.tradeDocumentId,
    stockDocumentId: original.stockDocumentId,
    date: params.date ?? new Date(),
    userId: params.userId,
    reason: params.reason,
    idempotencyKey: `reverse:${original.id}`,
    valuePaise: Math.abs(toPaise(Number(original.value ?? 0))),
    batchId: original.batchId,
    serials: original.serialNumbers,
    // A receipt taken back goes back where it came from; anything else taken out is written off.
    serialOutStatus: original.sourceType === "GRN" || original.sourceType === "PURCHASE_BILL" ? "RETURNED_TO_VENDOR" : "SCRAPPED",
    settings: params.settings,
    reversesId: original.id,
  });
  return movement ?? null;
}

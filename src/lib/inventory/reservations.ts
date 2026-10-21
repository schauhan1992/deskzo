import type { Prisma } from "@prisma/client";
import { fromMilli, toMilli } from "@/lib/accounts/money";
import type { AccountsSettings } from "@/lib/accounts/settings";
import { lockStock, StockError } from "@/lib/inventory/engine";
import { defaultWarehouseId } from "@/lib/inventory/warehouses";

type Tx = Prisma.TransactionClient;

/**
 * Stock held for a sales order before it ships (owner, 22 Oct 2026). Available stock is on hand less what other
 * orders hold, so two orders can't both promise the last unit: reserving takes the same lock a sale does, and
 * counts every other order's reservation as gone. One reservation per order, item and warehouse — reserving
 * again changes it rather than adding a second. The invoice that ships the order fills it
 * (src/lib/inventory/documents.ts); cancelling or fulfilling the order releases what is left.
 */

/** What can be promised of an item in a warehouse: on hand, less what other sources hold. */
export async function availableToPromise(tx: Tx, itemId: string, warehouseId: string, except?: { sourceType: string; sourceId: string }) {
  const [onHand, reserved] = await Promise.all([
    tx.stockBalance.aggregate({ where: { itemId, warehouseId }, _sum: { quantity: true } }),
    tx.stockReservation.findMany({ where: { itemId, warehouseId, status: "ACTIVE" }, select: { quantity: true, sourceType: true, sourceId: true } }),
  ]);
  const held = reserved
    .filter((r) => !(except && r.sourceType === except.sourceType && r.sourceId === except.sourceId))
    .reduce((t, r) => t + toMilli(Number(r.quantity)), 0);
  return fromMilli(toMilli(Number(onHand._sum.quantity ?? 0)) - held);
}

/**
 * Reserves `quantity` for a source. `partial` reserves what is available up to that when there isn't enough
 * (an order approved for goods purchase hasn't bought yet); otherwise too little is refused.
 */
export async function reserveStock(
  tx: Tx,
  params: { itemId: string; warehouseId?: string | null; quantity: number; sourceType: string; sourceId: string; userId: string; note?: string; partial?: boolean },
  settings: AccountsSettings,
): Promise<{ reserved: number; warehouseId: string } | null> {
  const item = await tx.item.findUnique({ where: { id: params.itemId }, select: { name: true, type: true, trackInventory: true } });
  if (!item || item.type !== "GOOD" || !item.trackInventory) return null;
  const warehouseId = params.warehouseId || (await defaultWarehouseId(tx, settings));
  await lockStock(tx, params.itemId, warehouseId);
  const source = { sourceType: params.sourceType, sourceId: params.sourceId };
  const available = Math.max(0, await availableToPromise(tx, params.itemId, warehouseId, source));
  let quantity = params.quantity;
  if (quantity > available) {
    if (!params.partial) throw new StockError(`Only ${available} of ${item.name} can be reserved — ${params.quantity} asked for.`);
    quantity = available;
  }
  const key = { sourceType_sourceId_itemId_warehouseId: { ...source, itemId: params.itemId, warehouseId } };
  if (quantity <= 0) {
    await tx.stockReservation.updateMany({ where: { ...source, itemId: params.itemId, warehouseId, status: "ACTIVE" }, data: { status: "RELEASED" } });
    return { reserved: 0, warehouseId };
  }
  await tx.stockReservation.upsert({
    where: key,
    create: { ...source, itemId: params.itemId, warehouseId, quantity, status: "ACTIVE", createdById: params.userId, note: params.note ?? null },
    update: { quantity, status: "ACTIVE", note: params.note ?? null },
  });
  return { reserved: quantity, warehouseId };
}

/** Releases whatever a source still holds. */
export async function releaseReservations(tx: Tx, sourceType: string, sourceId: string) {
  return tx.stockReservation.updateMany({ where: { sourceType, sourceId, status: "ACTIVE" }, data: { status: "RELEASED" } });
}

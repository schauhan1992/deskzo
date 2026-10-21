import type { Prisma } from "@prisma/client";
import type { AccountsSettings } from "@/lib/accounts/settings";
import { moveStock } from "@/lib/inventory/engine";
import { defaultWarehouseId } from "@/lib/inventory/warehouses";

type Tx = Prisma.TransactionClient;

/**
 * An item's opening stock, as it's created or imported (owner, 22 Oct 2026): into the default warehouse at its
 * cost price, through the stock engine, once (`opening:<item>`). The item must already exist with nothing
 * on hand — the engine adds the quantity to it.
 *
 * Where the workspace's database doesn't have the stock ledger's columns yet (`settings` null, read before
 * the transaction), it is recorded as it always was: one movement, and the quantity on the item.
 */
export async function recordOpeningStock(
  tx: Tx,
  params: { itemId: string; quantity: number; unitCost: number | null; userId: string; reason: string },
  settings: AccountsSettings | null,
) {
  if (!(params.quantity > 0)) return;
  if (!settings) {
    await tx.stockMovement.create({
      data: { itemId: params.itemId, type: "RECEIVED", quantityChange: params.quantity, reason: params.reason, createdByUserId: params.userId },
      select: { id: true },
    });
    await tx.item.update({ where: { id: params.itemId }, data: { stockQuantity: params.quantity }, select: { id: true } });
    return;
  }
  await moveStock(tx, {
    itemId: params.itemId,
    warehouseId: await defaultWarehouseId(tx, settings),
    quantity: params.quantity,
    type: "OPENING",
    sourceType: "OPENING",
    sourceId: params.itemId,
    date: new Date(),
    userId: params.userId,
    reason: params.reason,
    idempotencyKey: `opening:${params.itemId}`,
    unitCost: params.unitCost,
    settings,
  });
}

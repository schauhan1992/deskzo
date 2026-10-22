import type { Prisma } from "@prisma/client";
import { toMilli, toPaise } from "@/lib/accounts/money";
import type { AccountsSettings } from "@/lib/accounts/settings";
import { bookingRate } from "@/lib/ledger/posting";
import { lockStockPairs, moveStock, reverseMovement, StockError, type MovementWritten } from "@/lib/inventory/engine";
import { pair, postInventoryEntry, reverseInventoryEntry } from "@/lib/inventory/posting";
import { defaultWarehouseId } from "@/lib/inventory/warehouses";

type Tx = Prisma.TransactionClient;

/**
 * What issuing a trade document does to stock (owner, 22 Oct 2026) — each only where Accounts settings turn
 * it on, so a company that has always recorded stock by hand doesn't find it moved twice:
 *
 *   · **a tax invoice** issues its goods from its warehouse ("Invoices issue stock"), filling the order's
 *     reservation if it had one, first-expiry-first-out where the goods keep batches;
 *   · **a vendor bill** receives them ("Bills receive stock") — unless a goods receipt already brought them
 *     in against its purchase order, when the bill only clears what the receipt left owing;
 *   · **a credit note** takes goods back into stock at what they cost when sold ("Credit notes return stock").
 *
 * Runs inside the issue's own transaction, after the document's ledger entry: stock, the entry and the
 * status commit together. Every movement is keyed by the document's line, so issuing twice moves nothing
 * more. Cancelling the document reverses them (`reverseTradeDocumentStock`).
 */

type DocRow = Awaited<ReturnType<typeof loadDocument>>;

async function loadDocument(tx: Tx, documentId: string) {
  return tx.tradeDocument.findUnique({
    where: { id: documentId },
    select: {
      id: true, docType: true, docNumber: true, issueDate: true, branchId: true, companyId: true, warehouseId: true,
      againstDocumentId: true, sourceDocumentId: true, currency: true, exchangeRate: true,
      lines: {
        orderBy: { sortOrder: "asc" },
        select: {
          id: true, itemId: true, quantity: true, unit: true, taxableValue: true, companyProductId: true, description: true, name: true,
          item: { select: { id: true, name: true, type: true, trackInventory: true, unit: true, trackBatches: true, trackSerials: true } },
        },
      },
    },
  });
}

/** The warehouse a document's goods move through: its own, else its branch's, else the default. */
async function warehouseOf(tx: Tx, doc: NonNullable<DocRow>, settings: AccountsSettings): Promise<string> {
  if (doc.warehouseId) return doc.warehouseId;
  if (doc.branchId) {
    const branchStore = await tx.warehouse.findFirst({ where: { branchId: doc.branchId, active: true }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }], select: { id: true } });
    if (branchStore) return branchStore.id;
  }
  return defaultWarehouseId(tx, settings);
}

/** A line's quantity in its item's base unit — through the item's other units where the line names one. */
async function baseQuantity(tx: Tx, line: NonNullable<DocRow>["lines"][number]): Promise<number> {
  const qty = Number(line.quantity);
  const unit = line.unit?.trim();
  if (!unit || !line.item || !line.item.unit || unit.toLowerCase() === line.item.unit.trim().toLowerCase()) return qty;
  const conversion = await tx.itemUnit.findUnique({ where: { itemId_unit: { itemId: line.item.id, unit } }, select: { factor: true } });
  return conversion ? Math.round(qty * Number(conversion.factor) * 1000) / 1000 : qty;
}

/** Serial numbers a line names in its description that are this item's — "SN123, SN124" or one a line. */
async function serialsFromDescription(tx: Tx, itemId: string, description: string | null, count: number, inStockIn?: string): Promise<string[]> {
  const tokens = (description ?? "").split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) return [];
  const rows = await tx.itemSerial.findMany({
    where: { itemId, serialNo: { in: tokens }, ...(inStockIn ? { status: "IN_STOCK", warehouseId: inStockIn } : { status: { not: "IN_STOCK" } }) },
    select: { serialNo: true },
  });
  const known = new Set(rows.map((r) => r.serialNo));
  return tokens.filter((t) => known.has(t)).slice(0, count);
}

const stockLines = (doc: NonNullable<DocRow>) =>
  doc.lines.filter((l) => l.item && l.item.type === "GOOD" && l.item.trackInventory && Number(l.quantity) > 0);

/** Moves the stock an issued document moves, where settings say it should. Returns what it wrote. */
export async function applyTradeDocumentStock(tx: Tx, documentId: string, userId: string, settings: AccountsSettings): Promise<MovementWritten[]> {
  const doc = await loadDocument(tx, documentId);
  if (!doc) return [];
  const applies =
    (doc.docType === "INVOICE" && settings.invoiceIssuesStock) ||
    (doc.docType === "BILL" && settings.billReceivesStock) ||
    (doc.docType === "CREDIT_NOTE" && settings.creditNoteReturnsStock);
  if (!applies) return [];
  const lines = stockLines(doc);
  if (lines.length === 0) return [];

  if (doc.docType === "BILL") {
    const received = await receiptsForBill(tx, doc);
    if (received.length > 0) {
      await clearReceiptsWithBill(tx, doc, received, userId, settings);
      return [];
    }
  }

  const warehouseId = await warehouseOf(tx, doc, settings);
  await lockStockPairs(tx, lines.map((l) => ({ itemId: l.itemId!, warehouseId })));
  const rate = bookingRate(doc);
  const written: MovementWritten[] = [];

  for (const line of lines) {
    const item = line.item!;
    const qty = await baseQuantity(tx, line);
    const key = `doc:${doc.id}:line:${line.id}`;
    const common = { itemId: item.id, warehouseId, tradeDocumentId: doc.id, sourceId: doc.id, sourceLineId: line.id, date: doc.issueDate, userId, idempotencyKey: key, settings };

    if (doc.docType === "INVOICE") {
      const serials = item.trackSerials ? await serialsFromDescription(tx, item.id, line.description, qty, warehouseId) : [];
      if (item.trackSerials && serials.length !== qty) {
        throw new StockError(`${item.name} keeps serial numbers — list the ${qty} sold, in stock in this warehouse, in the line's description (${serials.length} found).`);
      }
      const reservation = line.companyProductId ? { sourceType: "ORDER", sourceId: line.companyProductId } : null;
      written.push(
        ...(await moveStock(tx, {
          ...common,
          quantity: -qty,
          type: "SOLD",
          sourceType: "SALES_INVOICE",
          reason: `Sold on ${doc.docNumber}`,
          serials,
          reservation,
          skipExpired: true,
        })),
      );
      if (reservation) {
        await tx.stockReservation.updateMany({ where: { ...reservation, itemId: item.id, status: "ACTIVE" }, data: { status: "CONSUMED" } });
      }
    } else if (doc.docType === "BILL") {
      if (item.trackBatches || item.trackSerials) {
        throw new StockError(`${item.name} keeps ${item.trackBatches ? "batches" : "serial numbers"} — receive it with a goods receipt, which records them, rather than through the bill.`);
      }
      // What it cost: the line's taxable value (GST is claimed back, not stock's cost), in rupees, per unit.
      const valuePaise = toPaise(Number(line.taxableValue) * rate);
      written.push(...(await moveStock(tx, { ...common, quantity: qty, type: "RECEIVED", sourceType: "PURCHASE_BILL", reason: `Received on ${doc.docNumber}`, valuePaise })));
    } else {
      // A credit note: back at what the goods cost when its invoice sold them, where it did.
      const sold = doc.againstDocumentId
        ? await tx.stockMovement.findMany({
            where: { tradeDocumentId: doc.againstDocumentId, itemId: item.id, sourceType: "SALES_INVOICE", reversesId: null },
            select: { quantityChange: true, value: true, batchId: true },
          })
        : [];
      const soldMilli = sold.reduce((t, m) => t + Math.abs(toMilli(Number(m.quantityChange))), 0);
      const soldPaise = sold.reduce((t, m) => t + Math.abs(toPaise(Number(m.value ?? 0))), 0);
      const valuePaise = soldMilli > 0 ? Math.round((soldPaise * toMilli(qty)) / soldMilli) : null;
      const batchId = item.trackBatches ? (sold.find((m) => m.batchId)?.batchId ?? null) : null;
      if (item.trackBatches && !batchId) throw new StockError(`${item.name} keeps batches, and the invoice this credits didn't issue it from one — return it with a stock adjustment naming the batch.`);
      const serials = item.trackSerials ? await serialsFromDescription(tx, item.id, line.description, qty) : [];
      if (item.trackSerials && serials.length !== qty) {
        throw new StockError(`${item.name} keeps serial numbers — list the ${qty} coming back in the line's description (${serials.length} found).`);
      }
      written.push(
        ...(await moveStock(tx, {
          ...common,
          quantity: qty,
          type: "RETURNED",
          sourceType: "CREDIT_NOTE",
          reason: `Returned on ${doc.docNumber}`,
          valuePaise,
          batchId,
          serials,
        })),
      );
    }
  }

  if (settings.inventoryAccounting === "PERPETUAL") {
    const total = written.reduce((t, m) => t + m.valuePaise, 0);
    const lines =
      doc.docType === "INVOICE"
        ? pair("COGS", "INVENTORY", total)
        : doc.docType === "BILL"
          ? pair("INVENTORY", "PURCHASES", total)
          : pair("INVENTORY", "COGS", total);
    await postInventoryEntry(tx, {
      postingKey: `stock:doc:${doc.id}`,
      date: doc.issueDate,
      narration: `${doc.docType === "INVOICE" ? "Cost of goods sold on" : doc.docType === "BILL" ? "Stock received on" : "Stock returned on"} ${doc.docNumber}`,
      userId,
      lines,
      documentId: doc.id,
      companyId: doc.companyId,
      branchId: doc.branchId,
    });
  }
  return written;
}

/** Goods receipts posted for this bill, or for the purchase order it bills, that no bill has cleared yet. */
async function receiptsForBill(tx: Tx, doc: NonNullable<DocRow>) {
  return tx.stockDocument.findMany({
    where: {
      type: "GRN",
      status: "POSTED",
      OR: [{ billId: doc.id }, ...(doc.sourceDocumentId ? [{ purchaseOrderId: doc.sourceDocumentId, billId: null }] : [])],
    },
    select: { id: true, number: true, billId: true },
  });
}

/**
 * A bill for goods a receipt already brought in moves no stock; under perpetual inventory it clears what the
 * receipt left in Goods Received Not Invoiced, at the receipt's value — the bill's own entry booked Purchases,
 * so Dr Goods Received NI, Cr Purchases leaves Purchases holding only any price difference.
 */
async function clearReceiptsWithBill(tx: Tx, doc: NonNullable<DocRow>, receipts: { id: string; number: string; billId: string | null }[], userId: string, settings: AccountsSettings) {
  const unmatched = receipts.filter((r) => !r.billId);
  if (unmatched.length > 0) await tx.stockDocument.updateMany({ where: { id: { in: unmatched.map((r) => r.id) } }, data: { billId: doc.id } });
  if (settings.inventoryAccounting !== "PERPETUAL") return;
  const value = await tx.stockMovement.aggregate({
    where: { stockDocumentId: { in: receipts.map((r) => r.id) }, reversesId: null, reversedBy: { is: null } },
    _sum: { value: true },
  });
  const paise = toPaise(Number(value._sum.value ?? 0));
  // Only receipts whose own entry went to Goods Received NI — one posted after its bill went straight to Purchases.
  const viaGrni = await tx.journalEntry.count({ where: { postingKey: { in: receipts.map((r) => `stockdoc:${r.id}`) } } });
  if (viaGrni === 0) return;
  await postInventoryEntry(tx, {
    postingKey: `grni:${doc.id}`,
    date: doc.issueDate,
    narration: `${doc.docNumber} clears goods received on ${receipts.map((r) => r.number).join(", ")}`,
    userId,
    lines: pair("GRNI", "PURCHASES", paise),
    documentId: doc.id,
    companyId: doc.companyId,
    branchId: doc.branchId,
  });
}

/**
 * Undoes what issuing the document did to stock, when it is cancelled: every movement it wrote, reversed at its
 * own value; its inventory entry and any receipt clearing, reversed; receipts it cleared, left open for the
 * next bill. Runs whatever the settings say now — they may have changed since it was issued.
 */
export async function reverseTradeDocumentStock(tx: Tx, documentId: string, userId: string, settings: AccountsSettings) {
  const doc = await tx.tradeDocument.findUnique({ where: { id: documentId }, select: { id: true, docNumber: true } });
  if (!doc) return;
  const live = await tx.stockMovement.findMany({
    where: { tradeDocumentId: doc.id, reversesId: null, reversedBy: { is: null } },
    orderBy: { createdAt: "asc" },
    select: { id: true, itemId: true, warehouseId: true },
  });
  await lockStockPairs(tx, live.filter((m) => m.warehouseId).map((m) => ({ itemId: m.itemId, warehouseId: m.warehouseId! })));
  for (const movement of live) {
    await reverseMovement(tx, movement.id, { userId, reason: `${doc.docNumber} cancelled`, settings });
  }
  await reverseInventoryEntry(tx, `stock:doc:${doc.id}`, { userId, narration: `${doc.docNumber} cancelled` });
  await reverseInventoryEntry(tx, `grni:${doc.id}`, { userId, narration: `${doc.docNumber} cancelled` });
  await tx.stockDocument.updateMany({ where: { billId: doc.id, type: "GRN" }, data: { billId: null } });
}

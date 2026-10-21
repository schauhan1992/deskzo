import type { StockDocumentStatus, StockDocumentType, StockMovementType, StockSourceType } from "@prisma/client";

/**
 * Inventory's words, for the screens (owner, 22 Oct 2026). Plain data with no server imports, so a client
 * form can use them; src/lib/inventory/stock-documents.ts keeps the same names for the ledger's narrations.
 */

export const STOCK_DOCUMENT_TYPES = ["GRN", "TRANSFER", "ADJUSTMENT", "PHYSICAL_COUNT", "PURCHASE_RETURN"] as const satisfies readonly StockDocumentType[];

export const stockTypeLabel: Record<StockDocumentType, string> = {
  GRN: "Goods receipt",
  TRANSFER: "Stock transfer",
  ADJUSTMENT: "Stock adjustment",
  PHYSICAL_COUNT: "Physical stock count",
  PURCHASE_RETURN: "Purchase return",
};

/** The list's tabs: plural, short. */
export const stockTypePlural: Record<StockDocumentType, string> = {
  GRN: "Goods receipts",
  TRANSFER: "Transfers",
  ADJUSTMENT: "Adjustments",
  PHYSICAL_COUNT: "Physical counts",
  PURCHASE_RETURN: "Purchase returns",
};

/** The "New …" buttons — the words the help guide tells people to look for. */
export const stockTypeNew: Record<StockDocumentType, string> = {
  GRN: "New goods receipt",
  TRANSFER: "New transfer",
  ADJUSTMENT: "New adjustment",
  PHYSICAL_COUNT: "New physical count",
  PURCHASE_RETURN: "New purchase return",
};

export const stockTypeHint: Record<StockDocumentType, string> = {
  GRN: "Goods in from a vendor — against a purchase order or not — with what was accepted and what was rejected.",
  TRANSFER: "Stock sent from one warehouse to another. It leaves when sent and arrives when received.",
  ADJUSTMENT: "Stock found, damaged, expired or written off — each with its reason.",
  PHYSICAL_COUNT: "What was counted on the shelf. Posting it moves the books to match.",
  PURCHASE_RETURN: "Goods sent back to the vendor they came from.",
};

/** Which permission each kind needs — what the "New …" buttons ask of the viewer. */
export const stockTypeNeeds: Record<StockDocumentType, "receive" | "transfer" | "adjust"> = {
  GRN: "receive",
  TRANSFER: "transfer",
  ADJUSTMENT: "adjust",
  PHYSICAL_COUNT: "adjust",
  PURCHASE_RETURN: "adjust",
};

export const STOCK_DOCUMENT_STATUSES = ["DRAFT", "PENDING_APPROVAL", "IN_TRANSIT", "POSTED", "CANCELLED"] as const satisfies readonly StockDocumentStatus[];

export const stockStatusLabel: Record<StockDocumentStatus, string> = {
  DRAFT: "Draft",
  PENDING_APPROVAL: "Waiting for approval",
  IN_TRANSIT: "In transit",
  POSTED: "Posted",
  CANCELLED: "Cancelled",
};

export const stockStatusTone: Record<StockDocumentStatus, "default" | "amber" | "blue" | "green" | "red"> = {
  DRAFT: "default",
  PENDING_APPROVAL: "amber",
  IN_TRANSIT: "blue",
  POSTED: "green",
  CANCELLED: "red",
};

export const movementTypeLabel: Record<StockMovementType, string> = {
  RECEIVED: "Received",
  SOLD: "Sold",
  ADJUSTMENT: "Adjustment",
  RETURNED: "Returned by customer",
  DAMAGED: "Damaged / written off",
  OPENING: "Opening stock",
  TRANSFER_IN: "Transfer in",
  TRANSFER_OUT: "Transfer out",
  PURCHASE_RETURN: "Returned to vendor",
};

export const sourceTypeLabel: Record<StockSourceType, string> = {
  MANUAL: "Recorded by hand",
  OPENING: "Opening stock",
  SALES_INVOICE: "Tax invoice",
  CREDIT_NOTE: "Credit note",
  PURCHASE_BILL: "Vendor bill",
  GRN: "Goods receipt",
  TRANSFER: "Transfer",
  ADJUSTMENT: "Adjustment",
  PHYSICAL_COUNT: "Physical count",
  PURCHASE_RETURN: "Purchase return",
  MIGRATION: "Brought forward",
};

export function isStockDocumentType(value: string | undefined | null): value is StockDocumentType {
  return !!value && (STOCK_DOCUMENT_TYPES as readonly string[]).includes(value);
}

/** A quantity as people write it: no trailing zeros, up to three decimals, Indian grouping. */
export function qty(n: number | string | null | undefined): string {
  if (n === null || n === undefined || n === "") return "—";
  return Number(n).toLocaleString("en-IN", { maximumFractionDigits: 3 });
}

/** Rupees to the paisa. */
export function rupees(n: number | string | null | undefined): string {
  if (n === null || n === undefined || n === "") return "—";
  return `₹${Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

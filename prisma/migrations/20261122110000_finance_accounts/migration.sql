-- Finance → Accounts (owner, 22 Oct 2026): inventory kept per warehouse with a sourced, valued stock ledger;
-- batches, serials, FIFO layers and reservations; inventory's own vouchers (receipts, transfers, adjustments,
-- counts, returns); payment, receipt, contra and journal vouchers; units of measure; and Accounts settings.
--
-- Nothing existing is dropped. Items' stock and every recorded movement move into one "Main warehouse",
-- valued at each item's cost price; where an item's movements don't add up to the stock it shows, one
-- movement brings the ledger level with it and says so. A workspace without inventory gets the empty
-- warehouse and nothing else. Recovery: every change below is additive, so restoring the pre-migration
-- dump puts the workspace back exactly; the new tables can be dropped and the two columns cast back
-- (stockQuantity and quantityChange to INTEGER) if a workspace must return without a restore.

-- CreateEnum
CREATE TYPE "StockSourceType" AS ENUM ('MANUAL', 'OPENING', 'SALES_INVOICE', 'CREDIT_NOTE', 'PURCHASE_BILL', 'GRN', 'TRANSFER', 'ADJUSTMENT', 'PHYSICAL_COUNT', 'PURCHASE_RETURN', 'MIGRATION');

-- CreateEnum
CREATE TYPE "SerialStatus" AS ENUM ('IN_STOCK', 'ISSUED', 'RETURNED_TO_VENDOR', 'SCRAPPED');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'RELEASED', 'CONSUMED');

-- CreateEnum
CREATE TYPE "StockDocumentType" AS ENUM ('GRN', 'TRANSFER', 'ADJUSTMENT', 'PHYSICAL_COUNT', 'PURCHASE_RETURN');

-- CreateEnum
CREATE TYPE "StockDocumentStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'IN_TRANSIT', 'POSTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "VoucherType" AS ENUM ('PAYMENT', 'RECEIPT', 'CONTRA', 'JOURNAL');

-- CreateEnum
CREATE TYPE "VoucherStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'POSTED', 'CANCELLED', 'REVERSED');

-- CreateEnum
CREATE TYPE "InventoryAccounting" AS ENUM ('PERIODIC', 'PERPETUAL');

-- CreateEnum
CREATE TYPE "CostingMethod" AS ENUM ('WEIGHTED_AVERAGE', 'FIFO');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JournalSource" ADD VALUE 'VOUCHER';
ALTER TYPE "JournalSource" ADD VALUE 'INVENTORY';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "StockMovementType" ADD VALUE 'OPENING';
ALTER TYPE "StockMovementType" ADD VALUE 'TRANSFER_IN';
ALTER TYPE "StockMovementType" ADD VALUE 'TRANSFER_OUT';
ALTER TYPE "StockMovementType" ADD VALUE 'PURCHASE_RETURN';

-- AlterTable
ALTER TABLE "items" ADD COLUMN     "barcode" TEXT,
ADD COLUMN     "reorderQuantity" DECIMAL(14,3),
ADD COLUMN     "trackBatches" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "trackExpiry" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "trackSerials" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "stockQuantity" SET DEFAULT 0,
ALTER COLUMN "stockQuantity" SET DATA TYPE DECIMAL(14,3);

-- AlterTable
ALTER TABLE "journal_entries" ADD COLUMN     "accountVoucherId" TEXT,
ADD COLUMN     "postingKey" TEXT,
ADD COLUMN     "stockDocumentId" TEXT;

-- AlterTable
ALTER TABLE "stock_movements" ADD COLUMN     "batchId" TEXT,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "movementDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "reversesId" TEXT,
ADD COLUMN     "serialNumbers" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "sourceId" TEXT,
ADD COLUMN     "sourceLineId" TEXT,
ADD COLUMN     "sourceType" "StockSourceType",
ADD COLUMN     "stockDocumentId" TEXT,
ADD COLUMN     "tradeDocumentId" TEXT,
ADD COLUMN     "unitCost" DECIMAL(14,4),
ADD COLUMN     "value" DECIMAL(16,2),
ADD COLUMN     "warehouseId" TEXT,
ALTER COLUMN "quantityChange" SET DATA TYPE DECIMAL(14,3);

-- AlterTable
ALTER TABLE "trade_documents" ADD COLUMN     "warehouseId" TEXT;

-- CreateTable
CREATE TABLE "warehouses" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "branchId" TEXT,
    "address" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_balances" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "batchKey" TEXT NOT NULL DEFAULT '',
    "batchId" TEXT,
    "quantity" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "value" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_batches" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "batchNo" TEXT NOT NULL,
    "mfgDate" DATE,
    "expiryDate" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "item_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_serials" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "serialNo" TEXT NOT NULL,
    "status" "SerialStatus" NOT NULL DEFAULT 'IN_STOCK',
    "warehouseId" TEXT,
    "batchId" TEXT,
    "inMovementId" TEXT,
    "outMovementId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "item_serials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_cost_layers" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "batchKey" TEXT NOT NULL DEFAULT '',
    "movementId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "remaining" DECIMAL(14,3) NOT NULL,
    "unitCost" DECIMAL(14,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_cost_layers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_reservations" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_documents" (
    "id" TEXT NOT NULL,
    "type" "StockDocumentType" NOT NULL,
    "number" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "status" "StockDocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "warehouseId" TEXT NOT NULL,
    "toWarehouseId" TEXT,
    "companyId" TEXT,
    "purchaseOrderId" TEXT,
    "billId" TEXT,
    "reference" TEXT,
    "reason" TEXT,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "submittedById" TEXT,
    "submittedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "postedById" TEXT,
    "postedAt" TIMESTAMP(3),
    "dispatchedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_document_lines" (
    "id" TEXT NOT NULL,
    "stockDocumentId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "quantity" DECIMAL(14,3) NOT NULL,
    "orderedQty" DECIMAL(14,3),
    "receivedQty" DECIMAL(14,3),
    "rejectedQty" DECIMAL(14,3),
    "poLineId" TEXT,
    "systemQty" DECIMAL(14,3),
    "countedQty" DECIMAL(14,3),
    "unitCost" DECIMAL(14,4),
    "unit" TEXT,
    "batchId" TEXT,
    "batchNo" TEXT,
    "mfgDate" DATE,
    "expiryDate" DATE,
    "serialNumbers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "note" TEXT,

    CONSTRAINT "stock_document_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "units_of_measure" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "units_of_measure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_units" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "factor" DECIMAL(14,6) NOT NULL,

    CONSTRAINT "item_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_vouchers" (
    "id" TEXT NOT NULL,
    "type" "VoucherType" NOT NULL,
    "number" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "status" "VoucherStatus" NOT NULL DEFAULT 'DRAFT',
    "narration" TEXT NOT NULL,
    "reference" TEXT,
    "companyId" TEXT,
    "moneyAccountId" TEXT,
    "amount" DECIMAL(16,2) NOT NULL,
    "idempotencyKey" TEXT,
    "createdById" TEXT NOT NULL,
    "submittedById" TEXT,
    "submittedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "postedById" TEXT,
    "postedAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "reversedById" TEXT,
    "reversedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_vouchers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_voucher_lines" (
    "id" TEXT NOT NULL,
    "voucherId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "debit" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "companyId" TEXT,
    "departmentId" TEXT,
    "branchId" TEXT,
    "narration" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "account_voucher_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts_counters" (
    "series" TEXT NOT NULL,
    "financialYear" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "accounts_counters_pkey" PRIMARY KEY ("series","financialYear")
);

-- CreateTable
CREATE TABLE "accounts_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "inventoryAccounting" "InventoryAccounting" NOT NULL DEFAULT 'PERIODIC',
    "costingMethod" "CostingMethod" NOT NULL DEFAULT 'WEIGHTED_AVERAGE',
    "allowNegativeStock" BOOLEAN NOT NULL DEFAULT false,
    "invoiceIssuesStock" BOOLEAN NOT NULL DEFAULT false,
    "billReceivesStock" BOOLEAN NOT NULL DEFAULT false,
    "creditNoteReturnsStock" BOOLEAN NOT NULL DEFAULT false,
    "reserveOnOrderApproval" BOOLEAN NOT NULL DEFAULT false,
    "voucherApprovalRequired" BOOLEAN NOT NULL DEFAULT false,
    "adjustmentApprovalRequired" BOOLEAN NOT NULL DEFAULT true,
    "quantityDecimals" INTEGER NOT NULL DEFAULT 2,
    "defaultWarehouseId" TEXT,
    "seriesPrefixes" JSONB NOT NULL DEFAULT '{}',
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_code_key" ON "warehouses"("code");

-- CreateIndex
CREATE INDEX "stock_balances_warehouseId_idx" ON "stock_balances"("warehouseId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_balances_itemId_warehouseId_batchKey_key" ON "stock_balances"("itemId", "warehouseId", "batchKey");

-- CreateIndex
CREATE INDEX "item_batches_expiryDate_idx" ON "item_batches"("expiryDate");

-- CreateIndex
CREATE UNIQUE INDEX "item_batches_itemId_batchNo_key" ON "item_batches"("itemId", "batchNo");

-- CreateIndex
CREATE INDEX "item_serials_warehouseId_status_idx" ON "item_serials"("warehouseId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "item_serials_itemId_serialNo_key" ON "item_serials"("itemId", "serialNo");

-- CreateIndex
CREATE INDEX "stock_cost_layers_itemId_warehouseId_batchKey_receivedAt_idx" ON "stock_cost_layers"("itemId", "warehouseId", "batchKey", "receivedAt");

-- CreateIndex
CREATE INDEX "stock_reservations_itemId_warehouseId_status_idx" ON "stock_reservations"("itemId", "warehouseId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "stock_reservations_sourceType_sourceId_itemId_warehouseId_key" ON "stock_reservations"("sourceType", "sourceId", "itemId", "warehouseId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_documents_number_key" ON "stock_documents"("number");

-- CreateIndex
CREATE INDEX "stock_documents_type_date_idx" ON "stock_documents"("type", "date");

-- CreateIndex
CREATE INDEX "stock_documents_status_idx" ON "stock_documents"("status");

-- CreateIndex
CREATE INDEX "stock_documents_purchaseOrderId_idx" ON "stock_documents"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "stock_document_lines_stockDocumentId_idx" ON "stock_document_lines"("stockDocumentId");

-- CreateIndex
CREATE INDEX "stock_document_lines_itemId_idx" ON "stock_document_lines"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "units_of_measure_code_key" ON "units_of_measure"("code");

-- CreateIndex
CREATE UNIQUE INDEX "item_units_itemId_unit_key" ON "item_units"("itemId", "unit");

-- CreateIndex
CREATE UNIQUE INDEX "account_vouchers_number_key" ON "account_vouchers"("number");

-- CreateIndex
CREATE UNIQUE INDEX "account_vouchers_idempotencyKey_key" ON "account_vouchers"("idempotencyKey");

-- CreateIndex
CREATE INDEX "account_vouchers_type_date_idx" ON "account_vouchers"("type", "date");

-- CreateIndex
CREATE INDEX "account_vouchers_status_idx" ON "account_vouchers"("status");

-- CreateIndex
CREATE INDEX "account_voucher_lines_voucherId_idx" ON "account_voucher_lines"("voucherId");

-- CreateIndex
CREATE INDEX "account_voucher_lines_accountId_idx" ON "account_voucher_lines"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_postingKey_key" ON "journal_entries"("postingKey");

-- CreateIndex
CREATE INDEX "journal_entries_accountVoucherId_idx" ON "journal_entries"("accountVoucherId");

-- CreateIndex
CREATE INDEX "journal_entries_stockDocumentId_idx" ON "journal_entries"("stockDocumentId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_movements_idempotencyKey_key" ON "stock_movements"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "stock_movements_reversesId_key" ON "stock_movements"("reversesId");

-- CreateIndex
CREATE INDEX "stock_movements_itemId_warehouseId_movementDate_idx" ON "stock_movements"("itemId", "warehouseId", "movementDate");

-- CreateIndex
CREATE INDEX "stock_movements_movementDate_idx" ON "stock_movements"("movementDate");

-- CreateIndex
CREATE INDEX "stock_movements_sourceType_sourceId_idx" ON "stock_movements"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "stock_movements_tradeDocumentId_idx" ON "stock_movements"("tradeDocumentId");

-- AddForeignKey
ALTER TABLE "trade_documents" ADD CONSTRAINT "trade_documents_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "item_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tradeDocumentId_fkey" FOREIGN KEY ("tradeDocumentId") REFERENCES "trade_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_stockDocumentId_fkey" FOREIGN KEY ("stockDocumentId") REFERENCES "stock_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "stock_movements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "item_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_batches" ADD CONSTRAINT "item_batches_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_serials" ADD CONSTRAINT "item_serials_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_serials" ADD CONSTRAINT "item_serials_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_serials" ADD CONSTRAINT "item_serials_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "item_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_cost_layers" ADD CONSTRAINT "stock_cost_layers_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_cost_layers" ADD CONSTRAINT "stock_cost_layers_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_cost_layers" ADD CONSTRAINT "stock_cost_layers_movementId_fkey" FOREIGN KEY ("movementId") REFERENCES "stock_movements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_toWarehouseId_fkey" FOREIGN KEY ("toWarehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "trade_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_billId_fkey" FOREIGN KEY ("billId") REFERENCES "trade_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_document_lines" ADD CONSTRAINT "stock_document_lines_stockDocumentId_fkey" FOREIGN KEY ("stockDocumentId") REFERENCES "stock_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_document_lines" ADD CONSTRAINT "stock_document_lines_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_document_lines" ADD CONSTRAINT "stock_document_lines_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "item_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_units" ADD CONSTRAINT "item_units_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_accountVoucherId_fkey" FOREIGN KEY ("accountVoucherId") REFERENCES "account_vouchers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_stockDocumentId_fkey" FOREIGN KEY ("stockDocumentId") REFERENCES "stock_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_vouchers" ADD CONSTRAINT "account_vouchers_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_vouchers" ADD CONSTRAINT "account_vouchers_moneyAccountId_fkey" FOREIGN KEY ("moneyAccountId") REFERENCES "ledger_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_vouchers" ADD CONSTRAINT "account_vouchers_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_voucher_lines" ADD CONSTRAINT "account_voucher_lines_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "account_vouchers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_voucher_lines" ADD CONSTRAINT "account_voucher_lines_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Rules the database holds, beside the ones in code ─────────────────────────────────────────────

-- A voucher line is a debit or a credit, never both or neither, and never negative.
ALTER TABLE "account_voucher_lines" ADD CONSTRAINT "account_voucher_lines_one_side"
  CHECK ("debit" >= 0 AND "credit" >= 0 AND (("debit" = 0) <> ("credit" = 0)));
ALTER TABLE "accounts_settings" ADD CONSTRAINT "accounts_settings_quantity_decimals"
  CHECK ("quantityDecimals" BETWEEN 0 AND 3);
ALTER TABLE "stock_cost_layers" ADD CONSTRAINT "stock_cost_layers_remaining"
  CHECK ("remaining" >= 0 AND "remaining" <= "quantity");
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_positive" CHECK ("quantity" > 0);
ALTER TABLE "item_units" ADD CONSTRAINT "item_units_factor_positive" CHECK ("factor" > 0);

-- ── Existing stock into the main warehouse ───────────────────────────────────────────────────────

INSERT INTO "warehouses" ("id", "code", "name", "branchId", "isDefault", "active", "createdAt", "updatedAt")
SELECT 'wh_main', 'MAIN', 'Main warehouse',
       (SELECT b."id" FROM "branches" b WHERE b."isHeadOffice" ORDER BY b."createdAt" LIMIT 1),
       true, true, now(), now();

-- Every movement so far was recorded by hand, or as an item's opening stock, in the one place there was.
UPDATE "stock_movements" m
SET "warehouseId" = 'wh_main',
    "movementDate" = m."createdAt",
    "sourceType" = CASE WHEN m."reason" LIKE 'Opening stock%' THEN 'OPENING'::"StockSourceType" ELSE 'MANUAL'::"StockSourceType" END,
    "unitCost" = i."costPrice",
    "value" = CASE WHEN i."costPrice" IS NULL THEN NULL ELSE ROUND(m."quantityChange" * i."costPrice", 2) END
FROM "items" i
WHERE i."id" = m."itemId";

-- Where an item's movements don't add up to the stock it shows (a concurrent edit, a tracking switch), the
-- shown stock is kept and one movement brings the ledger level with it, so the two agree from here on.
INSERT INTO "stock_movements"
  ("id", "itemId", "type", "quantityChange", "reason", "createdByUserId", "createdAt",
   "warehouseId", "movementDate", "sourceType", "unitCost", "value", "idempotencyKey")
SELECT 'mig_' || i."id", i."id", 'ADJUSTMENT', i."stockQuantity" - COALESCE(s.total, 0),
       'Brought the stock ledger level with the item''s recorded stock when stock moved to warehouses',
       i."createdById", now(), 'wh_main', now(), 'MIGRATION', i."costPrice",
       CASE WHEN i."costPrice" IS NULL THEN NULL ELSE ROUND((i."stockQuantity" - COALESCE(s.total, 0)) * i."costPrice", 2) END,
       'migration:' || i."id"
FROM "items" i
LEFT JOIN (SELECT "itemId", SUM("quantityChange") AS total FROM "stock_movements" GROUP BY "itemId") s ON s."itemId" = i."id"
WHERE i."trackInventory" AND i."stockQuantity" <> COALESCE(s.total, 0);

INSERT INTO "stock_balances" ("id", "itemId", "warehouseId", "batchKey", "quantity", "value", "updatedAt")
SELECT 'sb_' || i."id", i."id", 'wh_main', '', i."stockQuantity",
       ROUND(i."stockQuantity" * COALESCE(i."costPrice", 0), 2), now()
FROM "items" i
WHERE i."trackInventory" AND i."stockQuantity" <> 0;

-- One cost layer for what is on hand, dated by its last receipt: what FIFO and stock aging start from.
INSERT INTO "stock_cost_layers" ("id", "itemId", "warehouseId", "batchKey", "movementId", "receivedAt", "quantity", "remaining", "unitCost", "createdAt")
SELECT 'cl_' || i."id", i."id", 'wh_main', '', NULL,
       COALESCE((SELECT MAX(m."createdAt") FROM "stock_movements" m WHERE m."itemId" = i."id" AND m."quantityChange" > 0), i."createdAt"),
       i."stockQuantity", i."stockQuantity", COALESCE(i."costPrice", 0), now()
FROM "items" i
WHERE i."trackInventory" AND i."stockQuantity" > 0;

-- ── The usual units of measure, by GST UQC code ──────────────────────────────────────────────────

INSERT INTO "units_of_measure" ("id", "code", "name", "decimals") VALUES
  ('uom_NOS', 'NOS', 'Numbers', 0),
  ('uom_PCS', 'PCS', 'Pieces', 0),
  ('uom_UNT', 'UNT', 'Units', 0),
  ('uom_SET', 'SET', 'Sets', 0),
  ('uom_BOX', 'BOX', 'Box', 0),
  ('uom_PAC', 'PAC', 'Packs', 0),
  ('uom_DOZ', 'DOZ', 'Dozens', 0),
  ('uom_PRS', 'PRS', 'Pairs', 0),
  ('uom_ROL', 'ROL', 'Rolls', 0),
  ('uom_KGS', 'KGS', 'Kilograms', 3),
  ('uom_GMS', 'GMS', 'Grams', 3),
  ('uom_TON', 'TON', 'Tonnes', 3),
  ('uom_LTR', 'LTR', 'Litres', 3),
  ('uom_MLT', 'MLT', 'Millilitres', 3),
  ('uom_MTR', 'MTR', 'Metres', 3),
  ('uom_SQM', 'SQM', 'Square metres', 3),
  ('uom_OTH', 'OTH', 'Others', 2)
ON CONFLICT ("code") DO NOTHING;

-- CreateEnum
CREATE TYPE "StatementBilling" AS ENUM ('MONTHLY', 'ANNUAL', 'ONE_OFF');

-- CreateEnum
CREATE TYPE "ReconcileState" AS ENUM ('MATCHED', 'QUANTITY_MISMATCH', 'PRICE_MISMATCH', 'BILLED_NOT_SOLD', 'UNKNOWN_SKU', 'UNKNOWN_CUSTOMER', 'AMBIGUOUS', 'SOLD_NOT_BILLED');

-- CreateEnum
CREATE TYPE "ReconcileSource" AS ENUM ('STATEMENT', 'OURS');

-- CreateTable
CREATE TABLE "vendor_statements" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "billing" "StatementBilling" NOT NULL DEFAULT 'MONTHLY',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "filename" TEXT NOT NULL,
    "lineCount" INTEGER NOT NULL,
    "totalBilled" DECIMAL(14,2) NOT NULL,
    "notes" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedById" TEXT,

    CONSTRAINT "vendor_statements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_statement_lines" (
    "id" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "source" "ReconcileSource" NOT NULL DEFAULT 'STATEMENT',
    "rowNumber" INTEGER,
    "sku" TEXT NOT NULL,
    "description" TEXT,
    "customerRef" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitCost" DECIMAL(12,2) NOT NULL,
    "lineTotal" DECIMAL(14,2) NOT NULL,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "raw" JSONB,
    "state" "ReconcileState" NOT NULL,
    "matchedOrderId" TEXT,
    "matchedCompanyId" TEXT,
    "variance" DECIMAL(14,2),
    "note" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolutionNote" TEXT,

    CONSTRAINT "vendor_statement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_statement_mappings" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "columns" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "vendor_statement_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vendor_statements_vendorId_periodStart_idx" ON "vendor_statements"("vendorId", "periodStart");

-- CreateIndex
CREATE INDEX "vendor_statement_lines_statementId_state_idx" ON "vendor_statement_lines"("statementId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_statement_mappings_vendorId_key" ON "vendor_statement_mappings"("vendorId");

-- AddForeignKey
ALTER TABLE "vendor_statements" ADD CONSTRAINT "vendor_statements_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_statements" ADD CONSTRAINT "vendor_statements_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_statement_lines" ADD CONSTRAINT "vendor_statement_lines_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "vendor_statements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_statement_lines" ADD CONSTRAINT "vendor_statement_lines_matchedOrderId_fkey" FOREIGN KEY ("matchedOrderId") REFERENCES "company_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_statement_lines" ADD CONSTRAINT "vendor_statement_lines_matchedCompanyId_fkey" FOREIGN KEY ("matchedCompanyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_statement_lines" ADD CONSTRAINT "vendor_statement_lines_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_statement_mappings" ADD CONSTRAINT "vendor_statement_mappings_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_statement_mappings" ADD CONSTRAINT "vendor_statement_mappings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

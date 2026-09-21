-- CreateEnum
CREATE TYPE "DepreciationMethod" AS ENUM ('STRAIGHT_LINE', 'WRITTEN_DOWN_VALUE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JournalSource" ADD VALUE 'PAYROLL';
ALTER TYPE "JournalSource" ADD VALUE 'DEPRECIATION';
ALTER TYPE "JournalSource" ADD VALUE 'CLOSING';
ALTER TYPE "JournalSource" ADD VALUE 'FX';

-- AlterTable
ALTER TABLE "journal_entries" ADD COLUMN     "payrollRunId" TEXT;

-- AlterTable
ALTER TABLE "journal_lines" ADD COLUMN     "departmentId" TEXT,
ADD COLUMN     "reconciledAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "bankAccountId" TEXT,
ADD COLUMN     "clearedOn" TIMESTAMP(3),
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'INR',
ADD COLUMN     "exchangeRate" DECIMAL(14,6) NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "trade_documents" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'INR',
ADD COLUMN     "exchangeRate" DECIMAL(14,6) NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "ledger_locks" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "lockedUntil" DATE,
    "note" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ledger_locks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fiscal_year_closes" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "fromDate" DATE NOT NULL,
    "toDate" DATE NOT NULL,
    "netProfit" DECIMAL(14,2) NOT NULL,
    "closingEntryId" TEXT,
    "closedById" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fiscal_year_closes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_accounts" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "bankName" TEXT,
    "accountNumber" TEXT,
    "ifsc" TEXT,
    "branch" TEXT,
    "ledgerAccountId" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_statement_lines" (
    "id" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "narration" TEXT NOT NULL,
    "reference" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "matchedLineId" TEXT,
    "matchedAt" TIMESTAMP(3),
    "matchedById" TEXT,
    "fingerprint" TEXT NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_statement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_reconciliations" (
    "id" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "statementDate" DATE NOT NULL,
    "statementBalance" DECIMAL(14,2) NOT NULL,
    "bookBalance" DECIMAL(14,2) NOT NULL,
    "difference" DECIMAL(14,2) NOT NULL,
    "note" TEXT,
    "completedById" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fixed_assets" (
    "id" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "purchasedOn" DATE NOT NULL,
    "cost" DECIMAL(14,2) NOT NULL,
    "salvageValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "usefulLifeYears" INTEGER NOT NULL DEFAULT 3,
    "method" "DepreciationMethod" NOT NULL DEFAULT 'STRAIGHT_LINE',
    "ratePercent" DECIMAL(5,2),
    "assetAccountId" TEXT NOT NULL,
    "accumulatedAccountId" TEXT,
    "vendorCompanyId" TEXT,
    "departmentId" TEXT,
    "custodianUserId" TEXT,
    "disposedOn" DATE,
    "disposalProceeds" DECIMAL(14,2),
    "disposalNote" TEXT,
    "disposalEntryId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fixed_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "depreciation_charges" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "fromDate" DATE NOT NULL,
    "toDate" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "entryId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "depreciation_charges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_year_closes_label_key" ON "fiscal_year_closes"("label");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_year_closes_closingEntryId_key" ON "fiscal_year_closes"("closingEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "bank_accounts_ledgerAccountId_key" ON "bank_accounts"("ledgerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_lines_matchedLineId_key" ON "bank_statement_lines"("matchedLineId");

-- CreateIndex
CREATE INDEX "bank_statement_lines_bankAccountId_date_idx" ON "bank_statement_lines"("bankAccountId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_lines_bankAccountId_fingerprint_key" ON "bank_statement_lines"("bankAccountId", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "bank_reconciliations_bankAccountId_statementDate_key" ON "bank_reconciliations"("bankAccountId", "statementDate");

-- CreateIndex
CREATE UNIQUE INDEX "fixed_assets_tag_key" ON "fixed_assets"("tag");

-- CreateIndex
CREATE UNIQUE INDEX "fixed_assets_disposalEntryId_key" ON "fixed_assets"("disposalEntryId");

-- CreateIndex
CREATE INDEX "fixed_assets_disposedOn_idx" ON "fixed_assets"("disposedOn");

-- CreateIndex
CREATE INDEX "fixed_assets_departmentId_idx" ON "fixed_assets"("departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "depreciation_charges_entryId_key" ON "depreciation_charges"("entryId");

-- CreateIndex
CREATE INDEX "depreciation_charges_toDate_idx" ON "depreciation_charges"("toDate");

-- CreateIndex
CREATE UNIQUE INDEX "depreciation_charges_assetId_toDate_key" ON "depreciation_charges"("assetId", "toDate");

-- CreateIndex
CREATE INDEX "journal_entries_payrollRunId_idx" ON "journal_entries"("payrollRunId");

-- CreateIndex
CREATE INDEX "journal_lines_departmentId_idx" ON "journal_lines"("departmentId");

-- CreateIndex
CREATE INDEX "journal_lines_accountId_reconciledAt_idx" ON "journal_lines"("accountId", "reconciledAt");

-- CreateIndex
CREATE INDEX "payments_bankAccountId_idx" ON "payments"("bankAccountId");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "bank_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "payroll_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_locks" ADD CONSTRAINT "ledger_locks_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_year_closes" ADD CONSTRAINT "fiscal_year_closes_closingEntryId_fkey" FOREIGN KEY ("closingEntryId") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_year_closes" ADD CONSTRAINT "fiscal_year_closes_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_ledgerAccountId_fkey" FOREIGN KEY ("ledgerAccountId") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "bank_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_matchedLineId_fkey" FOREIGN KEY ("matchedLineId") REFERENCES "journal_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_matchedById_fkey" FOREIGN KEY ("matchedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "bank_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_assetAccountId_fkey" FOREIGN KEY ("assetAccountId") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_accumulatedAccountId_fkey" FOREIGN KEY ("accumulatedAccountId") REFERENCES "ledger_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_vendorCompanyId_fkey" FOREIGN KEY ("vendorCompanyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_custodianUserId_fkey" FOREIGN KEY ("custodianUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_disposalEntryId_fkey" FOREIGN KEY ("disposalEntryId") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "depreciation_charges" ADD CONSTRAINT "depreciation_charges_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "fixed_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "depreciation_charges" ADD CONSTRAINT "depreciation_charges_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "depreciation_charges" ADD CONSTRAINT "depreciation_charges_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


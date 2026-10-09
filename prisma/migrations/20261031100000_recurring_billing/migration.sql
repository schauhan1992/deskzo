-- Recurring billing (owner, 9 Oct 2026): a subscription order can auto-renew at the end of its term
-- or be invoiced in instalments. Two new tables and three enum values; no existing table changes,
-- so a workspace not yet migrated reads exactly as before. Nothing recurs until somebody switches an
-- order on (src/lib/recurring-billing/run.ts).

-- CreateEnum
CREATE TYPE "RecurringBillingMode" AS ENUM ('AUTO_RENEW', 'INSTALMENTS');

-- AlterEnum
ALTER TYPE "DocumentOrigin" ADD VALUE 'RECURRING_BILLING';

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'RECURRING_DRAFTS_RAISED';

-- CreateTable
CREATE TABLE "recurring_billings" (
    "companyProductId" TEXT NOT NULL,
    "mode" "RecurringBillingMode" NOT NULL,
    "cycle" "BillingCycle",
    "billFrom" DATE,
    "setById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recurring_billings_pkey" PRIMARY KEY ("companyProductId")
);

-- CreateTable
CREATE TABLE "recurring_billing_periods" (
    "id" TEXT NOT NULL,
    "companyProductId" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "documentId" TEXT,
    "renewalOrderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recurring_billing_periods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recurring_billing_periods_documentId_idx" ON "recurring_billing_periods"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "recurring_billing_periods_companyProductId_periodStart_key" ON "recurring_billing_periods"("companyProductId", "periodStart");

-- AddForeignKey
ALTER TABLE "recurring_billings" ADD CONSTRAINT "recurring_billings_companyProductId_fkey" FOREIGN KEY ("companyProductId") REFERENCES "company_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_billings" ADD CONSTRAINT "recurring_billings_setById_fkey" FOREIGN KEY ("setById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_billing_periods" ADD CONSTRAINT "recurring_billing_periods_companyProductId_fkey" FOREIGN KEY ("companyProductId") REFERENCES "company_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_billing_periods" ADD CONSTRAINT "recurring_billing_periods_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "trade_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;


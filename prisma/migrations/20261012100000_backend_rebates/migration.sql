-- CreateEnum
CREATE TYPE "DealRegStatus" AS ENUM ('APPLIED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "RebateBasis" AS ENUM ('PURCHASE_VALUE', 'SALE_VALUE', 'AMOUNT');

-- CreateEnum
CREATE TYPE "RebatePayer" AS ENUM ('DISTRIBUTOR', 'OEM');

-- CreateEnum
CREATE TYPE "RebateSettlement" AS ENUM ('CREDIT_NOTE', 'PAYOUT');

-- CreateEnum
CREATE TYPE "VendorCreditKind" AS ENUM ('REBATE', 'PRICE_DIFFERENCE', 'OTHER');

-- AlterEnum
ALTER TYPE "JournalSource" ADD VALUE 'VENDOR_CREDIT';

-- AlterTable
ALTER TABLE "company_products" ADD COLUMN     "dealPrice" DECIMAL(12,2),
ADD COLUMN     "dealRegNumber" TEXT,
ADD COLUMN     "dealRegStatus" "DealRegStatus",
ADD COLUMN     "dealRegValidTo" DATE,
ADD COLUMN     "lossApprovalNote" TEXT,
ADD COLUMN     "lossApprovedAt" TIMESTAMP(3),
ADD COLUMN     "lossApprovedById" TEXT,
ADD COLUMN     "lossApprovedCost" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "journal_entries" ADD COLUMN     "vendorCreditId" TEXT;

-- CreateTable
CREATE TABLE "rebate_programmes" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brandId" TEXT,
    "vendorId" TEXT,
    "basis" "RebateBasis" NOT NULL DEFAULT 'PURCHASE_VALUE',
    "rate" DECIMAL(7,3) NOT NULL,
    "needsDealRegistration" BOOLEAN NOT NULL DEFAULT false,
    "payer" "RebatePayer" NOT NULL DEFAULT 'DISTRIBUTOR',
    "settlement" "RebateSettlement" NOT NULL DEFAULT 'CREDIT_NOTE',
    "validFrom" DATE,
    "validTo" DATE,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "rebate_programmes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_rebates" (
    "id" TEXT NOT NULL,
    "companyProductId" TEXT NOT NULL,
    "programmeId" TEXT,
    "basis" "RebateBasis" NOT NULL,
    "rate" DECIMAL(7,3),
    "amount" DECIMAL(14,2),
    "payer" "RebatePayer" NOT NULL,
    "payerCompanyId" TEXT,
    "settlement" "RebateSettlement" NOT NULL,
    "note" TEXT,
    "writtenOffAt" TIMESTAMP(3),
    "writtenOffById" TEXT,
    "writeOffReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_rebates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_credits" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "form" "RebateSettlement" NOT NULL,
    "kind" "VendorCreditKind" NOT NULL DEFAULT 'REBATE',
    "reference" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "taxableAmount" DECIMAL(14,2) NOT NULL,
    "cgstAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "sgstAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "igstAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL,
    "bankAccountId" TEXT,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelReason" TEXT,

    CONSTRAINT "vendor_credits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rebate_allocations" (
    "id" TEXT NOT NULL,
    "vendorCreditId" TEXT NOT NULL,
    "orderRebateId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "rebate_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_credit_applications" (
    "id" TEXT NOT NULL,
    "vendorCreditId" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "vendor_credit_applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rebate_programmes_brandId_idx" ON "rebate_programmes"("brandId");

-- CreateIndex
CREATE INDEX "rebate_programmes_vendorId_idx" ON "rebate_programmes"("vendorId");

-- CreateIndex
CREATE INDEX "order_rebates_companyProductId_idx" ON "order_rebates"("companyProductId");

-- CreateIndex
CREATE INDEX "order_rebates_payerCompanyId_idx" ON "order_rebates"("payerCompanyId");

-- CreateIndex
CREATE INDEX "vendor_credits_date_idx" ON "vendor_credits"("date");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_credits_vendorId_reference_key" ON "vendor_credits"("vendorId", "reference");

-- CreateIndex
CREATE INDEX "rebate_allocations_orderRebateId_idx" ON "rebate_allocations"("orderRebateId");

-- CreateIndex
CREATE UNIQUE INDEX "rebate_allocations_vendorCreditId_orderRebateId_key" ON "rebate_allocations"("vendorCreditId", "orderRebateId");

-- CreateIndex
CREATE INDEX "vendor_credit_applications_billId_idx" ON "vendor_credit_applications"("billId");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_credit_applications_vendorCreditId_billId_key" ON "vendor_credit_applications"("vendorCreditId", "billId");

-- AddForeignKey
ALTER TABLE "company_products" ADD CONSTRAINT "company_products_lossApprovedById_fkey" FOREIGN KEY ("lossApprovedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rebate_programmes" ADD CONSTRAINT "rebate_programmes_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rebate_programmes" ADD CONSTRAINT "rebate_programmes_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rebate_programmes" ADD CONSTRAINT "rebate_programmes_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_rebates" ADD CONSTRAINT "order_rebates_companyProductId_fkey" FOREIGN KEY ("companyProductId") REFERENCES "company_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_rebates" ADD CONSTRAINT "order_rebates_programmeId_fkey" FOREIGN KEY ("programmeId") REFERENCES "rebate_programmes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_rebates" ADD CONSTRAINT "order_rebates_payerCompanyId_fkey" FOREIGN KEY ("payerCompanyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_rebates" ADD CONSTRAINT "order_rebates_writtenOffById_fkey" FOREIGN KEY ("writtenOffById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_rebates" ADD CONSTRAINT "order_rebates_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_credits" ADD CONSTRAINT "vendor_credits_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_credits" ADD CONSTRAINT "vendor_credits_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "bank_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_credits" ADD CONSTRAINT "vendor_credits_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_credits" ADD CONSTRAINT "vendor_credits_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rebate_allocations" ADD CONSTRAINT "rebate_allocations_vendorCreditId_fkey" FOREIGN KEY ("vendorCreditId") REFERENCES "vendor_credits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rebate_allocations" ADD CONSTRAINT "rebate_allocations_orderRebateId_fkey" FOREIGN KEY ("orderRebateId") REFERENCES "order_rebates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rebate_allocations" ADD CONSTRAINT "rebate_allocations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_credit_applications" ADD CONSTRAINT "vendor_credit_applications_vendorCreditId_fkey" FOREIGN KEY ("vendorCreditId") REFERENCES "vendor_credits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_credit_applications" ADD CONSTRAINT "vendor_credit_applications_billId_fkey" FOREIGN KEY ("billId") REFERENCES "trade_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_credit_applications" ADD CONSTRAINT "vendor_credit_applications_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_vendorCreditId_fkey" FOREIGN KEY ("vendorCreditId") REFERENCES "vendor_credits"("id") ON DELETE SET NULL ON UPDATE CASCADE;


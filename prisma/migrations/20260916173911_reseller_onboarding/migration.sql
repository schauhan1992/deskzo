-- CreateEnum
CREATE TYPE "ResellerOnboardingStatus" AS ENUM ('ONBOARDING', 'ACTIVE', 'SUSPENDED', 'INACTIVE');

-- CreateEnum
CREATE TYPE "ResellerTier" AS ENUM ('SILVER', 'GOLD', 'PLATINUM');

-- CreateTable
CREATE TABLE "reseller_profiles" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "status" "ResellerOnboardingStatus" NOT NULL DEFAULT 'ONBOARDING',
    "agreementSignedOn" TIMESTAMP(3),
    "agreementReference" TEXT,
    "agreementApprovedByUserId" TEXT,
    "creditLimit" DECIMAL(12,2),
    "tier" "ResellerTier",
    "discountPercent" DECIMAL(5,2),
    "activatedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reseller_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reseller_item_prices" (
    "id" TEXT NOT NULL,
    "resellerId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reseller_item_prices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reseller_profiles_companyId_key" ON "reseller_profiles"("companyId");

-- CreateIndex
CREATE INDEX "reseller_item_prices_resellerId_idx" ON "reseller_item_prices"("resellerId");

-- CreateIndex
CREATE INDEX "reseller_item_prices_itemId_idx" ON "reseller_item_prices"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "reseller_item_prices_resellerId_itemId_key" ON "reseller_item_prices"("resellerId", "itemId");

-- AddForeignKey
ALTER TABLE "reseller_profiles" ADD CONSTRAINT "reseller_profiles_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reseller_profiles" ADD CONSTRAINT "reseller_profiles_agreementApprovedByUserId_fkey" FOREIGN KEY ("agreementApprovedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reseller_item_prices" ADD CONSTRAINT "reseller_item_prices_resellerId_fkey" FOREIGN KEY ("resellerId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reseller_item_prices" ADD CONSTRAINT "reseller_item_prices_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

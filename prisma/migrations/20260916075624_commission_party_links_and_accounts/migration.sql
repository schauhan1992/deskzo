-- AlterTable
ALTER TABLE "order_expenses" ADD COLUMN     "payeeAccountId" TEXT;

-- CreateTable
CREATE TABLE "commission_party_links" (
    "id" TEXT NOT NULL,
    "commissionPartyId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commission_party_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_party_accounts" (
    "id" TEXT NOT NULL,
    "commissionPartyId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "accountHolderName" TEXT,
    "panNumber" TEXT,
    "bankAccountNumber" TEXT,
    "bankIfsc" TEXT,
    "bankName" TEXT,
    "upiId" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commission_party_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "commission_party_links_commissionPartyId_idx" ON "commission_party_links"("commissionPartyId");

-- CreateIndex
CREATE INDEX "commission_party_links_companyId_idx" ON "commission_party_links"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "commission_party_links_commissionPartyId_companyId_key" ON "commission_party_links"("commissionPartyId", "companyId");

-- CreateIndex
CREATE INDEX "commission_party_accounts_commissionPartyId_idx" ON "commission_party_accounts"("commissionPartyId");

-- CreateIndex
CREATE INDEX "order_expenses_payeeAccountId_idx" ON "order_expenses"("payeeAccountId");

-- AddForeignKey
ALTER TABLE "commission_party_links" ADD CONSTRAINT "commission_party_links_commissionPartyId_fkey" FOREIGN KEY ("commissionPartyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_party_links" ADD CONSTRAINT "commission_party_links_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_party_accounts" ADD CONSTRAINT "commission_party_accounts_commissionPartyId_fkey" FOREIGN KEY ("commissionPartyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_expenses" ADD CONSTRAINT "order_expenses_payeeAccountId_fkey" FOREIGN KEY ("payeeAccountId") REFERENCES "commission_party_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

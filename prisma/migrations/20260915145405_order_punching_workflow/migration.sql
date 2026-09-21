-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'PROCESSING', 'FULFILLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderExpenseType" AS ENUM ('COMMISSION', 'FREIGHT', 'INSTALLATION', 'OTHER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'ORDER_STATUS_CHANGED';
ALTER TYPE "NotificationType" ADD VALUE 'ORDER_WATCHER_ADDED';

-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'PURCHASE';

-- AlterTable
ALTER TABLE "company_products" ADD COLUMN     "accountsApprovedAt" TIMESTAMP(3),
ADD COLUMN     "accountsApprovedByUserId" TEXT,
ADD COLUMN     "accountsNotes" TEXT,
ADD COLUMN     "fulfilledAt" TIMESTAMP(3),
ADD COLUMN     "orderStatus" "OrderStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
ADD COLUMN     "ourPoNumber" TEXT,
ADD COLUMN     "paymentTerms" "PaymentTerms",
ADD COLUMN     "proposalId" TEXT,
ADD COLUMN     "purchasePrice" DECIMAL(12,2),
ADD COLUMN     "purchasedByUserId" TEXT,
ADD COLUMN     "unitPrice" DECIMAL(12,2);

-- CreateTable
CREATE TABLE "order_expenses" (
    "id" TEXT NOT NULL,
    "companyProductId" TEXT NOT NULL,
    "type" "OrderExpenseType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_OrderWatchers" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_OrderWatchers_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "order_expenses_companyProductId_idx" ON "order_expenses"("companyProductId");

-- CreateIndex
CREATE INDEX "_OrderWatchers_B_index" ON "_OrderWatchers"("B");

-- CreateIndex
CREATE INDEX "company_products_orderStatus_idx" ON "company_products"("orderStatus");

-- AddForeignKey
ALTER TABLE "company_products" ADD CONSTRAINT "company_products_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "proposals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_products" ADD CONSTRAINT "company_products_accountsApprovedByUserId_fkey" FOREIGN KEY ("accountsApprovedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_products" ADD CONSTRAINT "company_products_purchasedByUserId_fkey" FOREIGN KEY ("purchasedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_expenses" ADD CONSTRAINT "order_expenses_companyProductId_fkey" FOREIGN KEY ("companyProductId") REFERENCES "company_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_OrderWatchers" ADD CONSTRAINT "_OrderWatchers_A_fkey" FOREIGN KEY ("A") REFERENCES "company_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_OrderWatchers" ADD CONSTRAINT "_OrderWatchers_B_fkey" FOREIGN KEY ("B") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

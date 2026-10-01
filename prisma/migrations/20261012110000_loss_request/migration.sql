-- AlterTable
ALTER TABLE "company_products" ADD COLUMN     "lossRequestedAt" TIMESTAMP(3),
ADD COLUMN     "lossRequestedCost" DECIMAL(12,2);

-- AlterEnum
ALTER TYPE "OrderBusinessType" ADD VALUE 'ADDON';

-- AlterTable
ALTER TABLE "company_products" ADD COLUMN     "fullTermDays" INTEGER,
ADD COLUMN     "fullTermUnitPrice" DECIMAL(12,2),
ADD COLUMN     "parentId" TEXT,
ADD COLUMN     "proRataDays" INTEGER;

-- CreateIndex
CREATE INDEX "company_products_parentId_idx" ON "company_products"("parentId");

-- AddForeignKey
ALTER TABLE "company_products" ADD CONSTRAINT "company_products_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "company_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;


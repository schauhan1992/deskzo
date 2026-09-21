-- AlterTable
ALTER TABLE "company_products" ADD COLUMN     "endDate" TIMESTAMP(3),
ADD COLUMN     "startDate" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "company_products_endDate_idx" ON "company_products"("endDate");

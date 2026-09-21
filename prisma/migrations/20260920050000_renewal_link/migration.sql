-- AlterTable
ALTER TABLE "company_products" ADD COLUMN     "renewedFromId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "company_products_renewedFromId_key" ON "company_products"("renewedFromId");

-- AddForeignKey
ALTER TABLE "company_products" ADD CONSTRAINT "company_products_renewedFromId_fkey" FOREIGN KEY ("renewedFromId") REFERENCES "company_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- AlterTable
ALTER TABLE "company_products" ADD COLUMN     "vendorId" TEXT;

-- CreateIndex
CREATE INDEX "company_products_vendorId_idx" ON "company_products"("vendorId");

-- AddForeignKey
ALTER TABLE "company_products" ADD CONSTRAINT "company_products_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterEnum
ALTER TYPE "CompanyRelationshipType" ADD VALUE 'RESELLER';

-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "managedByResellerId" TEXT;

-- AlterTable
ALTER TABLE "company_products" ADD COLUMN     "endCustomerId" TEXT;

-- CreateIndex
CREATE INDEX "companies_managedByResellerId_idx" ON "companies"("managedByResellerId");

-- CreateIndex
CREATE INDEX "company_products_endCustomerId_idx" ON "company_products"("endCustomerId");

-- AddForeignKey
ALTER TABLE "companies" ADD CONSTRAINT "companies_managedByResellerId_fkey" FOREIGN KEY ("managedByResellerId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_products" ADD CONSTRAINT "company_products_endCustomerId_fkey" FOREIGN KEY ("endCustomerId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

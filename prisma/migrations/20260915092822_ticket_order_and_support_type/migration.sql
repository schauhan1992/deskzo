-- CreateEnum
CREATE TYPE "TicketType" AS ENUM ('PRODUCT_SUPPORT', 'DEMO', 'INSTALLATION', 'TRAINING', 'OTHER');

-- AlterTable
ALTER TABLE "tickets" ADD COLUMN     "companyProductId" TEXT,
ADD COLUMN     "ticketType" "TicketType" NOT NULL DEFAULT 'PRODUCT_SUPPORT';

-- CreateIndex
CREATE INDEX "tickets_companyProductId_idx" ON "tickets"("companyProductId");

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_companyProductId_fkey" FOREIGN KEY ("companyProductId") REFERENCES "company_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

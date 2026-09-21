-- RenameColumn (manual "Order ID" field becomes the manual "PO / Invoice number" field)
ALTER TABLE "company_products" RENAME COLUMN "orderId" TO "poNumber";

-- AlterTable: add an auto-generated, always-unique order sequence backing the system-generated Order ID
ALTER TABLE "company_products" ADD COLUMN "orderSeq" SERIAL NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "company_products_orderSeq_key" ON "company_products"("orderSeq");

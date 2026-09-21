-- CreateTable
CREATE TABLE "company_products" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "notes" TEXT,
    "addedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_products_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "company_products_companyId_idx" ON "company_products"("companyId");

-- CreateIndex
CREATE INDEX "company_products_itemId_idx" ON "company_products"("itemId");

-- AddForeignKey
ALTER TABLE "company_products" ADD CONSTRAINT "company_products_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_products" ADD CONSTRAINT "company_products_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_products" ADD CONSTRAINT "company_products_addedByUserId_fkey" FOREIGN KEY ("addedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

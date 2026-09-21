-- The Orders list sorts every row by createdAt with no filter, and there was no index to walk.
CREATE INDEX "company_products_createdAt_idx" ON "company_products"("createdAt");

-- Products: a plan says which product it sells (src/lib/products.ts), so a workspace can hold several
-- products — one plan each — instead of one edition.

-- AlterTable
ALTER TABLE "plans" ADD COLUMN     "productKey" TEXT;

-- CreateIndex
CREATE INDEX "plans_productKey_idx" ON "plans"("productKey");


-- Written by hand: a product key is a lower-case word, as src/lib/products.ts writes them.
ALTER TABLE "plans" ADD CONSTRAINT "plans_product_key_shape" CHECK ("productKey" IS NULL OR "productKey" ~ '^[a-z][a-z0-9_]{1,30}$');

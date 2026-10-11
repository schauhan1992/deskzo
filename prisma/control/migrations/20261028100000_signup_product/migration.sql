-- Starting with one product (owner, 11 Oct 2026): a product page's "Start free trial" goes to /signup?product=books,
-- and the signup keeps the product the visitor chose, so the workspace starts on that product's trial plan
-- (deskzo-<product>, src/lib/platform/product-plans.ts) rather than the default. A key from src/lib/products.ts;
-- the code checks it, the database only that it is short.
ALTER TABLE "pending_signups" ADD COLUMN "productKey" TEXT;
ALTER TABLE "pending_signups" ADD CONSTRAINT "pending_signups_productKey_check" CHECK ("productKey" IS NULL OR length("productKey") <= 40);

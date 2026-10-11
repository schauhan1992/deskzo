-- A demo of one product (owner, 11 Oct 2026): a product page's "Book a demo" goes to /contact?topic=demo&product=books,
-- the form says which product, and the lead keeps it for the leads inbox, its export and the mail to sales. A key from
-- src/lib/products.ts; the code checks it, the database only that it is short. None: no product named.
ALTER TABLE "site_leads" ADD COLUMN "productKey" TEXT;
ALTER TABLE "site_leads" ADD CONSTRAINT "site_leads_productKey_check" CHECK ("productKey" IS NULL OR length("productKey") <= 40);

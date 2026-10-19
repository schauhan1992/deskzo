-- One company, two roles (19 Oct 2026): a vendor who also buys from us, or a customer we also buy from, and
-- who looks after the side that was added. Everybody has one role until somebody adds the other.
ALTER TABLE "companies" ADD COLUMN "alsoCustomer" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "companies" ADD COLUMN "alsoVendor" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "companies" ADD COLUMN "sideOwnerUserId" TEXT;

CREATE INDEX "companies_sideOwnerUserId_idx" ON "companies"("sideOwnerUserId");

ALTER TABLE "companies" ADD CONSTRAINT "companies_sideOwnerUserId_fkey" FOREIGN KEY ("sideOwnerUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A document's salesperson: who owns the deal, not whoever keyed the record in.
ALTER TABLE "trade_documents" ADD COLUMN "salespersonId" TEXT;

-- Existing documents inherit the account's owner, falling back to whoever created them, so the
-- new column reads as the truth we already had rather than starting out blank everywhere.
UPDATE "trade_documents" d
SET "salespersonId" = COALESCE(c."ownerUserId", d."createdById")
FROM "companies" c
WHERE c."id" = d."companyId";

CREATE INDEX "trade_documents_salespersonId_idx" ON "trade_documents"("salespersonId");

ALTER TABLE "trade_documents"
  ADD CONSTRAINT "trade_documents_salespersonId_fkey"
  FOREIGN KEY ("salespersonId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

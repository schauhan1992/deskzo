-- CreateEnum
CREATE TYPE "DocumentOrigin" AS ENUM ('MANUAL', 'CONVERSION', 'ADDON_CALCULATOR', 'RENEWAL', 'CONSIGNMENT');

-- AlterTable
ALTER TABLE "trade_documents" ADD COLUMN     "origin" "DocumentOrigin";

-- Backfill.
--
-- Every document that existed before this migration can be placed exactly, because until now there
-- were only three ways to make one: converting another document, dispatching a consignment, or
-- typing it into the form. The add-on and renewal buttons are newer than this column, so nothing
-- historical can have come from them.
--
-- Worth doing rather than leaving null: a Source column that reads "not recorded" for the entire
-- back catalogue is a column nobody looks at twice.

-- Ordered most specific first, and each step skips rows already placed.
UPDATE "trade_documents" SET "origin" = 'CONVERSION'
 WHERE "sourceDocumentId" IS NOT NULL;

UPDATE "trade_documents" SET "origin" = 'CONSIGNMENT'
 WHERE "origin" IS NULL
   AND "id" IN (SELECT "documentId" FROM "consignments" WHERE "documentId" IS NOT NULL);

UPDATE "trade_documents" SET "origin" = 'MANUAL'
 WHERE "origin" IS NULL;

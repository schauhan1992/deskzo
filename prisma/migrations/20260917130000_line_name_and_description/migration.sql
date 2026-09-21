-- `description` held the item's name. Renamed to say so, and a real description column added
-- beside it for the free text a quote usually carries under the name.
ALTER TABLE "trade_document_lines" RENAME COLUMN "description" TO "name";
ALTER TABLE "trade_document_lines" ADD COLUMN "description" TEXT;

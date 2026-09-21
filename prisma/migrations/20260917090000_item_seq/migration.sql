-- Human-readable catalog number. SERIAL backfills existing rows in insertion order, so every
-- item already in the catalog gets a number without a separate data migration.
ALTER TABLE "items" ADD COLUMN "itemSeq" SERIAL NOT NULL;
CREATE UNIQUE INDEX "items_itemSeq_key" ON "items"("itemSeq");

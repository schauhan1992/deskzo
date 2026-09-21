-- Whether a statement is everything the vendor billed, or a few lines entered to check one thing.
-- Existing rows were whole files, so the default is right for them.
ALTER TABLE "vendor_statements" ADD COLUMN "complete" BOOLEAN NOT NULL DEFAULT true;

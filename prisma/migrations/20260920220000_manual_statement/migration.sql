-- A statement can be typed in rather than uploaded, and then there is no file to name.
ALTER TABLE "vendor_statements" ALTER COLUMN "filename" DROP NOT NULL;

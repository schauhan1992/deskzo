-- The watermark only on the pages that show customers' details (owner, 2 Oct 2026) — the default for every
-- workspace, existing ones included — unless a workspace wants it on every page.
CREATE TYPE "WatermarkScope" AS ENUM ('CUSTOMER_DATA', 'EVERY_PAGE');
ALTER TABLE "security_policy" ADD COLUMN "watermarkScope" "WatermarkScope" NOT NULL DEFAULT 'CUSTOMER_DATA';

-- A short, sayable number for a company: COM-000123.
--
-- Written by hand rather than generated, for the backfill. Prisma's `ADD COLUMN ... SERIAL` fills
-- existing rows in whatever order the table happens to scan — effectively arbitrary, and unstable
-- across a dump and restore. Numbering in creation order instead makes COM-000001 the oldest
-- account on the books, which is the only ordering anybody would expect the number to mean.

-- 1. Nullable to begin with, so the backfill has somewhere to land.
ALTER TABLE "companies" ADD COLUMN "companySeq" INTEGER;

-- 2. Oldest first. `id` breaks ties so the result is deterministic — several companies share a
--    createdAt to the millisecond where they arrived in one import.
WITH ordered AS (
  SELECT "id", ROW_NUMBER() OVER (ORDER BY "createdAt" ASC, "id" ASC) AS seq
    FROM "companies"
)
UPDATE "companies" AS c
   SET "companySeq" = o.seq
  FROM ordered AS o
 WHERE c."id" = o."id";

-- 3. The sequence that hands out the next one. This is exactly what SERIAL expands to, so
--    `prisma migrate diff` sees no drift between this and `@default(autoincrement())`.
CREATE SEQUENCE "companies_companySeq_seq" AS INTEGER OWNED BY "companies"."companySeq";
SELECT setval(
  '"companies_companySeq_seq"',
  COALESCE((SELECT MAX("companySeq") FROM "companies"), 0) + 1,
  false
);
ALTER TABLE "companies" ALTER COLUMN "companySeq" SET DEFAULT nextval('"companies_companySeq_seq"');
ALTER TABLE "companies" ALTER COLUMN "companySeq" SET NOT NULL;

CREATE UNIQUE INDEX "companies_companySeq_key" ON "companies"("companySeq");

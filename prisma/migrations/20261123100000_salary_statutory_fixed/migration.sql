-- PF, ESI and TDS typed at the CTC split (owner, 23 Oct 2026): HR can fix any of the five monthly figures on a salary
-- structure over Deskzo's own. Additive: a structure without them is worked out exactly as before, and no payslip
-- changes until its month is calculated again. Postgres can't drop an enum value, so undoing it means leaving
-- FIXED unused and the column empty.

-- AlterTable
ALTER TABLE "salary_structures" ADD COLUMN "statutoryFixed" JSONB;

-- AlterEnum
ALTER TYPE "IncomeTaxBasis" ADD VALUE 'FIXED';

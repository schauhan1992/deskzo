-- Opening leave balances for a company moving to Deskzo mid-year (owner, 17 Oct 2026): what each person
-- carried into the year from the old system, and what they took this year before Deskzo. Expand-only;
-- the columns are in NOT_YET_EVERYWHERE (src/lib/tenancy/clients.ts) until every workspace has them.

-- AlterTable
ALTER TABLE "leave_balances" ADD COLUMN     "openingNote" TEXT,
ADD COLUMN     "openingTyped" DECIMAL(5,2),
ADD COLUMN     "usedBefore" DECIMAL(5,2) NOT NULL DEFAULT 0;

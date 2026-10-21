-- Salary structures (owner, 21 Oct 2026): a CTC split by the company's own rules, the company's own pay
-- components besides the six built in, and a revision given as a percentage, an amount or a new CTC.
CREATE TYPE "SalaryRevisionBasis" AS ENUM ('PERCENT', 'AMOUNT', 'CTC');
CREATE TYPE "SalaryComponentMode" AS ENUM ('FIXED', 'PERCENT_OF_BASIC');

ALTER TABLE "salary_structures" ADD COLUMN "annualCtc" DECIMAL(14,2),
ADD COLUMN "customComponents" JSONB,
ADD COLUMN "revisionBasis" "SalaryRevisionBasis",
ADD COLUMN "revisionValue" DECIMAL(14,2);

ALTER TABLE "payslips" ADD COLUMN "customEarnings" JSONB;

CREATE TABLE "salary_components" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mode" "SalaryComponentMode" NOT NULL DEFAULT 'FIXED',
    "value" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "salary_components_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "salary_components_name_key" ON "salary_components"("name");

CREATE TABLE "salary_split_rules" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "basicPercent" DECIMAL(5,2) NOT NULL DEFAULT 40,
    "hraPercent" DECIMAL(5,2) NOT NULL DEFAULT 50,
    "conveyance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "medical" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "salary_split_rules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "salary_split_rules_percent_check" CHECK ("basicPercent" > 0 AND "basicPercent" <= 100 AND "hraPercent" >= 0 AND "hraPercent" <= 100 AND "conveyance" >= 0 AND "medical" >= 0)
);

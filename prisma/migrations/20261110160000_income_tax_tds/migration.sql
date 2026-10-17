-- TDS on salary worked out by Deskzo (owner, 17 Oct 2026): each person's tax declaration for a tax year,
-- and on a payslip whether its income tax was worked out or typed, and how. Expand-only; the payslip
-- columns are in NOT_YET_EVERYWHERE (src/lib/tenancy/clients.ts) until every workspace has them.

-- CreateEnum
CREATE TYPE "IncomeTaxBasis" AS ENUM ('WORKED_OUT', 'TYPED');

-- CreateEnum
CREATE TYPE "TaxRegime" AS ENUM ('NEW', 'OLD');

-- AlterTable
ALTER TABLE "payslips" ADD COLUMN     "incomeTaxBasis" "IncomeTaxBasis",
ADD COLUMN     "taxWorking" JSONB;

-- CreateTable
CREATE TABLE "tax_declarations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "taxYear" INTEGER NOT NULL,
    "regime" "TaxRegime" NOT NULL DEFAULT 'NEW',
    "hraExemption" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "section80C" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "section80CCD1B" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "section80D" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "homeLoanInterest" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "otherDeductions" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "previousGross" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "previousTds" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "previousPt" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "previousPf" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "otherIncome" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "otherTds" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "note" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_declarations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tax_declarations_userId_taxYear_key" ON "tax_declarations"("userId", "taxYear");

-- AddForeignKey
ALTER TABLE "tax_declarations" ADD CONSTRAINT "tax_declarations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


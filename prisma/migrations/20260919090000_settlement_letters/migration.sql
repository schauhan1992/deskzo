-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('DRAFT', 'APPROVED', 'PAID');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LetterType" ADD VALUE 'INTERNSHIP';
ALTER TYPE "LetterType" ADD VALUE 'CONTRACT_AGREEMENT';
ALTER TYPE "LetterType" ADD VALUE 'PROBATION_EXTENSION';
ALTER TYPE "LetterType" ADD VALUE 'INCREMENT';
ALTER TYPE "LetterType" ADD VALUE 'PROMOTION';
ALTER TYPE "LetterType" ADD VALUE 'TRANSFER';
ALTER TYPE "LetterType" ADD VALUE 'WARNING';
ALTER TYPE "LetterType" ADD VALUE 'APPRECIATION';
ALTER TYPE "LetterType" ADD VALUE 'MATERNITY_LEAVE';
ALTER TYPE "LetterType" ADD VALUE 'TRAVEL_NOC';
ALTER TYPE "LetterType" ADD VALUE 'EMPLOYMENT_VERIFICATION';
ALTER TYPE "LetterType" ADD VALUE 'RESIGNATION_ACCEPTANCE';
ALTER TYPE "LetterType" ADD VALUE 'TERMINATION';
ALTER TYPE "LetterType" ADD VALUE 'NO_DUES';
ALTER TYPE "LetterType" ADD VALUE 'INTERNSHIP_COMPLETION';
ALTER TYPE "LetterType" ADD VALUE 'GRATUITY_STATEMENT';

-- AlterTable
ALTER TABLE "employee_profiles" ADD COLUMN     "noticePeriodDays" INTEGER NOT NULL DEFAULT 30;

-- AlterTable
ALTER TABLE "leave_types" ADD COLUMN     "encashable" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "final_settlements" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lastWorkingDay" DATE NOT NULL,
    "serviceYears" DECIMAL(5,2) NOT NULL,
    "salaryDays" DECIMAL(5,2) NOT NULL,
    "salaryAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "leaveEncashDays" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "leaveEncashAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "gratuityAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "gratuityNote" TEXT,
    "bonusAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "otherEarnings" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "otherEarningsNote" TEXT,
    "grossPayable" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "noticeShortfallDays" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "noticeRecovery" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "pfDeduction" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "professionalTax" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "incomeTax" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "advanceRecovery" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "assetRecovery" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "otherDeduction" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "otherDeductionNote" TEXT,
    "totalDeductions" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "netPayable" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" "SettlementStatus" NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "final_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "final_settlements_userId_key" ON "final_settlements"("userId");

-- AddForeignKey
ALTER TABLE "final_settlements" ADD CONSTRAINT "final_settlements_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "final_settlements" ADD CONSTRAINT "final_settlements_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "final_settlements" ADD CONSTRAINT "final_settlements_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


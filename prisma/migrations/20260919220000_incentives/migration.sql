-- CreateEnum
CREATE TYPE "IncentiveBasis" AS ENUM ('PERCENT_OF_ACHIEVEMENT', 'PERCENT_OF_TARGET', 'FIXED_ON_ACHIEVEMENT', 'PER_UNIT', 'SLAB');

-- CreateEnum
CREATE TYPE "IncentiveStatus" AS ENUM ('DUE', 'APPROVED', 'PAID', 'HELD', 'CANCELLED');

-- AlterTable
ALTER TABLE "payslips" ADD COLUMN     "incentive" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "targets" ADD COLUMN     "incentiveSchemeId" TEXT;

-- CreateTable
CREATE TABLE "incentive_schemes" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "metric" "TargetMetric" NOT NULL,
    "basis" "IncentiveBasis" NOT NULL,
    "thresholdPercent" DECIMAL(6,2),
    "ratePercent" DECIMAL(6,3),
    "fixedAmount" DECIMAL(14,2),
    "perUnitAmount" DECIMAL(14,2),
    "capAmount" DECIMAL(14,2),
    "requiresCollection" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "incentive_schemes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incentive_slabs" (
    "id" TEXT NOT NULL,
    "schemeId" TEXT NOT NULL,
    "fromPercent" DECIMAL(6,2) NOT NULL,
    "toPercent" DECIMAL(6,2),
    "ratePercent" DECIMAL(6,3),
    "fixedAmount" DECIMAL(14,2),

    CONSTRAINT "incentive_slabs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incentive_earnings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "targetId" TEXT,
    "schemeId" TEXT,
    "metric" "TargetMetric",
    "fromDate" DATE NOT NULL,
    "toDate" DATE NOT NULL,
    "label" TEXT NOT NULL,
    "targetValue" DECIMAL(14,2),
    "achievedValue" DECIMAL(14,2),
    "achievedPercent" DECIMAL(8,2),
    "amount" DECIMAL(14,2) NOT NULL,
    "workings" TEXT NOT NULL,
    "status" "IncentiveStatus" NOT NULL DEFAULT 'DUE',
    "heldReason" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "payslipId" TEXT,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "incentive_earnings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "incentive_schemes_metric_active_idx" ON "incentive_schemes"("metric", "active");

-- CreateIndex
CREATE INDEX "incentive_slabs_schemeId_fromPercent_idx" ON "incentive_slabs"("schemeId", "fromPercent");

-- CreateIndex
CREATE INDEX "incentive_earnings_userId_status_idx" ON "incentive_earnings"("userId", "status");

-- CreateIndex
CREATE INDEX "incentive_earnings_status_toDate_idx" ON "incentive_earnings"("status", "toDate");

-- CreateIndex
CREATE INDEX "incentive_earnings_targetId_idx" ON "incentive_earnings"("targetId");

-- AddForeignKey
ALTER TABLE "targets" ADD CONSTRAINT "targets_incentiveSchemeId_fkey" FOREIGN KEY ("incentiveSchemeId") REFERENCES "incentive_schemes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incentive_schemes" ADD CONSTRAINT "incentive_schemes_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incentive_slabs" ADD CONSTRAINT "incentive_slabs_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "incentive_schemes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incentive_earnings" ADD CONSTRAINT "incentive_earnings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incentive_earnings" ADD CONSTRAINT "incentive_earnings_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "targets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incentive_earnings" ADD CONSTRAINT "incentive_earnings_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "incentive_schemes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incentive_earnings" ADD CONSTRAINT "incentive_earnings_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incentive_earnings" ADD CONSTRAINT "incentive_earnings_payslipId_fkey" FOREIGN KEY ("payslipId") REFERENCES "payslips"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incentive_earnings" ADD CONSTRAINT "incentive_earnings_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


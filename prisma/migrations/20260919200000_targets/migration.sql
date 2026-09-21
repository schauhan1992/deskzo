-- CreateEnum
CREATE TYPE "TargetMetric" AS ENUM ('INVOICED_VALUE', 'COLLECTED_VALUE', 'ORDER_VALUE', 'ORDER_MARGIN', 'LEADS_CREATED', 'LEADS_WON', 'LEAD_VALUE_WON', 'CALLS_CONNECTED', 'CALL_MINUTES', 'VISITS_COMPLETED', 'COMPANIES_ADDED', 'CONTACTS_ADDED', 'TICKETS_RESOLVED');

-- CreateEnum
CREATE TYPE "TargetPeriod" AS ENUM ('MONTH', 'QUARTER', 'YEAR');

-- CreateEnum
CREATE TYPE "TargetScope" AS ENUM ('USER', 'DEPARTMENT', 'COMPANY');

-- CreateTable
CREATE TABLE "targets" (
    "id" TEXT NOT NULL,
    "metric" "TargetMetric" NOT NULL,
    "period" "TargetPeriod" NOT NULL,
    "fromDate" DATE NOT NULL,
    "toDate" DATE NOT NULL,
    "label" TEXT NOT NULL,
    "scope" "TargetScope" NOT NULL DEFAULT 'USER',
    "userId" TEXT,
    "departmentId" TEXT,
    "value" DECIMAL(14,2) NOT NULL,
    "note" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "targets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "targets_userId_fromDate_toDate_idx" ON "targets"("userId", "fromDate", "toDate");

-- CreateIndex
CREATE INDEX "targets_departmentId_fromDate_toDate_idx" ON "targets"("departmentId", "fromDate", "toDate");

-- CreateIndex
CREATE INDEX "targets_metric_fromDate_toDate_idx" ON "targets"("metric", "fromDate", "toDate");

-- AddForeignKey
ALTER TABLE "targets" ADD CONSTRAINT "targets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "targets" ADD CONSTRAINT "targets_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "targets" ADD CONSTRAINT "targets_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


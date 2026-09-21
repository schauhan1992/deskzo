-- CreateEnum
CREATE TYPE "WorkbookMode" AS ENUM ('LIST', 'COLD_CALLING');

-- CreateEnum
CREATE TYPE "CallerAllocationMethod" AS ENUM ('ROUND_ROBIN', 'BLOCKS', 'BY_ACCOUNT_OWNER');

-- CreateEnum
CREATE TYPE "WorkbookRecordStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'DONE', 'SKIPPED');

-- CreateEnum
CREATE TYPE "VerifiedField" AS ENUM ('EMAIL', 'PHONE');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('CORRECT', 'WRONG', 'CORRECTED');

-- AlterTable
ALTER TABLE "workbook_assignees" ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "dueAt" TIMESTAMP(3),
ADD COLUMN     "taskId" TEXT;

-- AlterTable
ALTER TABLE "workbooks" ADD COLUMN     "allocationMethod" "CallerAllocationMethod" NOT NULL DEFAULT 'ROUND_ROBIN',
ADD COLUMN     "dueAt" TIMESTAMP(3),
ADD COLUMN     "mode" "WorkbookMode" NOT NULL DEFAULT 'LIST',
ADD COLUMN     "startedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "workbook_records" (
    "id" TEXT NOT NULL,
    "workbookId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "assignedToUserId" TEXT,
    "status" "WorkbookRecordStatus" NOT NULL DEFAULT 'PENDING',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "openedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "handleSeconds" INTEGER,
    "gapSeconds" INTEGER,
    "outcomeNote" TEXT,
    "callId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workbook_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_verifications" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "contactId" TEXT,
    "recordId" TEXT,
    "field" "VerifiedField" NOT NULL,
    "originalValue" TEXT NOT NULL,
    "status" "VerificationStatus" NOT NULL,
    "correctedValue" TEXT,
    "note" TEXT,
    "verifiedByUserId" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),
    "appliedByUserId" TEXT,

    CONSTRAINT "contact_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workbook_records_callId_key" ON "workbook_records"("callId");

-- CreateIndex
CREATE INDEX "workbook_records_workbookId_assignedToUserId_status_idx" ON "workbook_records"("workbookId", "assignedToUserId", "status");

-- CreateIndex
CREATE INDEX "workbook_records_assignedToUserId_status_idx" ON "workbook_records"("assignedToUserId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "workbook_records_workbookId_companyId_key" ON "workbook_records"("workbookId", "companyId");

-- CreateIndex
CREATE INDEX "contact_verifications_companyId_idx" ON "contact_verifications"("companyId");

-- CreateIndex
CREATE INDEX "contact_verifications_contactId_idx" ON "contact_verifications"("contactId");

-- CreateIndex
CREATE INDEX "contact_verifications_status_appliedAt_idx" ON "contact_verifications"("status", "appliedAt");

-- CreateIndex
CREATE UNIQUE INDEX "workbook_assignees_taskId_key" ON "workbook_assignees"("taskId");

-- AddForeignKey
ALTER TABLE "workbook_assignees" ADD CONSTRAINT "workbook_assignees_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_records" ADD CONSTRAINT "workbook_records_workbookId_fkey" FOREIGN KEY ("workbookId") REFERENCES "workbooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_records" ADD CONSTRAINT "workbook_records_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_records" ADD CONSTRAINT "workbook_records_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_records" ADD CONSTRAINT "workbook_records_callId_fkey" FOREIGN KEY ("callId") REFERENCES "call_logs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_verifications" ADD CONSTRAINT "contact_verifications_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_verifications" ADD CONSTRAINT "contact_verifications_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_verifications" ADD CONSTRAINT "contact_verifications_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "workbook_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_verifications" ADD CONSTRAINT "contact_verifications_verifiedByUserId_fkey" FOREIGN KEY ("verifiedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_verifications" ADD CONSTRAINT "contact_verifications_appliedByUserId_fkey" FOREIGN KEY ("appliedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


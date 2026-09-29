-- Revenue & Close — the workspace schema.
--
-- A paid add-on on top of Accounting: revenue recognised as it is earned rather than when it is invoiced
-- (Ind AS 115), and a month-end close with a checklist that mostly checks itself.
--
-- Expand only: new enums and enum values, new tables, and nullable columns on trade_document_lines, items
-- and project_billing_milestones. An older build keeps working against the result — it never reads the new
-- columns or tables, and only the new code writes the new enum values (JournalSource REVENUE and SCHEDULE,
-- UserKind AUTOMATION). Nothing is backfilled: each new column means "not set" when null, and the four new
-- system accounts (Deferred Revenue 2150, Unbilled Revenue 1160, Prepaid Expenses 1170, Accrued Expenses
-- 2155) are added at runtime by ensureChartOfAccounts, as every system account is. No rows are inserted,
-- so a data reset has nothing to put back.
--
-- A value added to an existing enum can't be used in the transaction that adds it; nothing below uses one.

-- CreateEnum
CREATE TYPE "RevenuePattern" AS ENUM ('POINT_IN_TIME', 'RATABLE');

-- CreateEnum
CREATE TYPE "RevenueScheduleKind" AS ENUM ('RATABLE', 'MILESTONE');

-- CreateEnum
CREATE TYPE "RevenueScheduleStatus" AS ENUM ('PENDING_APPROVAL', 'ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CloseMonthStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "CloseTaskStatus" AS ENUM ('TODO', 'DONE', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "AccountingScheduleKind" AS ENUM ('PREPAID', 'ACCRUAL');

-- CreateEnum
CREATE TYPE "AccountingScheduleStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JournalSource" ADD VALUE 'REVENUE';
ALTER TYPE "JournalSource" ADD VALUE 'SCHEDULE';

-- AlterEnum
ALTER TYPE "UserKind" ADD VALUE 'AUTOMATION';

-- AlterTable
ALTER TABLE "items" ADD COLUMN     "revenuePattern" "RevenuePattern";

-- AlterTable
ALTER TABLE "project_billing_milestones" ADD COLUMN     "deliveryMilestoneId" TEXT;

-- AlterTable
ALTER TABLE "trade_document_lines" ADD COLUMN     "billingMilestoneId" TEXT,
ADD COLUMN     "servicePeriodFrom" DATE,
ADD COLUMN     "servicePeriodTo" DATE;

-- CreateTable
CREATE TABLE "revenue_schedules" (
    "id" TEXT NOT NULL,
    "documentId" TEXT,
    "lineId" TEXT,
    "companyId" TEXT NOT NULL,
    "itemId" TEXT,
    "companyProductId" TEXT,
    "billingMilestoneId" TEXT,
    "kind" "RevenueScheduleKind" NOT NULL,
    "status" "RevenueScheduleStatus" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "startDate" DATE,
    "endDate" DATE,
    "spreadEvenly" BOOLEAN NOT NULL DEFAULT false,
    "opening" BOOLEAN NOT NULL DEFAULT false,
    "branchId" TEXT,
    "gstRegistrationId" TEXT,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "revenue_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_schedule_lines" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "entryId" TEXT,
    "postedAt" TIMESTAMP(3),
    "catchUp" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "revenue_schedule_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_schedule_adjustments" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reversedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revenue_schedule_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounting_schedules" (
    "id" TEXT NOT NULL,
    "kind" "AccountingScheduleKind" NOT NULL,
    "name" TEXT NOT NULL,
    "vendorCompanyId" TEXT,
    "expenseAccountId" TEXT NOT NULL,
    "balanceAccountId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "startMonth" DATE NOT NULL,
    "months" INTEGER NOT NULL,
    "sourceDocumentId" TEXT,
    "reclassEntryId" TEXT,
    "status" "AccountingScheduleStatus" NOT NULL DEFAULT 'ACTIVE',
    "branchId" TEXT,
    "departmentId" TEXT,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounting_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounting_schedule_lines" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "entryId" TEXT,
    "reversalEntryId" TEXT,
    "postedAt" TIMESTAMP(3),
    "catchUp" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "accounting_schedule_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "close_months" (
    "id" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "status" "CloseMonthStatus" NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "reopenedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "close_months_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "close_task_templates" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "ownerId" TEXT,
    "dueDay" INTEGER NOT NULL DEFAULT 3,
    "autoCheck" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "close_task_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "close_tasks" (
    "id" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "templateId" TEXT,
    "title" TEXT NOT NULL,
    "ownerId" TEXT,
    "dueOn" DATE NOT NULL,
    "status" "CloseTaskStatus" NOT NULL DEFAULT 'TODO',
    "doneAt" TIMESTAMP(3),
    "doneById" TEXT,
    "note" TEXT,
    "autoCheck" TEXT,
    "autoOk" BOOLEAN,
    "autoDetail" JSONB,
    "autoCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "close_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "close_task_attachments" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fileDataUrl" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "close_task_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flux_notes" (
    "id" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "accountId" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "byId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "flux_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_close_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "autoPost" BOOLEAN NOT NULL DEFAULT true,
    "spreadEvenly" BOOLEAN NOT NULL DEFAULT false,
    "fluxPercent" DECIMAL(6,2) NOT NULL DEFAULT 20,
    "fluxAmount" DECIMAL(14,2) NOT NULL DEFAULT 25000,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "revenue_close_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_job_runs" (
    "job" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "ranAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ok" BOOLEAN,
    "error" TEXT,

    CONSTRAINT "daily_job_runs_pkey" PRIMARY KEY ("job","day")
);

-- CreateIndex
CREATE UNIQUE INDEX "revenue_schedules_lineId_key" ON "revenue_schedules"("lineId");

-- CreateIndex
CREATE INDEX "revenue_schedules_status_idx" ON "revenue_schedules"("status");

-- CreateIndex
CREATE INDEX "revenue_schedules_companyId_idx" ON "revenue_schedules"("companyId");

-- CreateIndex
CREATE INDEX "revenue_schedules_documentId_idx" ON "revenue_schedules"("documentId");

-- CreateIndex
CREATE INDEX "revenue_schedules_billingMilestoneId_idx" ON "revenue_schedules"("billingMilestoneId");

-- CreateIndex
CREATE INDEX "revenue_schedule_lines_entryId_idx" ON "revenue_schedule_lines"("entryId");

-- CreateIndex
CREATE UNIQUE INDEX "revenue_schedule_lines_scheduleId_month_key" ON "revenue_schedule_lines"("scheduleId", "month");

-- CreateIndex
CREATE INDEX "revenue_schedule_adjustments_documentId_idx" ON "revenue_schedule_adjustments"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "revenue_schedule_adjustments_scheduleId_documentId_key" ON "revenue_schedule_adjustments"("scheduleId", "documentId");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_schedules_reclassEntryId_key" ON "accounting_schedules"("reclassEntryId");

-- CreateIndex
CREATE INDEX "accounting_schedules_status_idx" ON "accounting_schedules"("status");

-- CreateIndex
CREATE INDEX "accounting_schedules_vendorCompanyId_idx" ON "accounting_schedules"("vendorCompanyId");

-- CreateIndex
CREATE INDEX "accounting_schedules_sourceDocumentId_idx" ON "accounting_schedules"("sourceDocumentId");

-- CreateIndex
CREATE INDEX "accounting_schedule_lines_entryId_idx" ON "accounting_schedule_lines"("entryId");

-- CreateIndex
CREATE INDEX "accounting_schedule_lines_reversalEntryId_idx" ON "accounting_schedule_lines"("reversalEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_schedule_lines_scheduleId_month_key" ON "accounting_schedule_lines"("scheduleId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "close_months_month_key" ON "close_months"("month");

-- CreateIndex
CREATE INDEX "close_task_templates_active_sortOrder_idx" ON "close_task_templates"("active", "sortOrder");

-- CreateIndex
CREATE INDEX "close_tasks_ownerId_idx" ON "close_tasks"("ownerId");

-- CreateIndex
CREATE INDEX "close_tasks_status_dueOn_idx" ON "close_tasks"("status", "dueOn");

-- CreateIndex
CREATE UNIQUE INDEX "close_tasks_month_templateId_key" ON "close_tasks"("month", "templateId");

-- CreateIndex
CREATE INDEX "close_task_attachments_taskId_idx" ON "close_task_attachments"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "flux_notes_month_accountId_key" ON "flux_notes"("month", "accountId");

-- CreateIndex
CREATE INDEX "project_billing_milestones_deliveryMilestoneId_idx" ON "project_billing_milestones"("deliveryMilestoneId");

-- CreateIndex
CREATE INDEX "trade_document_lines_billingMilestoneId_idx" ON "trade_document_lines"("billingMilestoneId");

-- AddForeignKey
ALTER TABLE "trade_document_lines" ADD CONSTRAINT "trade_document_lines_billingMilestoneId_fkey" FOREIGN KEY ("billingMilestoneId") REFERENCES "project_billing_milestones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_billing_milestones" ADD CONSTRAINT "project_billing_milestones_deliveryMilestoneId_fkey" FOREIGN KEY ("deliveryMilestoneId") REFERENCES "project_milestones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_schedules" ADD CONSTRAINT "revenue_schedules_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "trade_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_schedules" ADD CONSTRAINT "revenue_schedules_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "trade_document_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_schedules" ADD CONSTRAINT "revenue_schedules_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_schedules" ADD CONSTRAINT "revenue_schedules_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_schedules" ADD CONSTRAINT "revenue_schedules_companyProductId_fkey" FOREIGN KEY ("companyProductId") REFERENCES "company_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_schedules" ADD CONSTRAINT "revenue_schedules_billingMilestoneId_fkey" FOREIGN KEY ("billingMilestoneId") REFERENCES "project_billing_milestones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_schedules" ADD CONSTRAINT "revenue_schedules_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_schedules" ADD CONSTRAINT "revenue_schedules_gstRegistrationId_fkey" FOREIGN KEY ("gstRegistrationId") REFERENCES "gst_registrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_schedules" ADD CONSTRAINT "revenue_schedules_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_schedules" ADD CONSTRAINT "revenue_schedules_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_schedule_lines" ADD CONSTRAINT "revenue_schedule_lines_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "revenue_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_schedule_lines" ADD CONSTRAINT "revenue_schedule_lines_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_schedule_adjustments" ADD CONSTRAINT "revenue_schedule_adjustments_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "revenue_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_schedule_adjustments" ADD CONSTRAINT "revenue_schedule_adjustments_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "trade_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_schedules" ADD CONSTRAINT "accounting_schedules_vendorCompanyId_fkey" FOREIGN KEY ("vendorCompanyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_schedules" ADD CONSTRAINT "accounting_schedules_expenseAccountId_fkey" FOREIGN KEY ("expenseAccountId") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_schedules" ADD CONSTRAINT "accounting_schedules_balanceAccountId_fkey" FOREIGN KEY ("balanceAccountId") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_schedules" ADD CONSTRAINT "accounting_schedules_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "trade_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_schedules" ADD CONSTRAINT "accounting_schedules_reclassEntryId_fkey" FOREIGN KEY ("reclassEntryId") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_schedules" ADD CONSTRAINT "accounting_schedules_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_schedules" ADD CONSTRAINT "accounting_schedules_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_schedules" ADD CONSTRAINT "accounting_schedules_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_schedule_lines" ADD CONSTRAINT "accounting_schedule_lines_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "accounting_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_schedule_lines" ADD CONSTRAINT "accounting_schedule_lines_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_schedule_lines" ADD CONSTRAINT "accounting_schedule_lines_reversalEntryId_fkey" FOREIGN KEY ("reversalEntryId") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "close_months" ADD CONSTRAINT "close_months_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "close_task_templates" ADD CONSTRAINT "close_task_templates_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "close_tasks" ADD CONSTRAINT "close_tasks_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "close_task_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "close_tasks" ADD CONSTRAINT "close_tasks_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "close_tasks" ADD CONSTRAINT "close_tasks_doneById_fkey" FOREIGN KEY ("doneById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "close_task_attachments" ADD CONSTRAINT "close_task_attachments_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "close_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "close_task_attachments" ADD CONSTRAINT "close_task_attachments_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flux_notes" ADD CONSTRAINT "flux_notes_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ledger_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flux_notes" ADD CONSTRAINT "flux_notes_byId_fkey" FOREIGN KEY ("byId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_close_settings" ADD CONSTRAINT "revenue_close_settings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Constraints Prisma cannot express ─────────────────────────────────────────
-- A CHECK passes on NULL, so each one that must hold for a nullable column says so itself.

-- A line's service period is whole or absent, and never ends before it starts.
ALTER TABLE "trade_document_lines" ADD CONSTRAINT "trade_document_lines_service_period" CHECK (
  ("servicePeriodFrom" IS NULL AND "servicePeriodTo" IS NULL)
  OR ("servicePeriodFrom" IS NOT NULL AND "servicePeriodTo" IS NOT NULL AND "servicePeriodTo" >= "servicePeriodFrom"));

-- Revenue schedules: something to recognise; a RATABLE one has its period; a MILESTONE one has the
-- billing stage it waits on.
ALTER TABLE "revenue_schedules" ADD CONSTRAINT "revenue_schedules_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "revenue_schedules" ADD CONSTRAINT "revenue_schedules_ratable_has_period" CHECK (
  "kind" <> 'RATABLE' OR ("startDate" IS NOT NULL AND "endDate" IS NOT NULL AND "endDate" >= "startDate"));
ALTER TABLE "revenue_schedules" ADD CONSTRAINT "revenue_schedules_milestone_has_stage" CHECK (
  "kind" <> 'MILESTONE' OR "billingMilestoneId" IS NOT NULL);
ALTER TABLE "revenue_schedule_lines" ADD CONSTRAINT "revenue_schedule_lines_month_first" CHECK (EXTRACT(DAY FROM "month") = 1);
ALTER TABLE "revenue_schedule_lines" ADD CONSTRAINT "revenue_schedule_lines_amount_not_negative" CHECK ("amount" >= 0);
ALTER TABLE "revenue_schedule_adjustments" ADD CONSTRAINT "revenue_schedule_adjustments_amount_positive" CHECK ("amount" > 0);

-- Prepaids and accruals: at most five years, starting on the first of a month, through a balance account
-- that isn't the expense account itself. Only a prepaid opens with a reclass, and a reversal only follows
-- the entry it reverses.
ALTER TABLE "accounting_schedules" ADD CONSTRAINT "accounting_schedules_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "accounting_schedules" ADD CONSTRAINT "accounting_schedules_months_range" CHECK ("months" BETWEEN 1 AND 60);
ALTER TABLE "accounting_schedules" ADD CONSTRAINT "accounting_schedules_start_month_first" CHECK (EXTRACT(DAY FROM "startMonth") = 1);
ALTER TABLE "accounting_schedules" ADD CONSTRAINT "accounting_schedules_two_accounts" CHECK ("expenseAccountId" <> "balanceAccountId");
ALTER TABLE "accounting_schedules" ADD CONSTRAINT "accounting_schedules_reclass_is_prepaid" CHECK ("kind" = 'PREPAID' OR "reclassEntryId" IS NULL);
ALTER TABLE "accounting_schedule_lines" ADD CONSTRAINT "accounting_schedule_lines_month_first" CHECK (EXTRACT(DAY FROM "month") = 1);
ALTER TABLE "accounting_schedule_lines" ADD CONSTRAINT "accounting_schedule_lines_amount_not_negative" CHECK ("amount" >= 0);
ALTER TABLE "accounting_schedule_lines" ADD CONSTRAINT "accounting_schedule_lines_reversal_after_entry" CHECK (
  "reversalEntryId" IS NULL OR "entryId" IS NOT NULL);

-- The close: every month is the first of one; a due day is a day; an explanation says something, in at
-- most 1,000 characters; flux thresholds aren't negative.
ALTER TABLE "close_months" ADD CONSTRAINT "close_months_month_first" CHECK (EXTRACT(DAY FROM "month") = 1);
ALTER TABLE "close_tasks" ADD CONSTRAINT "close_tasks_month_first" CHECK (EXTRACT(DAY FROM "month") = 1);
ALTER TABLE "close_task_templates" ADD CONSTRAINT "close_task_templates_due_day" CHECK ("dueDay" BETWEEN 1 AND 31);
ALTER TABLE "flux_notes" ADD CONSTRAINT "flux_notes_month_first" CHECK (EXTRACT(DAY FROM "month") = 1);
ALTER TABLE "flux_notes" ADD CONSTRAINT "flux_notes_explanation_length" CHECK (
  char_length("explanation") <= 1000 AND "explanation" ~ '[^[:space:]]');
ALTER TABLE "revenue_close_settings" ADD CONSTRAINT "revenue_close_settings_thresholds" CHECK (
  "fluxPercent" >= 0 AND "fluxAmount" >= 0);

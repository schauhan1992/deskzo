-- Expense claims approved by HR (owner, 19 Oct 2026): who signs a claim off is the company's choice — HR, the
-- reporting manager, or the manager and then HR — snapshotted onto each claim when it is submitted.
CREATE TYPE "ExpenseApprovalFlow" AS ENUM ('HR', 'MANAGER', 'MANAGER_THEN_HR');
CREATE TYPE "ExpenseApprovalStep" AS ENUM ('MANAGER', 'HR');

ALTER TABLE "expenses" ADD COLUMN "approvalFlow" "ExpenseApprovalFlow",
ADD COLUMN "approvalStep" "ExpenseApprovalStep",
ADD COLUMN "managerApprovedAt" TIMESTAMP(3),
ADD COLUMN "managerApproverId" TEXT;

CREATE TABLE "expense_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "approvalFlow" "ExpenseApprovalFlow" NOT NULL DEFAULT 'HR',
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "expense_settings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "expenses_status_approvalStep_idx" ON "expenses"("status", "approvalStep");

ALTER TABLE "expenses" ADD CONSTRAINT "expenses_managerApproverId_fkey" FOREIGN KEY ("managerApproverId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Every claim submitted before today went to the reporting manager, and one still waiting stays on that
-- manager's desk: the new rule applies to claims submitted from now on.
UPDATE "expenses" SET "approvalFlow" = 'MANAGER', "approvalStep" = 'MANAGER' WHERE "status" <> 'DRAFT';

-- Deskzo Automate, Phase 7: its limits on plans, staff overrides for a workspace, and its usage in the daily snapshot.

-- AlterTable
ALTER TABLE "plans" ADD COLUMN     "automationConnectors" INTEGER,
ADD COLUMN     "automationHistoryDays" INTEGER,
ADD COLUMN     "automationSteps" INTEGER,
ADD COLUMN     "automationWorkflows" INTEGER;

-- AlterTable
ALTER TABLE "tenant_usage" ADD COLUMN     "automationSteps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "automationStepsLimit" INTEGER,
ADD COLUMN     "automationWorkflows" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "automationConnectorOverride" INTEGER,
ADD COLUMN     "automationHistoryOverride" INTEGER,
ADD COLUMN     "automationStepOverride" INTEGER,
ADD COLUMN     "automationWorkflowOverride" INTEGER;

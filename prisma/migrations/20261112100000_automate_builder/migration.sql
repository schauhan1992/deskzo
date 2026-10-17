-- Deskzo Automate, Phase 3: a readable number for each workflow (WF-0042, the builder's address),
-- and the pipeline automation a workflow was converted from, so converting happens once.

-- AlterTable
ALTER TABLE "automation_workflows" ADD COLUMN     "migratedFrom" TEXT,
ADD COLUMN     "workflowSeq" SERIAL NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "automation_workflows_workflowSeq_key" ON "automation_workflows"("workflowSeq");

-- CreateIndex
CREATE UNIQUE INDEX "automation_workflows_migratedFrom_key" ON "automation_workflows"("migratedFrom");


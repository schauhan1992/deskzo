-- Deskzo Automate, Phase 6: approval steps and the approvals inbox, waiting for an event, and parallel paths as runs of their own.

-- CreateEnum
CREATE TYPE "ApprovalKind" AS ENUM ('WORKFLOW_STEP', 'AGENT_PROPOSAL');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'TIMED_OUT', 'CANCELLED');

-- AlterTable
ALTER TABLE "automation_runs" ADD COLUMN     "parentRunId" TEXT,
ADD COLUMN     "parentStepKey" TEXT;

-- CreateTable
CREATE TABLE "automation_event_waits" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stepKey" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "rules" JSONB NOT NULL,
    "matchAny" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "matchedEventId" TEXT,
    "matchedPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_event_waits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" TEXT NOT NULL,
    "kind" "ApprovalKind" NOT NULL DEFAULT 'WORKFLOW_STEP',
    "workflowId" TEXT,
    "runId" TEXT,
    "stepKey" TEXT,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "approverIds" TEXT[],
    "approverRole" TEXT,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "comment" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "onTimeout" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "automation_runs_parentRunId_idx" ON "automation_runs"("parentRunId");

-- CreateIndex
CREATE INDEX "automation_event_waits_eventType_matchedEventId_idx" ON "automation_event_waits"("eventType", "matchedEventId");

-- CreateIndex
CREATE UNIQUE INDEX "automation_event_waits_runId_stepKey_key" ON "automation_event_waits"("runId", "stepKey");

-- CreateIndex
CREATE INDEX "approval_requests_status_expiresAt_idx" ON "approval_requests"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "approval_requests_runId_stepKey_key" ON "approval_requests"("runId", "stepKey");

-- AddForeignKey
ALTER TABLE "automation_event_waits" ADD CONSTRAINT "automation_event_waits_runId_fkey" FOREIGN KEY ("runId") REFERENCES "automation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

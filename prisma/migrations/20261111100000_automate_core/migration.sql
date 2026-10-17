-- Deskzo Automate, Phase 1 (plan approved 17 Oct 2026; src/lib/automate). New tables and two new
-- notification types only: nothing existing changes shape, and code tolerates these missing until
-- every workspace is migrated.

-- CreateEnum
CREATE TYPE "AutomationWorkflowStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AutomationSource" AS ENUM ('BUILDER', 'TEMPLATE', 'AI', 'MIGRATED');

-- CreateEnum
CREATE TYPE "AutomationRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'WAITING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'NEEDS_ATTENTION');

-- CreateEnum
CREATE TYPE "AutomationStepStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AutomationErrorKind" AS ENUM ('TRANSIENT', 'PERMANENT', 'UNKNOWN');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'WORKFLOW_MESSAGE';
ALTER TYPE "NotificationType" ADD VALUE 'WORKFLOW_PAUSED';

-- CreateTable
CREATE TABLE "automation_workflows" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "ownerUserId" TEXT NOT NULL,
    "status" "AutomationWorkflowStatus" NOT NULL DEFAULT 'DRAFT',
    "draft" JSONB NOT NULL,
    "activeVersionId" TEXT,
    "source" "AutomationSource" NOT NULL DEFAULT 'BUILDER',
    "templateKey" TEXT,
    "pausedReason" TEXT,
    "failureStreak" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_versions" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "definitionHash" TEXT NOT NULL,
    "triggerType" TEXT NOT NULL,
    "note" TEXT,
    "publishedById" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_triggers" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "nextFireAt" TIMESTAMP(3),

    CONSTRAINT "automation_triggers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "recordType" TEXT,
    "recordId" TEXT,
    "payload" JSONB NOT NULL,
    "actorUserId" TEXT,
    "causedByRunId" TEXT,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "matchedAt" TIMESTAMP(3),

    CONSTRAINT "automation_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_runs" (
    "id" TEXT NOT NULL,
    "runSeq" SERIAL NOT NULL,
    "workflowId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "eventId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "recordKey" TEXT,
    "status" "AutomationRunStatus" NOT NULL DEFAULT 'QUEUED',
    "cursor" JSONB NOT NULL,
    "contextCipher" TEXT NOT NULL,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedBy" TEXT,
    "lockedUntil" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "stepsUsed" INTEGER NOT NULL DEFAULT 0,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "startedById" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_run_steps" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" "AutomationStepStatus" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "inputSummary" JSONB,
    "outputSummary" JSONB,
    "errorKind" "AutomationErrorKind",
    "error" TEXT,
    "retryAt" TIMESTAMP(3),

    CONSTRAINT "automation_run_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_effects" (
    "key" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "recordType" TEXT,
    "recordId" TEXT,
    "output" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_effects_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "automation_connections" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "sharedWithWorkspace" BOOLEAN NOT NULL DEFAULT false,
    "credentialsCipher" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastUsedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_webhooks" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "signingSecretCipher" TEXT,
    "lastReceivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "pausedAt" TIMESTAMP(3),
    "pausedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "automation_workflows_status_idx" ON "automation_workflows"("status");

-- CreateIndex
CREATE UNIQUE INDEX "automation_versions_workflowId_number_key" ON "automation_versions"("workflowId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "automation_triggers_workflowId_key" ON "automation_triggers"("workflowId");

-- CreateIndex
CREATE INDEX "automation_triggers_type_idx" ON "automation_triggers"("type");

-- CreateIndex
CREATE INDEX "automation_triggers_nextFireAt_idx" ON "automation_triggers"("nextFireAt");

-- CreateIndex
CREATE INDEX "automation_events_matchedAt_occurredAt_idx" ON "automation_events"("matchedAt", "occurredAt");

-- CreateIndex
CREATE INDEX "automation_events_occurredAt_idx" ON "automation_events"("occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "automation_runs_runSeq_key" ON "automation_runs"("runSeq");

-- CreateIndex
CREATE UNIQUE INDEX "automation_runs_idempotencyKey_key" ON "automation_runs"("idempotencyKey");

-- CreateIndex
CREATE INDEX "automation_runs_status_runAfter_idx" ON "automation_runs"("status", "runAfter");

-- CreateIndex
CREATE INDEX "automation_runs_workflowId_createdAt_idx" ON "automation_runs"("workflowId", "createdAt");

-- CreateIndex
CREATE INDEX "automation_runs_workflowId_recordKey_createdAt_idx" ON "automation_runs"("workflowId", "recordKey", "createdAt");

-- CreateIndex
CREATE INDEX "automation_run_steps_runId_startedAt_idx" ON "automation_run_steps"("runId", "startedAt");

-- CreateIndex
CREATE INDEX "automation_effects_runId_idx" ON "automation_effects"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "automation_webhooks_tokenHash_key" ON "automation_webhooks"("tokenHash");

-- AddForeignKey
ALTER TABLE "automation_versions" ADD CONSTRAINT "automation_versions_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "automation_workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_triggers" ADD CONSTRAINT "automation_triggers_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "automation_workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "automation_workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "automation_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_run_steps" ADD CONSTRAINT "automation_run_steps_runId_fkey" FOREIGN KEY ("runId") REFERENCES "automation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_effects" ADD CONSTRAINT "automation_effects_runId_fkey" FOREIGN KEY ("runId") REFERENCES "automation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_webhooks" ADD CONSTRAINT "automation_webhooks_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "automation_workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A published version is never changed: a run always reads the version it started on.
CREATE FUNCTION "automation_versions_refuse_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'A published workflow version cannot be changed: publish a new version instead.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "automation_versions_immutable"
  BEFORE UPDATE ON "automation_versions"
  FOR EACH ROW EXECUTE FUNCTION "automation_versions_refuse_update"();

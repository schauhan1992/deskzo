-- Restore safety copies and the workspace reset (owner, 22 Oct 2026).

-- Why a backup was taken (the safety copy before a restore or a reset), and how long it is kept whatever
-- the retention says.
ALTER TABLE "backups" ADD COLUMN "reason" TEXT;
ALTER TABLE "backups" ADD COLUMN "keepUntil" TIMESTAMP(3);

-- A reset the super admin asked for: run a day later unless cancelled.
CREATE TYPE "WorkspaceResetStatus" AS ENUM ('SCHEDULED', 'CANCELLED', 'RUNNING', 'DONE', 'FAILED');

CREATE TABLE "workspace_resets" (
    "id" TEXT NOT NULL,
    "status" "WorkspaceResetStatus" NOT NULL DEFAULT 'SCHEDULED',
    "requestedById" TEXT NOT NULL,
    "requestedByName" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "runAfter" TIMESTAMP(3) NOT NULL,
    "cancelledByName" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "backupFilename" TEXT,
    "error" TEXT,

    CONSTRAINT "workspace_resets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "workspace_resets_status_runAfter_idx" ON "workspace_resets"("status", "runAfter");

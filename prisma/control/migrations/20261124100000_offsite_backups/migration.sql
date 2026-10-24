-- Off-site backups and the log archive (owner, 24 Oct 2026): each run of the sync, the control plane's dump,
-- a restore drill and the log archive; and each workspace's backups off-site. New tables only.

-- CreateEnum
CREATE TYPE "OffsiteRunKind" AS ENUM ('SYNC', 'CONTROL_DUMP', 'DRILL', 'LOGS');

-- CreateEnum
CREATE TYPE "OffsiteRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "offsite_runs" (
    "id" TEXT NOT NULL,
    "kind" "OffsiteRunKind" NOT NULL,
    "status" "OffsiteRunStatus" NOT NULL DEFAULT 'RUNNING',
    "startedBy" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "summary" TEXT,
    "error" TEXT,
    "objects" INTEGER NOT NULL DEFAULT 0,
    "bytes" BIGINT NOT NULL DEFAULT 0,
    "tenantId" TEXT,
    "scratchDb" TEXT,

    CONSTRAINT "offsite_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offsite_workspaces" (
    "tenantId" TEXT NOT NULL,
    "latestBackupAt" TIMESTAMP(3),
    "backups" INTEGER NOT NULL DEFAULT 0,
    "lastSyncedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastPrunedAt" TIMESTAMP(3),
    "lastVerifiedAt" TIMESTAMP(3),
    "logsThrough" TEXT,
    "lastDrillAt" TIMESTAMP(3),
    "lastDrillOk" BOOLEAN,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "offsite_workspaces_pkey" PRIMARY KEY ("tenantId")
);

-- CreateIndex
CREATE INDEX "offsite_runs_kind_startedAt_idx" ON "offsite_runs"("kind", "startedAt");


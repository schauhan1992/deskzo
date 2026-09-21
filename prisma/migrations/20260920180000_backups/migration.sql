-- CreateEnum
CREATE TYPE "BackupStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "backups" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "directory" TEXT NOT NULL,
    "status" "BackupStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "sizeBytes" BIGINT,
    "error" TEXT,
    "schemaVersion" TEXT,
    "secretFingerprint" TEXT,
    "via" TEXT,
    "triggeredById" TEXT,

    CONSTRAINT "backups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "backups_startedAt_idx" ON "backups"("startedAt");

-- CreateIndex
CREATE INDEX "backups_status_idx" ON "backups"("status");

-- AddForeignKey
ALTER TABLE "backups" ADD CONSTRAINT "backups_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

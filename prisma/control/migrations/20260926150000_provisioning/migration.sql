-- CreateEnum
CREATE TYPE "ProvisioningStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "dbRole" TEXT,
ALTER COLUMN "dbName" DROP NOT NULL,
ALTER COLUMN "dbUrlCipher" DROP NOT NULL;

-- CreateTable
CREATE TABLE "provisioning_jobs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "status" "ProvisioningStatus" NOT NULL DEFAULT 'PENDING',
    "step" TEXT NOT NULL DEFAULT 'Waiting to start',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,
    "ownerName" TEXT NOT NULL,
    "ownerEmail" TEXT NOT NULL,
    "ownerPasswordHash" TEXT,
    "companyName" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provisioning_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warm_databases" (
    "id" TEXT NOT NULL,
    "dbName" TEXT NOT NULL,
    "dbRole" TEXT NOT NULL,
    "dbUrlCipher" TEXT NOT NULL,
    "schemaVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "claimedByTenantId" TEXT,

    CONSTRAINT "warm_databases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signup_invites" (
    "codeHash" TEXT NOT NULL,
    "note" TEXT,
    "maxUses" INTEGER NOT NULL DEFAULT 1,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signup_invites_pkey" PRIMARY KEY ("codeHash")
);

-- CreateTable
CREATE TABLE "pending_signups" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "ownerName" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "inviteCodeHash" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "codeExpiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "browserSecretHash" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "tenantId" TEXT,
    "handedOffAt" TIMESTAMP(3),
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_signups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_handoff_tickets" (
    "tokenHash" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_handoff_tickets_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateTable
CREATE TABLE "tenant_migration_runs" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "tenantId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "ok" BOOLEAN,
    "fromVersion" TEXT,
    "toVersion" TEXT,
    "output" TEXT,

    CONSTRAINT "tenant_migration_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "provisioning_jobs_status_runAfter_idx" ON "provisioning_jobs"("status", "runAfter");

-- CreateIndex
CREATE INDEX "provisioning_jobs_tenantId_idx" ON "provisioning_jobs"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "warm_databases_dbName_key" ON "warm_databases"("dbName");

-- CreateIndex
CREATE INDEX "warm_databases_claimedAt_idx" ON "warm_databases"("claimedAt");

-- CreateIndex
CREATE UNIQUE INDEX "pending_signups_tenantId_key" ON "pending_signups"("tenantId");

-- CreateIndex
CREATE INDEX "pending_signups_email_idx" ON "pending_signups"("email");

-- CreateIndex
CREATE INDEX "pending_signups_slug_idx" ON "pending_signups"("slug");

-- CreateIndex
CREATE INDEX "platform_handoff_tickets_tenantId_idx" ON "platform_handoff_tickets"("tenantId");

-- CreateIndex
CREATE INDEX "tenant_migration_runs_runId_idx" ON "tenant_migration_runs"("runId");

-- CreateIndex
CREATE INDEX "tenant_migration_runs_tenantId_startedAt_idx" ON "tenant_migration_runs"("tenantId", "startedAt");

-- AddForeignKey
ALTER TABLE "provisioning_jobs" ADD CONSTRAINT "provisioning_jobs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_handoff_tickets" ADD CONSTRAINT "platform_handoff_tickets_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_migration_runs" ADD CONSTRAINT "tenant_migration_runs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- CreateEnum
CREATE TYPE "LinkSwitchStage" AS ENUM ('PRESENTED', 'CODE', 'READY', 'DONE', 'SSO', 'REFUSED');

-- CreateTable
CREATE TABLE "link_groups" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "link_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "link_members" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "stamp" TEXT NOT NULL,
    "provenAt" TIMESTAMP(3) NOT NULL,
    "lastSwitchedInAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "link_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "link_intents" (
    "tokenHash" TEXT NOT NULL,
    "sourceTenantId" TEXT NOT NULL,
    "sourceUserId" TEXT NOT NULL,
    "sourceSid" TEXT NOT NULL,
    "sourceOrigin" TEXT NOT NULL,
    "sourceStamp" TEXT NOT NULL,
    "sourceEmail" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "browserSecretHash" TEXT NOT NULL,
    "targetTenantId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "presentedAt" TIMESTAMP(3),
    "targetBrowserHash" TEXT,
    "targetUserId" TEXT,
    "targetEmail" TEXT,
    "targetName" TEXT,
    "targetStamp" TEXT,
    "provenAt" TIMESTAMP(3),
    "completionHash" TEXT,
    "completionSeenAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failure" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "link_intents_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateTable
CREATE TABLE "link_switch_tickets" (
    "tokenHash" TEXT NOT NULL,
    "targetTenantId" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "sourceTenantId" TEXT NOT NULL,
    "sourceUserId" TEXT NOT NULL,
    "sourceSid" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "presentHash" TEXT,
    "stage" "LinkSwitchStage",
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "finishBy" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "refusal" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "link_switch_tickets_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateTable
CREATE TABLE "tenant_sign_in_policies" (
    "tenantId" TEXT NOT NULL,
    "allowSwitchIn" BOOLEAN NOT NULL DEFAULT true,
    "updatedByUserId" TEXT,
    "updatedByName" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_sign_in_policies_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "workspace_emails" (
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emailHmac" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_emails_pkey" PRIMARY KEY ("tenantId","userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "link_members_tenantId_userId_key" ON "link_members"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "link_members_groupId_tenantId_key" ON "link_members"("groupId", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "link_intents_targetBrowserHash_key" ON "link_intents"("targetBrowserHash");

-- CreateIndex
CREATE UNIQUE INDEX "link_intents_completionHash_key" ON "link_intents"("completionHash");

-- CreateIndex
CREATE INDEX "link_intents_sourceTenantId_sourceUserId_createdAt_idx" ON "link_intents"("sourceTenantId", "sourceUserId", "createdAt");

-- CreateIndex
CREATE INDEX "link_intents_targetTenantId_createdAt_idx" ON "link_intents"("targetTenantId", "createdAt");

-- CreateIndex
CREATE INDEX "link_intents_expiresAt_idx" ON "link_intents"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "link_switch_tickets_presentHash_key" ON "link_switch_tickets"("presentHash");

-- CreateIndex
CREATE INDEX "link_switch_tickets_targetTenantId_createdAt_idx" ON "link_switch_tickets"("targetTenantId", "createdAt");

-- CreateIndex
CREATE INDEX "link_switch_tickets_sourceTenantId_sourceUserId_createdAt_idx" ON "link_switch_tickets"("sourceTenantId", "sourceUserId", "createdAt");

-- CreateIndex
CREATE INDEX "link_switch_tickets_expiresAt_idx" ON "link_switch_tickets"("expiresAt");

-- CreateIndex
CREATE INDEX "workspace_emails_emailHmac_idx" ON "workspace_emails"("emailHmac");

-- AddForeignKey
ALTER TABLE "link_members" ADD CONSTRAINT "link_members_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "link_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "link_members" ADD CONSTRAINT "link_members_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "link_intents" ADD CONSTRAINT "link_intents_sourceTenantId_fkey" FOREIGN KEY ("sourceTenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "link_intents" ADD CONSTRAINT "link_intents_targetTenantId_fkey" FOREIGN KEY ("targetTenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "link_switch_tickets" ADD CONSTRAINT "link_switch_tickets_targetTenantId_fkey" FOREIGN KEY ("targetTenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_sign_in_policies" ADD CONSTRAINT "tenant_sign_in_policies_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_emails" ADD CONSTRAINT "workspace_emails_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Checks (hand-written; Prisma does not model them)
ALTER TABLE "link_members" ADD CONSTRAINT "link_members_stamp_hex" CHECK ("stamp" ~ '^[0-9a-f]{64}$');
ALTER TABLE "link_intents" ADD CONSTRAINT "link_intents_two_workspaces" CHECK ("sourceTenantId" <> "targetTenantId");
ALTER TABLE "link_switch_tickets" ADD CONSTRAINT "link_switch_tickets_two_workspaces" CHECK ("sourceTenantId" <> "targetTenantId");
ALTER TABLE "link_switch_tickets" ADD CONSTRAINT "link_switch_tickets_attempts" CHECK ("attempts" BETWEEN 0 AND 5);
ALTER TABLE "workspace_emails" ADD CONSTRAINT "workspace_emails_hmac_hex" CHECK ("emailHmac" ~ '^[0-9a-f]{64}$');

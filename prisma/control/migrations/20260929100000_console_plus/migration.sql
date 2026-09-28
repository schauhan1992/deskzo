-- CreateEnum
CREATE TYPE "AnnouncementTone" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AnnouncementAudience" AS ENUM ('ALL', 'TENANTS', 'COUNTRIES', 'PLANS');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "tenant_notes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "editedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "tenant_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_alert_acks" (
    "key" TEXT NOT NULL,
    "ackedBy" TEXT NOT NULL,
    "ackedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "snoozeUntil" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "platform_alert_acks_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "platform_announcements" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "tone" "AnnouncementTone" NOT NULL DEFAULT 'INFO',
    "audience" "AnnouncementAudience" NOT NULL DEFAULT 'ALL',
    "targets" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3),
    "dismissible" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "platform_announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_revenue_snapshots" (
    "day" DATE NOT NULL,
    "currency" TEXT NOT NULL,
    "mrr" BIGINT NOT NULL,
    "subscriptions" INTEGER NOT NULL,
    "workspaces" INTEGER NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_revenue_snapshots_pkey" PRIMARY KEY ("day","currency")
);

-- CreateIndex
CREATE INDEX "tenants_tags_idx" ON "tenants" USING GIN ("tags");

-- CreateIndex
CREATE INDEX "tenant_notes_tenantId_createdAt_idx" ON "tenant_notes"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "platform_announcements_archivedAt_startsAt_idx" ON "platform_announcements"("archivedAt", "startsAt");

-- CreateIndex
CREATE INDEX "platform_audit_log_at_idx" ON "platform_audit_log"("at");

-- CreateIndex
CREATE INDEX "platform_audit_log_action_at_idx" ON "platform_audit_log"("action", "at");

-- CreateIndex
CREATE INDEX "platform_audit_log_actor_at_idx" ON "platform_audit_log"("actor", "at");

-- CreateIndex
CREATE INDEX "billing_events_tenantId_receivedAt_idx" ON "billing_events"("tenantId", "receivedAt");

-- CreateIndex
CREATE INDEX "pending_signups_createdAt_idx" ON "pending_signups"("createdAt");

-- AddForeignKey
ALTER TABLE "tenant_notes" ADD CONSTRAINT "tenant_notes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Written by hand: limits the schema cannot say.
ALTER TABLE "tenant_notes" ADD CONSTRAINT "tenant_notes_body_length" CHECK (char_length("body") BETWEEN 1 AND 4000);
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_tags_at_most_ten" CHECK (cardinality("tags") <= 10);
ALTER TABLE "platform_announcements" ADD CONSTRAINT "platform_announcements_window" CHECK ("endsAt" IS NULL OR "endsAt" > "startsAt");
ALTER TABLE "platform_announcements" ADD CONSTRAINT "platform_announcements_lengths" CHECK (char_length("title") BETWEEN 3 AND 120 AND char_length("body") BETWEEN 1 AND 1000);
ALTER TABLE "platform_revenue_snapshots" ADD CONSTRAINT "platform_revenue_snapshots_not_negative" CHECK ("mrr" >= 0);

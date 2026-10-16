-- Field access, daily unmask limits and the unmasking log (src/lib/authz/field-policy.ts,
-- src/lib/authz/fields.ts, src/lib/authz/unmask.ts). Expand-only: every table is new and starts
-- empty, and an empty policy table means every field reads as it always has — nothing changes for
-- anybody until an admin sets a policy. `roles.active` defaults to true for every existing role.

-- CreateEnum
CREATE TYPE "UnmaskResult" AS ENUM ('ALLOWED', 'REPEAT', 'QUOTA_EXHAUSTED', 'DENIED');
-- AlterTable
ALTER TABLE "roles" ADD COLUMN IF NOT EXISTS "active" BOOLEAN NOT NULL DEFAULT true;
-- CreateTable
CREATE TABLE "role_field_policies" (
    "role" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "view" BOOLEAN NOT NULL DEFAULT true,
    "maskInList" BOOLEAN NOT NULL DEFAULT false,
    "maskInDetail" BOOLEAN NOT NULL DEFAULT false,
    "unmask" BOOLEAN NOT NULL DEFAULT false,
    "format" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "role_field_policies_pkey" PRIMARY KEY ("role","entity","field")
);
-- CreateTable
CREATE TABLE "user_field_policies" (
    "userId" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "view" BOOLEAN NOT NULL DEFAULT true,
    "maskInList" BOOLEAN NOT NULL DEFAULT false,
    "maskInDetail" BOOLEAN NOT NULL DEFAULT false,
    "unmask" BOOLEAN NOT NULL DEFAULT false,
    "format" TEXT,
    "reason" TEXT,
    "grantedById" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "user_field_policies_pkey" PRIMARY KEY ("userId","entity","field")
);
-- CreateTable
CREATE TABLE "role_unmask_limits" (
    "role" TEXT NOT NULL,
    "dailyLimit" INTEGER,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "role_unmask_limits_pkey" PRIMARY KEY ("role")
);
-- CreateTable
CREATE TABLE "user_unmask_limits" (
    "userId" TEXT NOT NULL,
    "limited" BOOLEAN NOT NULL,
    "dailyLimit" INTEGER,
    "reason" TEXT,
    "grantedById" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "user_unmask_limits_pkey" PRIMARY KEY ("userId")
);
-- CreateTable
CREATE TABLE "unmask_usage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "businessDate" TEXT NOT NULL,
    "fields" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "unmask_usage_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "unmask_events" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "businessDate" TEXT NOT NULL,
    "tenantId" TEXT,
    "userId" TEXT NOT NULL,
    "userName" TEXT NOT NULL,
    "impersonatedByUserId" TEXT,
    "leadId" TEXT NOT NULL,
    "leadRef" TEXT,
    "fields" TEXT[],
    "result" "UnmaskResult" NOT NULL,
    "consumed" BOOLEAN NOT NULL DEFAULT false,
    "usedToday" INTEGER,
    "dailyLimit" INTEGER,
    "reason" TEXT,
    "requestId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    CONSTRAINT "unmask_events_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "user_field_policies_expiresAt_idx" ON "user_field_policies"("expiresAt");
-- CreateIndex
CREATE INDEX "unmask_usage_businessDate_idx" ON "unmask_usage"("businessDate");
-- CreateIndex
CREATE UNIQUE INDEX "unmask_usage_userId_businessDate_leadId_key" ON "unmask_usage"("userId", "businessDate", "leadId");
-- CreateIndex
CREATE INDEX "unmask_events_at_idx" ON "unmask_events"("at");
-- CreateIndex
CREATE INDEX "unmask_events_userId_at_idx" ON "unmask_events"("userId", "at");
-- CreateIndex
CREATE INDEX "unmask_events_leadId_at_idx" ON "unmask_events"("leadId", "at");
-- CreateIndex
CREATE INDEX "unmask_events_result_at_idx" ON "unmask_events"("result", "at");
-- AddForeignKey
ALTER TABLE "role_field_policies" ADD CONSTRAINT "role_field_policies_role_fkey" FOREIGN KEY ("role") REFERENCES "roles"("key") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "user_field_policies" ADD CONSTRAINT "user_field_policies_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "user_field_policies" ADD CONSTRAINT "user_field_policies_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "role_unmask_limits" ADD CONSTRAINT "role_unmask_limits_role_fkey" FOREIGN KEY ("role") REFERENCES "roles"("key") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "user_unmask_limits" ADD CONSTRAINT "user_unmask_limits_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "user_unmask_limits" ADD CONSTRAINT "user_unmask_limits_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "unmask_usage" ADD CONSTRAINT "unmask_usage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Masking never grants reading: a field that can't be read can't be masked or unmasked either.
ALTER TABLE "role_field_policies" ADD CONSTRAINT "role_field_policies_view_first"
  CHECK ("view" OR (NOT "maskInList" AND NOT "maskInDetail" AND NOT "unmask"));
ALTER TABLE "user_field_policies" ADD CONSTRAINT "user_field_policies_view_first"
  CHECK ("view" OR (NOT "maskInList" AND NOT "maskInDetail" AND NOT "unmask"));

-- A limit is a positive number of leads; a person's limit says one when it limits.
ALTER TABLE "role_unmask_limits" ADD CONSTRAINT "role_unmask_limits_positive"
  CHECK ("dailyLimit" IS NULL OR "dailyLimit" > 0);
ALTER TABLE "user_unmask_limits" ADD CONSTRAINT "user_unmask_limits_positive"
  CHECK ("dailyLimit" IS NULL OR "dailyLimit" > 0);
ALTER TABLE "user_unmask_limits" ADD CONSTRAINT "user_unmask_limits_limited_has_limit"
  CHECK (NOT "limited" OR "dailyLimit" IS NOT NULL);

-- The unmasking log is append-only. Nothing in the application updates or deletes a row, and this
-- makes sure nothing can: a person's own history is not theirs to edit. A workspace data reset
-- empties the table with TRUNCATE, which row triggers don't see; the table carries no foreign keys
-- whose cascade would delete from it.
CREATE OR REPLACE FUNCTION refuse_unmask_event_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'The unmasking log is append-only: rows are never changed or removed.'
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "unmask_events_append_only"
  BEFORE UPDATE OR DELETE ON "unmask_events"
  FOR EACH ROW EXECUTE FUNCTION refuse_unmask_event_change();

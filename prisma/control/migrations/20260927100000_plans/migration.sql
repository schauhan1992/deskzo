-- CreateEnum
CREATE TYPE "PlanKind" AS ENUM ('EDITION', 'BUNDLE', 'ADDON', 'INTERNAL');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BillingGateway" AS ENUM ('MANUAL', 'STRIPE', 'RAZORPAY');

-- AlterTable
ALTER TABLE "provisioning_jobs" ADD COLUMN     "planKey" TEXT;

-- AlterTable
ALTER TABLE "signup_invites" ADD COLUMN     "planKey" TEXT;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "copilotTokenOverride" INTEGER,
ADD COLUMN     "entitlements" JSONB,
ADD COLUMN     "seatOverride" INTEGER;

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "PlanKind" NOT NULL,
    "description" TEXT,
    "allModules" BOOLEAN NOT NULL DEFAULT false,
    "countries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "seats" INTEGER,
    "copilotTokens" INTEGER,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_modules" (
    "planId" TEXT NOT NULL,
    "moduleKey" TEXT NOT NULL,

    CONSTRAINT "plan_modules_pkey" PRIMARY KEY ("planId","moduleKey")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "gateway" "BillingGateway" NOT NULL DEFAULT 'MANUAL',
    "trialEndsAt" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_items" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_module_overrides" (
    "tenantId" TEXT NOT NULL,
    "moduleKey" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "reason" TEXT NOT NULL,
    "byStaffId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_module_overrides_pkey" PRIMARY KEY ("tenantId","moduleKey")
);

-- CreateIndex
CREATE UNIQUE INDEX "plans_key_key" ON "plans"("key");

-- CreateIndex
CREATE INDEX "subscriptions_tenantId_status_idx" ON "subscriptions"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_items_subscriptionId_planId_key" ON "subscription_items"("subscriptionId", "planId");

-- AddForeignKey
ALTER TABLE "plan_modules" ADD CONSTRAINT "plan_modules_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_items" ADD CONSTRAINT "subscription_items_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_items" ADD CONSTRAINT "subscription_items_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_module_overrides" ADD CONSTRAINT "tenant_module_overrides_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Written by hand: what the schema cannot say.

-- At most one plan new workspaces start on.
CREATE UNIQUE INDEX "plans_one_default" ON "plans" ("isDefault") WHERE "isDefault";

ALTER TABLE "plans" ADD CONSTRAINT "plans_seats_not_negative" CHECK ("seats" IS NULL OR "seats" >= 0);
ALTER TABLE "plans" ADD CONSTRAINT "plans_copilot_not_negative" CHECK ("copilotTokens" IS NULL OR "copilotTokens" >= 0);
ALTER TABLE "subscription_items" ADD CONSTRAINT "subscription_items_quantity_positive" CHECK ("quantity" >= 1);
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_overrides_not_negative" CHECK (("seatOverride" IS NULL OR "seatOverride" >= 0) AND ("copilotTokenOverride" IS NULL OR "copilotTokenOverride" >= 0));

-- The installation's own workspace keeps everything it has: an internal plan of every module, with
-- no limits, and its entitlements written now so that not one request in between sees it without.
INSERT INTO "plans" ("id", "key", "name", "kind", "description", "allModules", "updatedAt")
VALUES (gen_random_uuid()::text, 'internal-everything', 'Everything (internal)', 'INTERNAL', 'Every module, no limits. Never sold: the installation''s own workspace, and workspaces staff test with.', true, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "subscriptions" ("id", "tenantId", "status", "gateway", "updatedAt")
SELECT gen_random_uuid()::text, t."id", 'ACTIVE', 'MANUAL', CURRENT_TIMESTAMP FROM "tenants" t WHERE t."isDefault";

INSERT INTO "subscription_items" ("id", "subscriptionId", "planId")
SELECT gen_random_uuid()::text, s."id", p."id"
FROM "subscriptions" s JOIN "tenants" t ON t."id" = s."tenantId" AND t."isDefault" CROSS JOIN "plans" p
WHERE p."key" = 'internal-everything';

UPDATE "tenants"
SET "entitlements" = '{"v":1,"all":true,"modules":[],"seats":null,"copilotTokens":null,"plans":["internal-everything"]}'::jsonb
WHERE "isDefault";

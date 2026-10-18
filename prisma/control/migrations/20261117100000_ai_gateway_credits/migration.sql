-- Deskzo AI on credits (owner, 17 Oct 2026; src/lib/ai): the accounts, models and routes AI runs on,
-- set in console › Settings › AI, and each workspace's credits: the month's allowance, packs, every charge.

-- CreateEnum
CREATE TYPE "AiProviderKind" AS ENUM ('ANTHROPIC', 'BEDROCK', 'OPENAI', 'AZURE_OPENAI', 'GEMINI', 'VERTEX', 'OPENAI_COMPATIBLE');

-- CreateTable
CREATE TABLE "ai_accounts" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "AiProviderKind" NOT NULL,
    "region" TEXT,
    "endpoint" TEXT,
    "keyId" TEXT,
    "secretCipher" TEXT,
    "residency" TEXT NOT NULL,
    "noTraining" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastTestAt" TIMESTAMP(3),
    "lastTestOk" BOOLEAN,
    "lastTestError" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_models" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "providerModel" TEXT NOT NULL,
    "inputRate" INTEGER NOT NULL,
    "outputRate" INTEGER NOT NULL,
    "inputCost" INTEGER,
    "outputCost" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_models_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_models_rates_check" CHECK ("inputRate" >= 0 AND "outputRate" >= 0 AND ("inputCost" IS NULL OR "inputCost" >= 0) AND ("outputCost" IS NULL OR "outputCost" >= 0))
);

-- CreateTable
CREATE TABLE "ai_routes" (
    "feature" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_routes_pkey" PRIMARY KEY ("feature")
);

-- CreateTable
CREATE TABLE "ai_credit_months" (
    "tenantId" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "allowance" INTEGER,
    "allowanceUsed" INTEGER NOT NULL DEFAULT 0,
    "packsUsed" INTEGER NOT NULL DEFAULT 0,
    "overdraft" INTEGER NOT NULL DEFAULT 0,
    "alert80At" TIMESTAMP(3),
    "alert100At" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_credit_months_pkey" PRIMARY KEY ("tenantId","month"),
    -- Used can stand above the allowance only when a plan shrank mid-month; a charge never takes it past.
    CONSTRAINT "ai_credit_months_amounts_check" CHECK ("allowanceUsed" >= 0 AND "packsUsed" >= 0 AND "overdraft" >= 0 AND ("allowance" IS NULL OR "allowance" >= 0))
);

-- CreateTable
CREATE TABLE "ai_credit_packs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "packKey" TEXT,
    "credits" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL,
    "externalId" TEXT,
    "invoiceId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "grantedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_credit_packs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_credit_packs_amounts_check" CHECK ("credits" > 0 AND "remaining" >= 0 AND "remaining" <= "credits"),
    CONSTRAINT "ai_credit_packs_source_check" CHECK ("source" IN ('STRIPE', 'RAZORPAY', 'OFFLINE', 'STAFF'))
);

-- CreateTable
CREATE TABLE "ai_usage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "modelKey" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "credits" INTEGER NOT NULL,
    "fromAllowance" INTEGER NOT NULL,
    "fromPacks" INTEGER NOT NULL,
    "overdraft" INTEGER NOT NULL,
    "cost" INTEGER,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_usage_split_check" CHECK ("credits" >= 0 AND "fromAllowance" >= 0 AND "fromPacks" >= 0 AND "overdraft" >= 0 AND "fromAllowance" + "fromPacks" + "overdraft" = "credits")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_models_key_key" ON "ai_models"("key");

-- CreateIndex
CREATE INDEX "ai_models_accountId_idx" ON "ai_models"("accountId");

-- CreateIndex
CREATE INDEX "ai_routes_modelId_idx" ON "ai_routes"("modelId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_credit_packs_externalId_key" ON "ai_credit_packs"("externalId");

-- CreateIndex
CREATE INDEX "ai_credit_packs_tenantId_expiresAt_idx" ON "ai_credit_packs"("tenantId", "expiresAt");

-- CreateIndex
CREATE INDEX "ai_usage_tenantId_at_idx" ON "ai_usage"("tenantId", "at");

-- CreateIndex
CREATE INDEX "ai_usage_tenantId_userId_at_idx" ON "ai_usage"("tenantId", "userId", "at");

-- AddForeignKey
ALTER TABLE "ai_models" ADD CONSTRAINT "ai_models_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ai_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_routes" ADD CONSTRAINT "ai_routes_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "ai_models"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_credit_months" ADD CONSTRAINT "ai_credit_months_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_credit_packs" ADD CONSTRAINT "ai_credit_packs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The plans' monthly allowance, now in credits (owner, 17 Oct 2026): Deskzo One 100 a person, every other
-- edition 50 a person, and the AI Copilot add-on becomes AI Plus — 750 credits a month for each unit. Plans
-- staff made later keep what they are given. Internal plans stay unlimited (null).
UPDATE "plans" SET "copilotTokens" = 100 WHERE "kind" = 'EDITION' AND "productKey" = 'one';
UPDATE "plans" SET "copilotTokens" = 50 WHERE "kind" = 'EDITION' AND "productKey" IS DISTINCT FROM 'one';
UPDATE "plans" SET "copilotTokens" = 750, "name" = 'AI Plus', "description" = 'More AI credits every month, on top of what your plan includes' WHERE "key" = 'addon-ai-copilot';
-- A staff override counted tokens, which mean nothing in credits.
UPDATE "tenants" SET "copilotTokenOverride" = NULL WHERE "copilotTokenOverride" IS NOT NULL;

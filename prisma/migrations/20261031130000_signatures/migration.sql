-- Deskzo Signatures: company signature templates, who gets which, the connected mail suite, and each person's sync.

-- CreateEnum
CREATE TYPE "SignatureRuleTarget" AS ENUM ('DEPARTMENT', 'BRANCH', 'ROLE', 'PERSON');

-- CreateEnum
CREATE TYPE "SignatureSyncStatus" AS ENUM ('PENDING', 'SYNCED', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "signature_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "layout" TEXT NOT NULL DEFAULT 'CLASSIC',
    "color" TEXT NOT NULL DEFAULT '#1d4ed8',
    "font" TEXT NOT NULL DEFAULT 'arial',
    "recordFields" JSONB NOT NULL DEFAULT '[]',
    "website" TEXT,
    "logoUrl" TEXT,
    "social" JSONB NOT NULL DEFAULT '{}',
    "ctaLabel" TEXT,
    "ctaUrl" TEXT,
    "signOff" TEXT,
    "disclaimer" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signature_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature_rules" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "target" "SignatureRuleTarget" NOT NULL,
    "targetId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signature_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "provider" TEXT,
    "googleServiceEmail" TEXT,
    "googleKeyCipher" TEXT,
    "zohoRefreshCipher" TEXT,
    "zohoOrgId" TEXT,
    "zohoAdminEmail" TEXT,
    "autoSync" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "lastError" TEXT,
    "connectedById" TEXT,
    "connectedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signature_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature_syncs" (
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "SignatureSyncStatus" NOT NULL DEFAULT 'PENDING',
    "syncedHash" TEXT,
    "syncedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "zohoSignatureId" TEXT,
    "zohoAccountId" TEXT,
    "claimedUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signature_syncs_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX "signature_rules_templateId_idx" ON "signature_rules"("templateId");

-- CreateIndex
CREATE UNIQUE INDEX "signature_rules_target_targetId_key" ON "signature_rules"("target", "targetId");

-- CreateIndex
CREATE INDEX "signature_syncs_status_idx" ON "signature_syncs"("status");

-- AddForeignKey
ALTER TABLE "signature_rules" ADD CONSTRAINT "signature_rules_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "signature_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_syncs" ADD CONSTRAINT "signature_syncs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Written by hand: exactly one default template — the one everybody gets unless a rule says otherwise.
CREATE UNIQUE INDEX "signature_templates_one_default" ON "signature_templates"((true)) WHERE "isDefault";

-- CreateEnum
CREATE TYPE "LeadSource" AS ENUM ('WEBSITE', 'REFERRAL', 'LINKEDIN', 'CALLING', 'EMAIL', 'EVENT', 'PARTNER', 'ADVERTISEMENT', 'EXISTING_CUSTOMER', 'WALK_IN', 'OTHER');

-- CreateEnum
CREATE TYPE "LeadAssignmentStrategy" AS ENUM ('ROUND_ROBIN', 'LEAST_LOADED', 'SPECIFIC_USER');

-- AlterTable
ALTER TABLE "companies" ALTER COLUMN "paymentTerms" SET DEFAULT 'ADVANCE';

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "assignmentNote" TEXT,
ADD COLUMN     "captureKeyId" TEXT,
ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "score" INTEGER,
ADD COLUMN     "scoreUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "source" "LeadSource" NOT NULL DEFAULT 'OTHER',
ADD COLUMN     "sourceDetail" TEXT;

-- CreateTable
CREATE TABLE "lead_capture_keys" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "secretDigest" TEXT NOT NULL,
    "sourceLabel" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMP(3),
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "lead_capture_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_assignment_rules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "brandIds" TEXT[],
    "itemTypes" "ItemType"[],
    "designations" "ContactDesignation"[],
    "sources" "LeadSource"[],
    "states" TEXT[],
    "strategy" "LeadAssignmentStrategy" NOT NULL DEFAULT 'ROUND_ROBIN',
    "userIds" TEXT[],
    "skipOnLeave" BOOLEAN NOT NULL DEFAULT true,
    "rrCursor" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_assignment_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lead_capture_keys_keyId_key" ON "lead_capture_keys"("keyId");

-- CreateIndex
CREATE INDEX "lead_assignment_rules_active_priority_idx" ON "lead_assignment_rules"("active", "priority");

-- CreateIndex
CREATE INDEX "leads_score_idx" ON "leads"("score");

-- CreateIndex
CREATE INDEX "leads_source_idx" ON "leads"("source");

-- CreateIndex
CREATE UNIQUE INDEX "leads_captureKeyId_externalId_key" ON "leads"("captureKeyId", "externalId");

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_captureKeyId_fkey" FOREIGN KEY ("captureKeyId") REFERENCES "lead_capture_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill: where existing leads came from.
--
-- There was no lead-level source before this, so the best evidence is how the lead's *account* was
-- found. An inbound company's leads came in through the website; the rest carry their company's
-- channel. Leads that arrived through a marketing form are then set precisely, with the form's name.
UPDATE "leads" AS l
SET "source" = CASE c."source"
    WHEN 'LINKEDIN' THEN 'LINKEDIN'::"LeadSource"
    WHEN 'REFERRAL' THEN 'REFERRAL'::"LeadSource"
    WHEN 'INBOUND'  THEN 'WEBSITE'::"LeadSource"
    ELSE 'OTHER'::"LeadSource"
  END
FROM "companies" AS c
WHERE c."id" = l."companyId";

UPDATE "leads" AS l
SET "source" = 'WEBSITE'::"LeadSource",
    "sourceDetail" = 'Form: ' || f."name"
FROM "marketing_form_submissions" AS s
JOIN "marketing_forms" AS f ON f."id" = s."formId"
WHERE s."leadId" = l."id";

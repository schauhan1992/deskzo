-- Owner, 8 Oct 2026: designations from a list of the workspace's own, a person's record linked to the
-- one at their previous company, custom fields for vendors, and reminders that chime.

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'MEETING_SOON';

-- AlterEnum
ALTER TYPE "CustomFieldEntity" ADD VALUE 'VENDOR';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "reminderSounds" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "designationId" TEXT,
ADD COLUMN     "previousContactId" TEXT;

-- CreateTable
CREATE TABLE "designations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ContactDesignation" NOT NULL DEFAULT 'OTHER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "designations_pkey" PRIMARY KEY ("id")
);

-- One of each name, whatever its capitals. Not expressible in the Prisma schema.
CREATE UNIQUE INDEX "designations_name_key" ON "designations"(lower("name"));

-- CreateIndex
CREATE UNIQUE INDEX "contacts_previousContactId_key" ON "contacts"("previousContactId");

-- CreateIndex
CREATE INDEX "contacts_designationId_idx" ON "contacts"("designationId");

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_designationId_fkey" FOREIGN KEY ("designationId") REFERENCES "designations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_previousContactId_fkey" FOREIGN KEY ("previousContactId") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The designations every workspace starts with: the seven the fixed list had, each its own type.
-- "Other" is no designation, so it is not one of them.
INSERT INTO "designations" ("id", "name", "kind", "createdAt", "updatedAt") VALUES
  ('des-it-manager', 'IT Manager', 'IT_MANAGER', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('des-purchase-manager', 'Purchase Manager', 'PURCHASE_MANAGER', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('des-it-head', 'IT Head', 'IT_HEAD', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('des-director', 'Director', 'DIRECTOR', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('des-ceo', 'CEO', 'CEO', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('des-cio', 'CIO', 'CIO', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('des-hr', 'HR', 'HR', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;

-- Every contact keeps the designation it had, now from the list.
UPDATE "contacts" c SET "designationId" = d."id"
FROM "designations" d
WHERE c."designationId" IS NULL AND c."designation" <> 'OTHER' AND d."kind" = c."designation" AND d."id" LIKE 'des-%';

-- CreateEnum
CREATE TYPE "FormCategory" AS ENUM ('ENQUIRY', 'EVENT', 'ASSESSMENT', 'SURVEY', 'OTHER');

-- CreateEnum
CREATE TYPE "FormFillMode" AS ENUM ('LINK', 'INVITE', 'BOTH');

-- CreateEnum
CREATE TYPE "FormAttendance" AS ENUM ('ATTENDED', 'NO_SHOW');

-- AlterTable
ALTER TABLE "marketing_form_submissions" ADD COLUMN     "attendance" "FormAttendance",
ADD COLUMN     "attendanceMarkedAt" TIMESTAMP(3),
ADD COLUMN     "attendanceMarkedById" TEXT,
ADD COLUMN     "attending" BOOLEAN,
ADD COLUMN     "inviteId" TEXT,
ADD COLUMN     "recordedById" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "marketing_forms" ADD COLUMN     "capacity" INTEGER,
ADD COLUMN     "category" "FormCategory" NOT NULL DEFAULT 'ENQUIRY',
ADD COLUMN     "closesAt" TIMESTAMP(3),
ADD COLUMN     "eventEndsAt" TIMESTAMP(3),
ADD COLUMN     "eventStartsAt" TIMESTAMP(3),
ADD COLUMN     "fillMode" "FormFillMode" NOT NULL DEFAULT 'LINK',
ADD COLUMN     "ownerUserId" TEXT,
ADD COLUMN     "venue" TEXT;

-- Every existing form belongs to whoever built it.
UPDATE "marketing_forms" SET "ownerUserId" = "createdById" WHERE "ownerUserId" IS NULL;
ALTER TABLE "marketing_forms" ALTER COLUMN "ownerUserId" SET NOT NULL;

-- A seat limit of zero or less is a form nobody can register for.
ALTER TABLE "marketing_forms" ADD CONSTRAINT "marketing_forms_capacity_positive" CHECK ("capacity" IS NULL OR "capacity" > 0);

-- AlterTable
ALTER TABLE "marketing_messages" ADD COLUMN     "formInviteId" TEXT;

-- CreateTable
CREATE TABLE "form_access_grants" (
    "id" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "userId" TEXT,
    "roleKey" TEXT,
    "canEdit" BOOLEAN NOT NULL DEFAULT false,
    "canViewResponses" BOOLEAN NOT NULL DEFAULT false,
    "canInvite" BOOLEAN NOT NULL DEFAULT false,
    "grantedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "form_access_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_invites" (
    "id" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "invitedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSentAt" TIMESTAMP(3),
    "sendCount" INTEGER NOT NULL DEFAULT 0,
    "openedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "form_invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "form_access_grants_userId_idx" ON "form_access_grants"("userId");

-- CreateIndex
CREATE INDEX "form_access_grants_roleKey_idx" ON "form_access_grants"("roleKey");

-- CreateIndex
CREATE UNIQUE INDEX "form_access_grants_formId_userId_key" ON "form_access_grants"("formId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "form_access_grants_formId_roleKey_key" ON "form_access_grants"("formId", "roleKey");

-- CreateIndex
CREATE UNIQUE INDEX "form_invites_token_key" ON "form_invites"("token");

-- CreateIndex
CREATE INDEX "form_invites_companyId_idx" ON "form_invites"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "form_invites_formId_contactId_key" ON "form_invites"("formId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_form_submissions_inviteId_key" ON "marketing_form_submissions"("inviteId");

-- CreateIndex
CREATE INDEX "marketing_form_submissions_companyId_idx" ON "marketing_form_submissions"("companyId");

-- CreateIndex
CREATE INDEX "marketing_forms_ownerUserId_idx" ON "marketing_forms"("ownerUserId");

-- CreateIndex
CREATE INDEX "marketing_messages_formInviteId_idx" ON "marketing_messages"("formInviteId");

-- AddForeignKey
ALTER TABLE "marketing_messages" ADD CONSTRAINT "marketing_messages_formInviteId_fkey" FOREIGN KEY ("formInviteId") REFERENCES "form_invites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_forms" ADD CONSTRAINT "marketing_forms_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_access_grants" ADD CONSTRAINT "form_access_grants_formId_fkey" FOREIGN KEY ("formId") REFERENCES "marketing_forms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_access_grants" ADD CONSTRAINT "form_access_grants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_access_grants" ADD CONSTRAINT "form_access_grants_roleKey_fkey" FOREIGN KEY ("roleKey") REFERENCES "roles"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_access_grants" ADD CONSTRAINT "form_access_grants_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_invites" ADD CONSTRAINT "form_invites_formId_fkey" FOREIGN KEY ("formId") REFERENCES "marketing_forms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_invites" ADD CONSTRAINT "form_invites_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_invites" ADD CONSTRAINT "form_invites_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_invites" ADD CONSTRAINT "form_invites_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_form_submissions" ADD CONSTRAINT "marketing_form_submissions_inviteId_fkey" FOREIGN KEY ("inviteId") REFERENCES "form_invites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_form_submissions" ADD CONSTRAINT "marketing_form_submissions_attendanceMarkedById_fkey" FOREIGN KEY ("attendanceMarkedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_form_submissions" ADD CONSTRAINT "marketing_form_submissions_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A grant is to one person or to one role: never both, never neither.
ALTER TABLE "form_access_grants" ADD CONSTRAINT "form_access_grants_one_subject" CHECK (("userId" IS NULL) <> ("roleKey" IS NULL));

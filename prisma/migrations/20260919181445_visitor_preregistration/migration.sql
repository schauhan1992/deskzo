-- CreateEnum
CREATE TYPE "VisitorInviteStatus" AS ENUM ('PENDING', 'ARRIVED', 'CANCELLED', 'EXPIRED');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'VISITOR_EXPECTED';

-- AlterTable
ALTER TABLE "visitor_kiosks" ADD COLUMN     "failedLookups" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "failedSince" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "visitor_invites" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "purpose" "VisitorPurpose" NOT NULL DEFAULT 'MEETING',
    "hostUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "company" TEXT,
    "note" TEXT,
    "expectedAt" TIMESTAMP(3) NOT NULL,
    "expectedCompanions" INTEGER NOT NULL DEFAULT 0,
    "status" "VisitorInviteStatus" NOT NULL DEFAULT 'PENDING',
    "entryId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "visitor_invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "visitor_invites_code_key" ON "visitor_invites"("code");

-- CreateIndex
CREATE UNIQUE INDEX "visitor_invites_entryId_key" ON "visitor_invites"("entryId");

-- CreateIndex
CREATE INDEX "visitor_invites_hostUserId_idx" ON "visitor_invites"("hostUserId");

-- CreateIndex
CREATE INDEX "visitor_invites_expectedAt_idx" ON "visitor_invites"("expectedAt");

-- CreateIndex
CREATE INDEX "visitor_invites_status_idx" ON "visitor_invites"("status");

-- AddForeignKey
ALTER TABLE "visitor_invites" ADD CONSTRAINT "visitor_invites_hostUserId_fkey" FOREIGN KEY ("hostUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visitor_invites" ADD CONSTRAINT "visitor_invites_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "visitor_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visitor_invites" ADD CONSTRAINT "visitor_invites_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

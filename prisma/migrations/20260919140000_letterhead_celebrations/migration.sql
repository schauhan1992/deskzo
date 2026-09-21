-- CreateEnum
CREATE TYPE "CelebrationKind" AS ENUM ('ACHIEVEMENT', 'FESTIVAL', 'MILESTONE', 'WELCOME', 'ANNOUNCEMENT');

-- CreateEnum
CREATE TYPE "CelebrationAudience" AS ENUM ('EVERYONE', 'DEPARTMENT', 'PERSON');

-- AlterTable
ALTER TABLE "organisation_settings" ADD COLUMN     "letterNumberPrefix" TEXT NOT NULL DEFAULT 'WRF',
ADD COLUMN     "letterSignatoryName" TEXT,
ADD COLUMN     "letterSignatoryTitle" TEXT,
ADD COLUMN     "letterheadFooter" TEXT,
ADD COLUMN     "letterheadLogoDataUrl" TEXT;

-- CreateTable
CREATE TABLE "celebrations" (
    "id" TEXT NOT NULL,
    "kind" "CelebrationKind" NOT NULL,
    "audience" "CelebrationAudience" NOT NULL DEFAULT 'EVERYONE',
    "title" TEXT NOT NULL,
    "message" TEXT,
    "imageDataUrl" TEXT,
    "accent" TEXT,
    "subjectUserId" TEXT,
    "departmentId" TEXT,
    "startsOn" DATE NOT NULL,
    "endsOn" DATE NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "celebrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "celebration_seen" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "occasionKey" TEXT NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "celebration_seen_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "celebrations_active_startsOn_endsOn_idx" ON "celebrations"("active", "startsOn", "endsOn");

-- CreateIndex
CREATE INDEX "celebration_seen_userId_idx" ON "celebration_seen"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "celebration_seen_userId_occasionKey_key" ON "celebration_seen"("userId", "occasionKey");

-- AddForeignKey
ALTER TABLE "celebrations" ADD CONSTRAINT "celebrations_subjectUserId_fkey" FOREIGN KEY ("subjectUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "celebrations" ADD CONSTRAINT "celebrations_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "celebrations" ADD CONSTRAINT "celebrations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "celebration_seen" ADD CONSTRAINT "celebration_seen_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


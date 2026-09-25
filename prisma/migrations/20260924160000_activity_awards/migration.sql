-- CreateEnum
CREATE TYPE "AwardAudience" AS ENUM ('EVERYONE', 'MANAGERS', 'WINNERS');

-- AlterEnum
ALTER TYPE "CelebrationSource" ADD VALUE 'MOST_ACTIVE';

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'ACTIVITY_AWARD';

-- CreateTable
CREATE TABLE "activity_award_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "audience" "AwardAudience" NOT NULL DEFAULT 'EVERYONE',
    "topCount" INTEGER NOT NULL DEFAULT 3,
    "splash" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "activity_award_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_awards" (
    "id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "from" TIMESTAMP(3) NOT NULL,
    "to" TIMESTAMP(3) NOT NULL,
    "overall" JSONB NOT NULL,
    "areas" JSONB NOT NULL,
    "audience" "AwardAudience" NOT NULL,
    "announcedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_awards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "activity_awards_period_key" ON "activity_awards"("period");

-- CreateIndex
CREATE INDEX "activity_awards_announcedAt_idx" ON "activity_awards"("announcedAt");

-- AddForeignKey
ALTER TABLE "activity_award_settings" ADD CONSTRAINT "activity_award_settings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

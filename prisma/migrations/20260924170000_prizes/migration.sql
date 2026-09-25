-- CreateEnum
CREATE TYPE "PrizeRace" AS ENUM ('MOST_ACTIVE', 'TOP_SELLERS');

-- AlterEnum
ALTER TYPE "CelebrationSource" ADD VALUE 'PRIZES';

-- CreateTable
CREATE TABLE "prizes" (
    "id" TEXT NOT NULL,
    "race" "PrizeRace" NOT NULL,
    "period" TEXT NOT NULL DEFAULT '',
    "slot" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "note" TEXT,
    "imageDataUrl" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prizes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prize_winners" (
    "id" TEXT NOT NULL,
    "race" "PrizeRace" NOT NULL,
    "period" TEXT NOT NULL,
    "periodLabel" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "score" DECIMAL(14,2) NOT NULL,
    "prizeName" TEXT,
    "prizeNote" TEXT,
    "prizeImage" TEXT,
    "audience" "AwardAudience" NOT NULL,
    "handedOverAt" TIMESTAMP(3),
    "handedOverById" TEXT,
    "announcedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prize_winners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prize_announcements" (
    "id" TEXT NOT NULL,
    "race" "PrizeRace" NOT NULL,
    "period" TEXT NOT NULL,
    "autoKey" TEXT,
    "announcedById" TEXT,
    "announcedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prize_announcements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "prizes_race_period_slot_key" ON "prizes"("race", "period", "slot");

-- CreateIndex
CREATE INDEX "prize_winners_userId_idx" ON "prize_winners"("userId");

-- CreateIndex
CREATE INDEX "prize_winners_announcedAt_idx" ON "prize_winners"("announcedAt");

-- CreateIndex
CREATE UNIQUE INDEX "prize_winners_race_period_slot_key" ON "prize_winners"("race", "period", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "prize_announcements_autoKey_key" ON "prize_announcements"("autoKey");

-- CreateIndex
CREATE INDEX "prize_announcements_race_announcedAt_idx" ON "prize_announcements"("race", "announcedAt");

-- AddForeignKey
ALTER TABLE "prizes" ADD CONSTRAINT "prizes_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prize_winners" ADD CONSTRAINT "prize_winners_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prize_winners" ADD CONSTRAINT "prize_winners_handedOverById_fkey" FOREIGN KEY ("handedOverById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prize_announcements" ADD CONSTRAINT "prize_announcements_announcedById_fkey" FOREIGN KEY ("announcedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Deskzo Cards: events the team works (a trade show, a conference), who works them, and where each card contact came from.

-- CreateEnum
CREATE TYPE "CardContactVia" AS ENUM ('SHARE_BACK', 'BOOTH', 'SCAN');

-- AlterTable
ALTER TABLE "card_contacts" ADD COLUMN     "campaignId" TEXT,
ADD COLUMN     "via" "CardContactVia" NOT NULL DEFAULT 'SHARE_BACK',
ALTER COLUMN "cardId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "card_campaigns" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "venue" TEXT,
    "startsOn" DATE NOT NULL,
    "endsOn" DATE NOT NULL,
    "goal" INTEGER,
    "cost" DECIMAL(14,2),
    "code" TEXT NOT NULL,
    "questions" JSONB NOT NULL DEFAULT '[]',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "card_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "card_campaign_members" (
    "campaignId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "card_campaign_members_pkey" PRIMARY KEY ("campaignId","userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "card_campaigns_code_key" ON "card_campaigns"("code");

-- CreateIndex
CREATE INDEX "card_campaigns_startsOn_endsOn_idx" ON "card_campaigns"("startsOn", "endsOn");

-- CreateIndex
CREATE INDEX "card_campaign_members_userId_idx" ON "card_campaign_members"("userId");

-- CreateIndex
CREATE INDEX "card_contacts_campaignId_createdAt_idx" ON "card_contacts"("campaignId", "createdAt");

-- AddForeignKey
ALTER TABLE "card_contacts" ADD CONSTRAINT "card_contacts_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "card_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_campaign_members" ADD CONSTRAINT "card_campaign_members_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "card_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_campaign_members" ADD CONSTRAINT "card_campaign_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Written by hand: an event ends on or after the day it starts; a goal is a number of people, a cost is never negative.
ALTER TABLE "card_campaigns" ADD CONSTRAINT "card_campaigns_sane" CHECK ("endsOn" >= "startsOn" AND ("goal" IS NULL OR "goal" > 0) AND ("cost" IS NULL OR "cost" >= 0));

-- Written by hand: only a scan can come without a card — a share-back and a booth form are always some card's.
ALTER TABLE "card_contacts" ADD CONSTRAINT "card_contacts_card_unless_scanned" CHECK ("cardId" IS NOT NULL OR "via" = 'SCAN');

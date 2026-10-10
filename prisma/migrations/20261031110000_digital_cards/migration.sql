-- Deskzo Cards: card templates, digital cards, what happens on a card's page, and who shared back.

-- CreateEnum
CREATE TYPE "DigitalCardStatus" AS ENUM ('ACTIVE', 'OFF');

-- CreateEnum
CREATE TYPE "CardEventKind" AS ENUM ('VIEW', 'SAVE', 'TAP', 'SHARE_BACK');

-- AlterEnum
ALTER TYPE "LeadSource" ADD VALUE 'DIGITAL_CARD';

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'CARD_SHARED_BACK';

-- CreateTable
CREATE TABLE "card_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "color" TEXT NOT NULL DEFAULT '#1d4ed8',
    "layout" TEXT NOT NULL DEFAULT 'CLASSIC',
    "showLogo" BOOLEAN NOT NULL DEFAULT true,
    "recordFields" JSONB NOT NULL DEFAULT '[]',
    "sharedFields" JSONB NOT NULL DEFAULT '[]',
    "allowOwnFields" BOOLEAN NOT NULL DEFAULT true,
    "shareBack" BOOLEAN NOT NULL DEFAULT true,
    "questions" JSONB NOT NULL DEFAULT '[]',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "card_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "digital_cards" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "status" "DigitalCardStatus" NOT NULL DEFAULT 'ACTIVE',
    "ownFields" JSONB NOT NULL DEFAULT '[]',
    "hidden" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "issuedById" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "switchedOffAt" TIMESTAMP(3),
    "switchedOffById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "digital_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "card_events" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "kind" "CardEventKind" NOT NULL,
    "detail" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "card_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "card_contacts" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "company" TEXT,
    "jobTitle" TEXT,
    "message" TEXT,
    "answers" JSONB NOT NULL DEFAULT '[]',
    "note" TEXT,
    "leadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "card_contacts_pkey" PRIMARY KEY ("id")
);

-- Written by hand: exactly one default template — the one a new card is drawn from.
CREATE UNIQUE INDEX "card_templates_one_default" ON "card_templates"((true)) WHERE "isDefault";

-- Written by hand: a card address is lower-case letters and digits with single hyphens between, 3 to 40 long.
ALTER TABLE "digital_cards" ADD CONSTRAINT "digital_cards_handle_shape" CHECK ("handle" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("handle") BETWEEN 3 AND 40);

-- CreateIndex
CREATE UNIQUE INDEX "digital_cards_userId_key" ON "digital_cards"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "digital_cards_handle_key" ON "digital_cards"("handle");

-- CreateIndex
CREATE INDEX "digital_cards_templateId_idx" ON "digital_cards"("templateId");

-- CreateIndex
CREATE INDEX "digital_cards_status_idx" ON "digital_cards"("status");

-- CreateIndex
CREATE INDEX "card_events_cardId_at_idx" ON "card_events"("cardId", "at");

-- CreateIndex
CREATE INDEX "card_events_at_idx" ON "card_events"("at");

-- CreateIndex
CREATE INDEX "card_contacts_ownerUserId_createdAt_idx" ON "card_contacts"("ownerUserId", "createdAt");

-- CreateIndex
CREATE INDEX "card_contacts_cardId_createdAt_idx" ON "card_contacts"("cardId", "createdAt");

-- CreateIndex
CREATE INDEX "card_contacts_leadId_idx" ON "card_contacts"("leadId");

-- AddForeignKey
ALTER TABLE "digital_cards" ADD CONSTRAINT "digital_cards_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "digital_cards" ADD CONSTRAINT "digital_cards_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "card_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_events" ADD CONSTRAINT "card_events_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "digital_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_contacts" ADD CONSTRAINT "card_contacts_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "digital_cards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_contacts" ADD CONSTRAINT "card_contacts_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_contacts" ADD CONSTRAINT "card_contacts_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

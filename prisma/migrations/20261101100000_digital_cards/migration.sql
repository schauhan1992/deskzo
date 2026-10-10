-- Deskzo Cards (owner, 10 Oct 2026; docs/digital-cards-and-signatures.md §3): a digital business card
-- per person HR or an admin switches on, its templates, what happens on its public page, and the
-- people who share their details back. Four new tables, one enum and one lead source; no existing
-- table changes, so a workspace not yet migrated reads exactly as before. Nobody has a card until
-- somebody issues one.

-- AlterEnum
ALTER TYPE "LeadSource" ADD VALUE 'DIGITAL_CARD';

-- CreateEnum
CREATE TYPE "CardEventKind" AS ENUM ('VIEW', 'SAVE', 'TAP', 'SHARE_BACK');

-- CreateTable
CREATE TABLE "card_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accentColor" TEXT NOT NULL DEFAULT '#2563eb',
    "coverColor" TEXT NOT NULL DEFAULT '#0f172a',
    "showLogo" BOOLEAN NOT NULL DEFAULT true,
    "fields" JSONB NOT NULL,
    "questions" JSONB NOT NULL DEFAULT '[]',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "card_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "digital_cards" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "values" JSONB NOT NULL DEFAULT '{}',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedById" TEXT,
    "switchedOffAt" TIMESTAMP(3),
    "switchedOffWhy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "digital_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "card_events" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "kind" "CardEventKind" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "card_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "card_contacts" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "companyName" TEXT,
    "answers" JSONB NOT NULL DEFAULT '[]',
    "note" TEXT,
    "leadId" TEXT,
    "sourceHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "card_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "card_templates_name_key" ON "card_templates"("name");

-- CreateIndex
CREATE UNIQUE INDEX "digital_cards_userId_key" ON "digital_cards"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "digital_cards_slug_key" ON "digital_cards"("slug");

-- CreateIndex
CREATE INDEX "digital_cards_templateId_idx" ON "digital_cards"("templateId");

-- CreateIndex
CREATE INDEX "digital_cards_issuedById_idx" ON "digital_cards"("issuedById");

-- CreateIndex
CREATE INDEX "card_events_cardId_kind_createdAt_idx" ON "card_events"("cardId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "card_contacts_cardId_createdAt_idx" ON "card_contacts"("cardId", "createdAt");

-- CreateIndex
CREATE INDEX "card_contacts_leadId_idx" ON "card_contacts"("leadId");

-- AddForeignKey
ALTER TABLE "digital_cards" ADD CONSTRAINT "digital_cards_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "digital_cards" ADD CONSTRAINT "digital_cards_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "card_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "digital_cards" ADD CONSTRAINT "digital_cards_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_events" ADD CONSTRAINT "card_events_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "digital_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_contacts" ADD CONSTRAINT "card_contacts_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "digital_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_contacts" ADD CONSTRAINT "card_contacts_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

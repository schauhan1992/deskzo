-- The Customer inbox (owner, 24 Oct 2026): website chat with its bot, and WhatsApp, in one inbox
-- (src/lib/inbox). New tables only, plus three enum values: safe on a workspace not migrated yet.

-- CreateEnum
CREATE TYPE "InboxChannelKind" AS ENUM ('WEB', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "ConversationAuthor" AS ENUM ('CUSTOMER', 'AGENT', 'BOT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ConversationDelivery" AS ENUM ('SENT', 'DELIVERED', 'READ', 'FAILED');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'INBOX_MESSAGE';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LeadSource" ADD VALUE 'WHATSAPP';
ALTER TYPE "LeadSource" ADD VALUE 'LIVE_CHAT';

-- CreateTable
CREATE TABLE "inbox_channels" (
    "id" TEXT NOT NULL,
    "kind" "InboxChannelKind" NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "publicKey" TEXT,
    "phoneNumberId" TEXT,
    "displayPhone" TEXT,
    "ownerUserId" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inbox_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "channelId" TEXT NOT NULL,
    "kind" "InboxChannelKind" NOT NULL,
    "status" "ConversationStatus" NOT NULL DEFAULT 'OPEN',
    "assignedToUserId" TEXT,
    "contactId" TEXT,
    "companyId" TEXT,
    "leadId" TEXT,
    "ticketId" TEXT,
    "customerName" TEXT,
    "customerEmail" TEXT,
    "customerPhone" TEXT,
    "waId" TEXT,
    "visitorTokenHash" TEXT,
    "pageUrl" TEXT,
    "botActive" BOOLEAN NOT NULL DEFAULT false,
    "botState" JSONB,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCustomerAt" TIMESTAMP(3),
    "firstResponseAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "author" "ConversationAuthor" NOT NULL,
    "userId" TEXT,
    "body" TEXT NOT NULL,
    "templateName" TEXT,
    "externalId" TEXT,
    "delivery" "ConversationDelivery",
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_reads" (
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_reads_pkey" PRIMARY KEY ("conversationId","userId")
);

-- CreateTable
CREATE TABLE "inbox_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "whatsappVerifyToken" TEXT NOT NULL,
    "whatsappAppSecretCipher" TEXT,
    "whatsappTokenCipher" TEXT,
    "whatsappLanguage" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inbox_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inbox_channels_publicKey_key" ON "inbox_channels"("publicKey");

-- CreateIndex
CREATE UNIQUE INDEX "inbox_channels_phoneNumberId_key" ON "inbox_channels"("phoneNumberId");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_seq_key" ON "conversations"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_visitorTokenHash_key" ON "conversations"("visitorTokenHash");

-- CreateIndex
CREATE INDEX "conversations_status_lastMessageAt_idx" ON "conversations"("status", "lastMessageAt");

-- CreateIndex
CREATE INDEX "conversations_assignedToUserId_status_idx" ON "conversations"("assignedToUserId", "status");

-- CreateIndex
CREATE INDEX "conversations_channelId_waId_idx" ON "conversations"("channelId", "waId");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_messages_externalId_key" ON "conversation_messages"("externalId");

-- CreateIndex
CREATE INDEX "conversation_messages_conversationId_createdAt_idx" ON "conversation_messages"("conversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "inbox_channels" ADD CONSTRAINT "inbox_channels_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "inbox_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_reads" ADD CONSTRAINT "conversation_reads_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_reads" ADD CONSTRAINT "conversation_reads_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Tickets by email (owner, 5 Oct 2026): every workspace's helpdesk gets an address, <slug>@<INBOUND_MAIL_DOMAIN>
-- (tickets.deskzo.com), that its support mail is forwarded to (src/lib/support-mail). Three new tables and a
-- notification type: the workspace's settings for it, every email in a ticket's conversation either way (or
-- waiting in the Support inbox), and the files that came with them. Nothing existing changes.

-- CreateEnum
CREATE TYPE "SupportEmailDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "SupportEmailState" AS ENUM ('NEW_TICKET', 'REPLY', 'INBOX', 'IGNORED', 'SENT', 'FAILED');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'TICKET_EMAIL';

-- CreateTable
CREATE TABLE "support_mail_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "acknowledge" BOOLEAN NOT NULL DEFAULT true,
    "defaultAssigneeUserId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_mail_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_emails" (
    "id" TEXT NOT NULL,
    "direction" "SupportEmailDirection" NOT NULL,
    "state" "SupportEmailState" NOT NULL,
    "ticketId" TEXT,
    "contactId" TEXT,
    "fromAddress" TEXT NOT NULL,
    "fromName" TEXT,
    "toAddresses" TEXT[],
    "ccAddresses" TEXT[],
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "messageId" TEXT,
    "inReplyTo" TEXT,
    "references" TEXT[],
    "note" TEXT,
    "sentByUserId" TEXT,
    "handledById" TEXT,
    "handledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_emails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_email_attachments" (
    "id" TEXT NOT NULL,
    "emailId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "dataUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_email_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "support_emails_messageId_key" ON "support_emails"("messageId");

-- CreateIndex
CREATE INDEX "support_emails_ticketId_createdAt_idx" ON "support_emails"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "support_emails_state_createdAt_idx" ON "support_emails"("state", "createdAt");

-- CreateIndex
CREATE INDEX "support_emails_fromAddress_createdAt_idx" ON "support_emails"("fromAddress", "createdAt");

-- CreateIndex
CREATE INDEX "support_email_attachments_emailId_idx" ON "support_email_attachments"("emailId");

-- AddForeignKey
ALTER TABLE "support_mail_settings" ADD CONSTRAINT "support_mail_settings_defaultAssigneeUserId_fkey" FOREIGN KEY ("defaultAssigneeUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_emails" ADD CONSTRAINT "support_emails_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_emails" ADD CONSTRAINT "support_emails_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_emails" ADD CONSTRAINT "support_emails_sentByUserId_fkey" FOREIGN KEY ("sentByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_emails" ADD CONSTRAINT "support_emails_handledById_fkey" FOREIGN KEY ("handledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_email_attachments" ADD CONSTRAINT "support_email_attachments_emailId_fkey" FOREIGN KEY ("emailId") REFERENCES "support_emails"("id") ON DELETE CASCADE ON UPDATE CASCADE;


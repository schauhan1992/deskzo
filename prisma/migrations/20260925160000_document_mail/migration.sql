-- CreateEnum
CREATE TYPE "MailConnectionProvider" AS ENUM ('MICROSOFT');

-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "receivesDocuments" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "marketing_messages" ADD COLUMN     "fromEmail" TEXT,
ADD COLUMN     "tradeDocumentId" TEXT;

-- AlterTable
ALTER TABLE "trade_documents" ADD COLUMN     "lastEmailedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "mail_connections" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "MailConnectionProvider" NOT NULL DEFAULT 'MICROSOFT',
    "mailbox" TEXT NOT NULL,
    "displayName" TEXT,
    "refreshTokenCipher" TEXT NOT NULL,
    "accessTokenCipher" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "scopes" TEXT NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "brokenAt" TIMESTAMP(3),
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mail_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_email_templates" (
    "docType" "TradeDocumentType" NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_email_templates_pkey" PRIMARY KEY ("docType")
);

-- CreateTable
CREATE TABLE "document_render_grants" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_render_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mail_connections_userId_key" ON "mail_connections"("userId");

-- CreateIndex
CREATE INDEX "document_render_grants_expiresAt_idx" ON "document_render_grants"("expiresAt");

-- CreateIndex
CREATE INDEX "marketing_messages_tradeDocumentId_idx" ON "marketing_messages"("tradeDocumentId");

-- AddForeignKey
ALTER TABLE "marketing_messages" ADD CONSTRAINT "marketing_messages_tradeDocumentId_fkey" FOREIGN KEY ("tradeDocumentId") REFERENCES "trade_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_connections" ADD CONSTRAINT "mail_connections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_email_templates" ADD CONSTRAINT "document_email_templates_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_render_grants" ADD CONSTRAINT "document_render_grants_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "trade_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_render_grants" ADD CONSTRAINT "document_render_grants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

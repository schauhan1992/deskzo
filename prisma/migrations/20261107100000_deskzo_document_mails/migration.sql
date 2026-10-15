-- CreateTable
CREATE TABLE "deskzo_document_mails" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "documentId" TEXT,
    "recipients" INTEGER NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deskzo_document_mails_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "deskzo_document_mails_sentAt_idx" ON "deskzo_document_mails"("sentAt");

-- CreateIndex
CREATE INDEX "deskzo_document_mails_userId_sentAt_idx" ON "deskzo_document_mails"("userId", "sentAt");


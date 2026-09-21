-- CreateEnum
CREATE TYPE "CallDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "CallOutcome" AS ENUM ('CONNECTED', 'NO_ANSWER', 'BUSY', 'SWITCHED_OFF', 'WRONG_NUMBER', 'LEFT_VOICEMAIL', 'CALLBACK_REQUESTED', 'NOT_INTERESTED');

-- CreateTable
CREATE TABLE "call_logs" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "contactId" TEXT,
    "leadId" TEXT,
    "ticketId" TEXT,
    "companyProductId" TEXT,
    "phoneNumber" TEXT NOT NULL,
    "direction" "CallDirection" NOT NULL DEFAULT 'OUTBOUND',
    "outcome" "CallOutcome" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "durationSeconds" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "followUpAt" TIMESTAMP(3),
    "followUpDone" BOOLEAN NOT NULL DEFAULT false,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "call_logs_companyId_startedAt_idx" ON "call_logs"("companyId", "startedAt");

-- CreateIndex
CREATE INDEX "call_logs_userId_startedAt_idx" ON "call_logs"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "call_logs_followUpAt_followUpDone_idx" ON "call_logs"("followUpAt", "followUpDone");

-- CreateIndex
CREATE INDEX "call_logs_leadId_idx" ON "call_logs"("leadId");

-- CreateIndex
CREATE INDEX "call_logs_ticketId_idx" ON "call_logs"("ticketId");

-- CreateIndex
CREATE INDEX "call_logs_contactId_idx" ON "call_logs"("contactId");

-- AddForeignKey
ALTER TABLE "call_logs" ADD CONSTRAINT "call_logs_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_logs" ADD CONSTRAINT "call_logs_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_logs" ADD CONSTRAINT "call_logs_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_logs" ADD CONSTRAINT "call_logs_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_logs" ADD CONSTRAINT "call_logs_companyProductId_fkey" FOREIGN KEY ("companyProductId") REFERENCES "company_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_logs" ADD CONSTRAINT "call_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Payment recovery (owner, 23 Oct 2026 — src/lib/collect): the business's own Razorpay or Cashfree account and its
-- pay-now links, the reminder schedule and its log, credit hold, and the MSME details late-payment interest uses.

-- A customer paid online: their salesperson and account manager are told.
ALTER TYPE "NotificationType" ADD VALUE 'PAYMENT_RECEIVED_ONLINE';

-- CreateEnum
CREATE TYPE "PaymentGatewayProvider" AS ENUM ('RAZORPAY', 'CASHFREE');

-- CreateEnum
CREATE TYPE "PaymentGatewayMode" AS ENUM ('TEST', 'LIVE');

-- CreateEnum
CREATE TYPE "PaymentLinkStatus" AS ENUM ('ACTIVE', 'PAID', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MsmeCategory" AS ENUM ('MICRO', 'SMALL', 'MEDIUM');

-- CreateEnum
CREATE TYPE "PaymentReminderStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "payment_gateways" (
    "id" TEXT NOT NULL,
    "provider" "PaymentGatewayProvider" NOT NULL,
    "mode" "PaymentGatewayMode" NOT NULL DEFAULT 'TEST',
    "keyId" TEXT NOT NULL,
    "secretEnc" TEXT NOT NULL,
    "webhookSecretEnc" TEXT,
    "bankAccountId" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "connectedByUserId" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkedAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "payment_gateways_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_links" (
    "id" TEXT NOT NULL,
    "gatewayId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "providerLinkId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "PaymentLinkStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "providerPaymentId" TEXT,
    "paymentId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkedAt" TIMESTAMP(3),

    CONSTRAINT "payment_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_settings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "remindersOn" BOOLEAN NOT NULL DEFAULT false,
    "remindersFrom" TIMESTAMP(3),
    "senderUserId" TEXT,
    "steps" JSONB,
    "statementOn" BOOLEAN NOT NULL DEFAULT true,
    "whatsappTemplate" TEXT,
    "creditHoldOn" BOOLEAN NOT NULL DEFAULT true,
    "creditHoldDays" INTEGER NOT NULL DEFAULT 60,
    "udyamNumber" TEXT,
    "msmeCategory" "MsmeCategory",
    "bankRate" DECIMAL(5,2),
    "updatedByUserId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "collection_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_reminder_pauses" (
    "companyId" TEXT NOT NULL,
    "pausedByUserId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_reminder_pauses_pkey" PRIMARY KEY ("companyId")
);

-- CreateTable
CREATE TABLE "payment_reminders" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "documentId" TEXT,
    "step" TEXT NOT NULL,
    "status" "PaymentReminderStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "sentTo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "payment_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_gateways_provider_key" ON "payment_gateways"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "payment_links_paymentId_key" ON "payment_links"("paymentId");

-- CreateIndex
CREATE INDEX "payment_links_documentId_status_idx" ON "payment_links"("documentId", "status");

-- CreateIndex
CREATE INDEX "payment_links_status_checkedAt_idx" ON "payment_links"("status", "checkedAt");

-- CreateIndex
CREATE INDEX "payment_links_companyId_idx" ON "payment_links"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_links_gatewayId_providerLinkId_key" ON "payment_links"("gatewayId", "providerLinkId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_reminders_key_key" ON "payment_reminders"("key");

-- CreateIndex
CREATE INDEX "payment_reminders_companyId_createdAt_idx" ON "payment_reminders"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "payment_reminders_documentId_idx" ON "payment_reminders"("documentId");

-- AddForeignKey
ALTER TABLE "payment_gateways" ADD CONSTRAINT "payment_gateways_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "bank_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_gatewayId_fkey" FOREIGN KEY ("gatewayId") REFERENCES "payment_gateways"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "trade_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;


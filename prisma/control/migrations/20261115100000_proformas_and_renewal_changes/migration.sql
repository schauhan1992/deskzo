-- Proformas a workspace asks for to pay by bank transfer, and subscriptions that start at the next renewal (owner, 17 Oct 2026).

-- CreateEnum
CREATE TYPE "ProformaStatus" AS ENUM ('OPEN', 'PAID', 'CANCELLED');

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "startsAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "platform_proformas" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" "ProformaStatus" NOT NULL DEFAULT 'OPEN',
    "items" JSONB NOT NULL,
    "interval" "BillingInterval" NOT NULL,
    "periods" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "details" JSONB NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "paymentId" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_proformas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_proformas_number_key" ON "platform_proformas"("number");

-- CreateIndex
CREATE UNIQUE INDEX "platform_proformas_paymentId_key" ON "platform_proformas"("paymentId");

-- CreateIndex
CREATE INDEX "platform_proformas_tenantId_status_idx" ON "platform_proformas"("tenantId", "status");

-- AddForeignKey
ALTER TABLE "platform_proformas" ADD CONSTRAINT "platform_proformas_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_proformas" ADD CONSTRAINT "platform_proformas_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "offline_payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- CreateEnum
CREATE TYPE "SuspendedFor" AS ENUM ('STAFF', 'BILLING');

-- CreateEnum
CREATE TYPE "BillingInterval" AS ENUM ('MONTH', 'YEAR');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'OPEN', 'PAID', 'VOID', 'UNCOLLECTIBLE');

-- AlterEnum
ALTER TYPE "SubscriptionStatus" ADD VALUE 'INCOMPLETE';

-- AlterTable
ALTER TABLE "pending_signups" ALTER COLUMN "inviteCodeHash" DROP NOT NULL;

-- AlterTable
ALTER TABLE "plans" ADD COLUMN     "stripeProductId" TEXT;

-- AlterTable
ALTER TABLE "subscription_items" ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "priceId" TEXT;

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "currency" TEXT,
ADD COLUMN     "externalCustomerId" TEXT,
ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "interval" "BillingInterval",
ADD COLUMN     "pastDueSince" TIMESTAMP(3),
ADD COLUMN     "syncedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "billingEmail" TEXT,
ADD COLUMN     "razorpayCustomerId" TEXT,
ADD COLUMN     "stripeCustomerId" TEXT,
ADD COLUMN     "suspendedFor" "SuspendedFor",
ADD COLUMN     "taxId" TEXT;

-- CreateTable
CREATE TABLE "plan_prices" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "gateway" "BillingGateway" NOT NULL,
    "currency" TEXT NOT NULL,
    "interval" "BillingInterval" NOT NULL,
    "amount" INTEGER NOT NULL,
    "perSeat" BOOLEAN NOT NULL DEFAULT false,
    "externalId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_events" (
    "id" TEXT NOT NULL,
    "gateway" "BillingGateway" NOT NULL,
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "tenantId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,
    "payload" JSONB NOT NULL,

    CONSTRAINT "billing_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "gateway" "BillingGateway" NOT NULL,
    "externalId" TEXT NOT NULL,
    "number" TEXT,
    "status" "InvoiceStatus" NOT NULL,
    "currency" TEXT NOT NULL,
    "subtotal" INTEGER NOT NULL,
    "tax" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL,
    "amountPaid" INTEGER NOT NULL DEFAULT 0,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "hostedUrl" TEXT,
    "pdfUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_usage" (
    "tenantId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "seatsUsed" INTEGER NOT NULL,
    "seatsLimit" INTEGER,
    "copilotTokens" INTEGER NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_usage_pkey" PRIMARY KEY ("tenantId","day")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT,
    "secretCipher" TEXT,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "billing_notices" (
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_notices_pkey" PRIMARY KEY ("tenantId","key")
);

-- CreateIndex
CREATE UNIQUE INDEX "plan_prices_externalId_key" ON "plan_prices"("externalId");

-- CreateIndex
CREATE INDEX "plan_prices_planId_idx" ON "plan_prices"("planId");

-- CreateIndex
CREATE INDEX "billing_events_receivedAt_idx" ON "billing_events"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "billing_events_gateway_eventId_key" ON "billing_events"("gateway", "eventId");

-- CreateIndex
CREATE INDEX "invoices_tenantId_issuedAt_idx" ON "invoices"("tenantId", "issuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_gateway_externalId_key" ON "invoices"("gateway", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_items_externalId_key" ON "subscription_items"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_externalId_key" ON "subscriptions"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_stripeCustomerId_key" ON "tenants"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_razorpayCustomerId_key" ON "tenants"("razorpayCustomerId");

-- AddForeignKey
ALTER TABLE "subscription_items" ADD CONSTRAINT "subscription_items_priceId_fkey" FOREIGN KEY ("priceId") REFERENCES "plan_prices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_prices" ADD CONSTRAINT "plan_prices_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_usage" ADD CONSTRAINT "tenant_usage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_notices" ADD CONSTRAINT "billing_notices_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Written by hand: what the schema cannot say.

-- One price on offer per plan, gateway, currency and interval; a replaced one is kept, inactive.
CREATE UNIQUE INDEX "plan_prices_one_active" ON "plan_prices" ("planId", "gateway", "currency", "interval") WHERE "active";
ALTER TABLE "plan_prices" ADD CONSTRAINT "plan_prices_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "plan_prices" ADD CONSTRAINT "plan_prices_gateway_charges" CHECK ("gateway" <> 'MANUAL');

-- Every hold so far was staff's.
UPDATE "tenants" SET "suspendedFor" = 'STAFF' WHERE "status" = 'SUSPENDED' AND "suspendedFor" IS NULL;

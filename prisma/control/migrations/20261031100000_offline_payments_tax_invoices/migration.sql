-- Offline payments and GST tax invoices for Deskzo's own subscriptions (owner, 12 Oct 2026).
--
--   · A payment no gateway took — a bank transfer, a cheque, a distributor paying for its customer — is
--     recorded by staff (staff only, by the owner's choice): offline_payments, each paying the workspace's
--     one OFFLINE subscription for a period, with its own paid invoice. Never deleted; a mistake is voided.
--   · Every paid rupee invoice gets a GST tax invoice: a number in the financial year's series, when, and
--     its contents frozen (invoices.taxNumber/taxIssuedAt/taxDetails). A distributor that paid is billed
--     (billToPartnerId). Refunds and voids get credit notes in their own series. document_series hands
--     out the numbers under a row lock.
--   · The workspace's registered name, address and GST state, for the invoices made out to it.

-- CreateEnum
CREATE TYPE "OfflinePaymentMethod" AS ENUM ('NEFT', 'RTGS', 'IMPS', 'UPI', 'CHEQUE', 'CASH', 'OTHER');

-- AlterEnum
ALTER TYPE "BillingGateway" ADD VALUE 'OFFLINE';

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "billToPartnerId" TEXT,
ADD COLUMN     "taxDetails" JSONB,
ADD COLUMN     "taxIssuedAt" TIMESTAMP(3),
ADD COLUMN     "taxNumber" TEXT;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "billingAddress" TEXT,
ADD COLUMN     "billingName" TEXT,
ADD COLUMN     "billingState" TEXT;

-- CreateTable
CREATE TABLE "offline_payments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "method" "OfflinePaymentMethod" NOT NULL,
    "reference" TEXT,
    "receivedOn" DATE NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "partnerId" TEXT,
    "note" TEXT,
    "recordedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedBy" TEXT,
    "voidReason" TEXT,

    CONSTRAINT "offline_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_credit_notes" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "amount" INTEGER NOT NULL,
    "tax" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_credit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_series" (
    "key" TEXT NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "document_series_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "offline_payments_subscriptionId_idx" ON "offline_payments"("subscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "offline_payments_invoiceId_key" ON "offline_payments"("invoiceId");

-- CreateIndex
CREATE INDEX "offline_payments_tenantId_createdAt_idx" ON "offline_payments"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "platform_credit_notes_number_key" ON "platform_credit_notes"("number");

-- CreateIndex
CREATE INDEX "platform_credit_notes_invoiceId_idx" ON "platform_credit_notes"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_taxNumber_key" ON "invoices"("taxNumber");

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_billToPartnerId_fkey" FOREIGN KEY ("billToPartnerId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offline_payments" ADD CONSTRAINT "offline_payments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offline_payments" ADD CONSTRAINT "offline_payments_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offline_payments" ADD CONSTRAINT "offline_payments_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offline_payments" ADD CONSTRAINT "offline_payments_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_credit_notes" ADD CONSTRAINT "platform_credit_notes_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Checks the code relies on.
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_billingState_check" CHECK ("billingState" IS NULL OR "billingState" ~ '^[0-9]{2}$');
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_billingName_check" CHECK ("billingName" IS NULL OR length("billingName") <= 200);
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_billingAddress_check" CHECK ("billingAddress" IS NULL OR length("billingAddress") <= 500);
ALTER TABLE "offline_payments" ADD CONSTRAINT "offline_payments_amount_check" CHECK ("amount" > 0);
ALTER TABLE "offline_payments" ADD CONSTRAINT "offline_payments_period_check" CHECK ("periodEnd" > "periodStart");
ALTER TABLE "offline_payments" ADD CONSTRAINT "offline_payments_reference_check" CHECK ("reference" IS NULL OR length("reference") <= 80);
ALTER TABLE "offline_payments" ADD CONSTRAINT "offline_payments_note_check" CHECK ("note" IS NULL OR length("note") <= 500);
ALTER TABLE "offline_payments" ADD CONSTRAINT "offline_payments_void_check" CHECK (("voidedAt" IS NULL) = ("voidReason" IS NULL) AND ("voidReason" IS NULL OR length("voidReason") BETWEEN 3 AND 500));
ALTER TABLE "platform_credit_notes" ADD CONSTRAINT "platform_credit_notes_amount_check" CHECK ("amount" > 0 AND "tax" >= 0 AND "tax" <= "amount");
ALTER TABLE "document_series" ADD CONSTRAINT "document_series_next_check" CHECK ("next" >= 1);

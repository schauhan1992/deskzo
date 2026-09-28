-- CreateEnum
CREATE TYPE "PartnerKind" AS ENUM ('DISTRIBUTOR', 'RESELLER');

-- CreateEnum
CREATE TYPE "PartnerStatus" AS ENUM ('ONBOARDING', 'ACTIVE', 'SUSPENDED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "PartnerRole" AS ENUM ('ADMIN', 'FINANCE', 'SALES', 'VIEWER');

-- CreateEnum
CREATE TYPE "AttributionSource" AS ENUM ('SIGNUP_INVITE', 'REFERRAL_LINK', 'DEAL_REGISTRATION', 'TERRITORY', 'STAFF');

-- CreateEnum
CREATE TYPE "DealStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED', 'WON', 'EXPIRED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "CommissionKind" AS ENUM ('DIRECT', 'OVERRIDE', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "CommissionStatus" AS ENUM ('PENDING', 'APPROVED', 'PAID', 'VOID');

-- CreateEnum
CREATE TYPE "StatementStatus" AS ENUM ('DRAFT', 'APPROVED', 'PAID', 'VOID');

-- CreateEnum
CREATE TYPE "PartnerRequestKind" AS ENUM ('PROFILE', 'PAYOUT', 'NEW_RESELLER');

-- CreateEnum
CREATE TYPE "PartnerRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "PartnerApplicationStatus" AS ENUM ('NEW', 'REVIEWING', 'ACCEPTED', 'DECLINED', 'SPAM');

-- CreateEnum
CREATE TYPE "PartnerActorKind" AS ENUM ('PARTNER', 'STAFF', 'SYSTEM', 'SCRIPT', 'PUBLIC');

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "amountCredited" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "amountRefunded" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "planLines" JSONB,
ADD COLUMN     "refundedAt" TIMESTAMP(3),
ADD COLUMN     "subscriptionId" TEXT;

-- AlterTable
ALTER TABLE "pending_signups" ADD COLUMN     "referralCode" TEXT,
ADD COLUMN     "referralVia" TEXT;

-- AlterTable
ALTER TABLE "signup_invites" ADD COLUMN     "codeHint" TEXT,
ADD COLUMN     "partnerId" TEXT;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "partnerId" TEXT;

-- CreateTable
CREATE TABLE "partners" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "kind" "PartnerKind" NOT NULL,
    "status" "PartnerStatus" NOT NULL DEFAULT 'ONBOARDING',
    "parentId" TEXT,
    "legalName" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "territories" TEXT[],
    "contactName" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT,
    "website" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "region" TEXT,
    "postalCode" TEXT,
    "taxIds" JSONB NOT NULL DEFAULT '[]',
    "payoutCipher" TEXT,
    "payoutMask" JSONB,
    "payoutUpdatedAt" TIMESTAMP(3),
    "notes" TEXT,
    "publicListing" BOOLEAN NOT NULL DEFAULT false,
    "publicBlurb" TEXT,
    "statusReason" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "activatedAt" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),
    "terminatedAt" TIMESTAMP(3),

    CONSTRAINT "partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_terms" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "defaultRateBp" INTEGER NOT NULL,
    "newRateBp" INTEGER,
    "renewalRateBp" INTEGER,
    "newMonths" INTEGER NOT NULL DEFAULT 12,
    "durationMonths" INTEGER,
    "overrideRateBp" INTEGER,
    "territoryRateBp" INTEGER,
    "planRates" JSONB NOT NULL DEFAULT '[]',
    "countryRates" JSONB NOT NULL DEFAULT '[]',
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_users" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "PartnerRole" NOT NULL,
    "passwordHash" TEXT,
    "setupTokenHash" TEXT,
    "setupExpiresAt" TIMESTAMP(3),
    "totpSecretCipher" TEXT,
    "totpEnabledAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "lastSignInAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partner_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "mfaAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "partner_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_attributions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "partnerId" TEXT,
    "source" "AttributionSource" NOT NULL,
    "reference" TEXT,
    "reason" TEXT,
    "commissionable" BOOLEAN NOT NULL DEFAULT true,
    "flags" JSONB,
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validTo" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_attributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_referral_links" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "label" TEXT,
    "planKey" TEXT,
    "expiresAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "signups" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_referral_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_deals" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "expectedPlanKey" TEXT,
    "note" TEXT,
    "status" "DealStatus" NOT NULL DEFAULT 'PENDING',
    "submittedBy" TEXT NOT NULL,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "expiresAt" TIMESTAMP(3),
    "tenantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partner_deals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_entries" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "tenantId" TEXT,
    "invoiceId" TEXT,
    "kind" "CommissionKind" NOT NULL,
    "status" "CommissionStatus" NOT NULL DEFAULT 'PENDING',
    "currency" TEXT NOT NULL,
    "base" INTEGER NOT NULL,
    "rateBp" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "basis" JSONB NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "reversesId" TEXT,
    "earnedAt" TIMESTAMP(3) NOT NULL,
    "statementId" TEXT,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedBy" TEXT,
    "voidReason" TEXT,

    CONSTRAINT "commission_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_invoice_states" (
    "invoiceId" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL,
    "base" INTEGER NOT NULL,
    "reversedBase" INTEGER NOT NULL DEFAULT 0,
    "outcome" TEXT NOT NULL,
    "seenUpdatedAt" TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clawbackExpiredAt" TIMESTAMP(3),

    CONSTRAINT "commission_invoice_states_pkey" PRIMARY KEY ("invoiceId")
);

-- CreateTable
CREATE TABLE "partner_statements" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "status" "StatementStatus" NOT NULL DEFAULT 'DRAFT',
    "entryCount" INTEGER NOT NULL,
    "earned" BIGINT NOT NULL,
    "reversed" BIGINT NOT NULL,
    "adjustments" BIGINT NOT NULL,
    "total" BIGINT NOT NULL,
    "taxLines" JSONB NOT NULL DEFAULT '[]',
    "netPayable" BIGINT NOT NULL,
    "partnerSnapshot" JSONB NOT NULL,
    "partnerInvoiceNumber" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generatedBy" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "paidAt" TIMESTAMP(3),
    "paidBy" TEXT,
    "paymentReference" TEXT,
    "paymentNote" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedBy" TEXT,
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partner_statements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_requests" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "kind" "PartnerRequestKind" NOT NULL,
    "status" "PartnerRequestStatus" NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL,
    "payloadCipher" TEXT,
    "requestedBy" TEXT NOT NULL,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "resultPartnerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partner_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_applications" (
    "id" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "website" TEXT,
    "country" TEXT NOT NULL,
    "kindWanted" "PartnerKind" NOT NULL,
    "contactName" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT,
    "message" TEXT NOT NULL,
    "status" "PartnerApplicationStatus" NOT NULL DEFAULT 'NEW',
    "notes" TEXT,
    "ip" TEXT,
    "partnerId" TEXT,
    "handledBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partner_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_audit_log" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "partnerId" TEXT,
    "actorKind" "PartnerActorKind" NOT NULL,
    "actorId" TEXT,
    "actorLabel" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "detail" JSONB,
    "visibleToPartner" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "partner_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "partners_slug_key" ON "partners"("slug");

-- CreateIndex
CREATE INDEX "partners_parentId_idx" ON "partners"("parentId");

-- CreateIndex
CREATE INDEX "partners_status_kind_idx" ON "partners"("status", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "partner_terms_partnerId_effectiveFrom_key" ON "partner_terms"("partnerId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "partner_users_email_key" ON "partner_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "partner_users_setupTokenHash_key" ON "partner_users"("setupTokenHash");

-- CreateIndex
CREATE INDEX "partner_users_partnerId_idx" ON "partner_users"("partnerId");

-- CreateIndex
CREATE INDEX "partner_sessions_userId_idx" ON "partner_sessions"("userId");

-- CreateIndex
CREATE INDEX "tenant_attributions_tenantId_validFrom_idx" ON "tenant_attributions"("tenantId", "validFrom");

-- CreateIndex
CREATE INDEX "tenant_attributions_partnerId_validTo_idx" ON "tenant_attributions"("partnerId", "validTo");

-- CreateIndex
CREATE UNIQUE INDEX "partner_referral_links_code_key" ON "partner_referral_links"("code");

-- CreateIndex
CREATE INDEX "partner_referral_links_partnerId_createdAt_idx" ON "partner_referral_links"("partnerId", "createdAt");

-- CreateIndex
CREATE INDEX "partner_deals_partnerId_status_idx" ON "partner_deals"("partnerId", "status");

-- CreateIndex
CREATE INDEX "partner_deals_domain_idx" ON "partner_deals"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "commission_entries_sourceKey_key" ON "commission_entries"("sourceKey");

-- CreateIndex
CREATE INDEX "commission_entries_partnerId_status_earnedAt_idx" ON "commission_entries"("partnerId", "status", "earnedAt");

-- CreateIndex
CREATE INDEX "commission_entries_statementId_idx" ON "commission_entries"("statementId");

-- CreateIndex
CREATE INDEX "commission_entries_tenantId_earnedAt_idx" ON "commission_entries"("tenantId", "earnedAt");

-- CreateIndex
CREATE INDEX "commission_entries_invoiceId_idx" ON "commission_entries"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "partner_statements_number_key" ON "partner_statements"("number");

-- CreateIndex
CREATE INDEX "partner_statements_partnerId_period_idx" ON "partner_statements"("partnerId", "period");

-- CreateIndex
CREATE INDEX "partner_statements_status_generatedAt_idx" ON "partner_statements"("status", "generatedAt");

-- CreateIndex
CREATE INDEX "partner_requests_status_createdAt_idx" ON "partner_requests"("status", "createdAt");

-- CreateIndex
CREATE INDEX "partner_requests_partnerId_createdAt_idx" ON "partner_requests"("partnerId", "createdAt");

-- CreateIndex
CREATE INDEX "partner_applications_status_createdAt_idx" ON "partner_applications"("status", "createdAt");

-- CreateIndex
CREATE INDEX "partner_audit_log_partnerId_at_idx" ON "partner_audit_log"("partnerId", "at");

-- CreateIndex
CREATE INDEX "partner_audit_log_at_idx" ON "partner_audit_log"("at");

-- CreateIndex
CREATE INDEX "partner_audit_log_action_at_idx" ON "partner_audit_log"("action", "at");

-- CreateIndex
CREATE INDEX "invoices_updatedAt_idx" ON "invoices"("updatedAt");

-- CreateIndex
CREATE INDEX "signup_invites_partnerId_createdAt_idx" ON "signup_invites"("partnerId", "createdAt");

-- CreateIndex
CREATE INDEX "tenants_partnerId_idx" ON "tenants"("partnerId");

-- AddForeignKey
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signup_invites" ADD CONSTRAINT "signup_invites_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partners" ADD CONSTRAINT "partners_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_terms" ADD CONSTRAINT "partner_terms_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_users" ADD CONSTRAINT "partner_users_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_sessions" ADD CONSTRAINT "partner_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "partner_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_attributions" ADD CONSTRAINT "tenant_attributions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_attributions" ADD CONSTRAINT "tenant_attributions_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_referral_links" ADD CONSTRAINT "partner_referral_links_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_deals" ADD CONSTRAINT "partner_deals_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_deals" ADD CONSTRAINT "partner_deals_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "commission_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "partner_statements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_invoice_states" ADD CONSTRAINT "commission_invoice_states_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_statements" ADD CONSTRAINT "partner_statements_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_requests" ADD CONSTRAINT "partner_requests_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_applications" ADD CONSTRAINT "partner_applications_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_audit_log" ADD CONSTRAINT "partner_audit_log_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Written by hand: limits the schema cannot say.
-- One current attribution per workspace, one open deal per domain, one live statement per partner, currency and month, one pending profile or payout request per partner.
CREATE UNIQUE INDEX "tenant_attributions_current_key" ON "tenant_attributions"("tenantId") WHERE "validTo" IS NULL;
CREATE UNIQUE INDEX "partner_deals_open_domain_key" ON "partner_deals"("domain") WHERE "status" IN ('PENDING', 'APPROVED');
CREATE UNIQUE INDEX "partner_statements_live_key" ON "partner_statements"("partnerId", "currency", "period") WHERE "status" <> 'VOID';
CREATE UNIQUE INDEX "partner_requests_one_pending_key" ON "partner_requests"("partnerId", "kind") WHERE "status" = 'PENDING' AND "kind" IN ('PROFILE', 'PAYOUT');
ALTER TABLE "partners" ADD CONSTRAINT "partners_slug_format" CHECK (char_length("slug") BETWEEN 3 AND 40 AND "slug" ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' AND "slug" NOT IN ('new', 'requests'));
ALTER TABLE "partners" ADD CONSTRAINT "partners_parent" CHECK ("parentId" IS NULL OR ("kind" = 'RESELLER' AND "parentId" <> "id"));
ALTER TABLE "partners" ADD CONSTRAINT "partners_country_format" CHECK ("country" ~ '^[A-Z]{2}$');
ALTER TABLE "partners" ADD CONSTRAINT "partners_territories" CHECK ("territories" IS NOT NULL AND cardinality("territories") BETWEEN 1 AND 250 AND array_to_string("territories", ',') ~ '^[A-Z]{2}(,[A-Z]{2})*$');
ALTER TABLE "partners" ADD CONSTRAINT "partners_lengths" CHECK (char_length("legalName") BETWEEN 2 AND 200 AND char_length("displayName") BETWEEN 2 AND 120 AND char_length("contactName") BETWEEN 2 AND 120 AND ("contactPhone" IS NULL OR char_length("contactPhone") <= 32) AND ("addressLine1" IS NULL OR char_length("addressLine1") <= 200) AND ("addressLine2" IS NULL OR char_length("addressLine2") <= 200) AND ("city" IS NULL OR char_length("city") <= 120) AND ("region" IS NULL OR char_length("region") <= 120) AND ("postalCode" IS NULL OR char_length("postalCode") <= 20) AND ("notes" IS NULL OR char_length("notes") <= 4000) AND ("publicBlurb" IS NULL OR char_length("publicBlurb") <= 300) AND ("statusReason" IS NULL OR char_length("statusReason") <= 500));
ALTER TABLE "partners" ADD CONSTRAINT "partners_contact_email_lower" CHECK ("contactEmail" = lower("contactEmail") AND char_length("contactEmail") BETWEEN 3 AND 254);
ALTER TABLE "partners" ADD CONSTRAINT "partners_website_format" CHECK ("website" IS NULL OR (char_length("website") <= 200 AND "website" ~ '^https?://'));
ALTER TABLE "partners" ADD CONSTRAINT "partners_payout_pair" CHECK (("payoutCipher" IS NULL) = ("payoutMask" IS NULL));
ALTER TABLE "partners" ADD CONSTRAINT "partners_status_stamps" CHECK (("status" <> 'SUSPENDED' OR "suspendedAt" IS NOT NULL) AND ("status" <> 'TERMINATED' OR "terminatedAt" IS NOT NULL));
ALTER TABLE "partners" ADD CONSTRAINT "partners_tax_ids" CHECK (jsonb_typeof("taxIds") = 'array' AND jsonb_array_length("taxIds") <= 4);
ALTER TABLE "partner_terms" ADD CONSTRAINT "partner_terms_rates" CHECK ("defaultRateBp" BETWEEN 0 AND 10000 AND ("newRateBp" IS NULL OR "newRateBp" BETWEEN 0 AND 10000) AND ("renewalRateBp" IS NULL OR "renewalRateBp" BETWEEN 0 AND 10000) AND ("overrideRateBp" IS NULL OR "overrideRateBp" BETWEEN 0 AND 10000) AND ("territoryRateBp" IS NULL OR "territoryRateBp" BETWEEN 0 AND 10000));
ALTER TABLE "partner_terms" ADD CONSTRAINT "partner_terms_months" CHECK ("newMonths" BETWEEN 1 AND 60 AND ("durationMonths" IS NULL OR "durationMonths" BETWEEN 1 AND 240));
ALTER TABLE "partner_terms" ADD CONSTRAINT "partner_terms_note_length" CHECK ("note" IS NULL OR char_length("note") <= 500);
ALTER TABLE "partner_terms" ADD CONSTRAINT "partner_terms_rate_lists" CHECK (jsonb_typeof("planRates") = 'array' AND jsonb_array_length("planRates") <= 50 AND jsonb_typeof("countryRates") = 'array' AND jsonb_array_length("countryRates") <= 50);
ALTER TABLE "partner_users" ADD CONSTRAINT "partner_users_email_lower" CHECK ("email" = lower("email") AND char_length("email") BETWEEN 3 AND 254);
ALTER TABLE "partner_users" ADD CONSTRAINT "partner_users_name_length" CHECK (char_length("name") BETWEEN 1 AND 120);
ALTER TABLE "tenant_attributions" ADD CONSTRAINT "tenant_attributions_window" CHECK ("validTo" IS NULL OR "validTo" >= "validFrom");
ALTER TABLE "tenant_attributions" ADD CONSTRAINT "tenant_attributions_partner_unless_staff" CHECK ("partnerId" IS NOT NULL OR "source" = 'STAFF');
ALTER TABLE "tenant_attributions" ADD CONSTRAINT "tenant_attributions_staff_reason" CHECK ("source" <> 'STAFF' OR ("reason" IS NOT NULL AND char_length("reason") BETWEEN 10 AND 500));
ALTER TABLE "tenant_attributions" ADD CONSTRAINT "tenant_attributions_reference_length" CHECK ("reference" IS NULL OR char_length("reference") <= 80);
ALTER TABLE "partner_referral_links" ADD CONSTRAINT "partner_referral_links_code_format" CHECK (char_length("code") BETWEEN 6 AND 40 AND "code" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
ALTER TABLE "partner_referral_links" ADD CONSTRAINT "partner_referral_links_label_length" CHECK ("label" IS NULL OR char_length("label") <= 80);
ALTER TABLE "partner_referral_links" ADD CONSTRAINT "partner_referral_links_signups_not_negative" CHECK ("signups" >= 0);
ALTER TABLE "partner_deals" ADD CONSTRAINT "partner_deals_domain_format" CHECK (char_length("domain") <= 253 AND "domain" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$');
ALTER TABLE "partner_deals" ADD CONSTRAINT "partner_deals_country_format" CHECK ("country" ~ '^[A-Z]{2}$');
ALTER TABLE "partner_deals" ADD CONSTRAINT "partner_deals_lengths" CHECK (char_length("companyName") BETWEEN 2 AND 160 AND ("contactName" IS NULL OR char_length("contactName") <= 120) AND ("note" IS NULL OR char_length("note") <= 1000) AND ("decisionNote" IS NULL OR char_length("decisionNote") <= 500));
ALTER TABLE "partner_deals" ADD CONSTRAINT "partner_deals_contact_email_lower" CHECK ("contactEmail" IS NULL OR ("contactEmail" = lower("contactEmail") AND char_length("contactEmail") <= 254));
ALTER TABLE "partner_deals" ADD CONSTRAINT "partner_deals_approved_expires" CHECK ("status" <> 'APPROVED' OR "expiresAt" IS NOT NULL);
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_rate" CHECK ("rateBp" BETWEEN 0 AND 10000);
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_base_not_negative" CHECK ("base" >= 0);
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_amount_nonzero" CHECK ("amount" <> 0);
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_invoice_unless_adjustment" CHECK (("kind" = 'ADJUSTMENT') = ("invoiceId" IS NULL));
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_tenant_unless_adjustment" CHECK ("kind" = 'ADJUSTMENT' OR "tenantId" IS NOT NULL);
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_adjustment_note" CHECK ("kind" <> 'ADJUSTMENT' OR ("note" IS NOT NULL AND char_length("note") BETWEEN 3 AND 500));
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_void_stamp" CHECK ("status" <> 'VOID' OR "voidedAt" IS NOT NULL);
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_statement_when_approved" CHECK ("status" NOT IN ('APPROVED', 'PAID') OR "statementId" IS NOT NULL);
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_source_key_length" CHECK (char_length("sourceKey") <= 200);
ALTER TABLE "commission_invoice_states" ADD CONSTRAINT "commission_invoice_states_outcome" CHECK ("outcome" IN ('accrued', 'no-partner', 'not-commissionable', 'no-terms', 'outside-duration', 'terminated', 'exempt', 'zero'));
ALTER TABLE "commission_invoice_states" ADD CONSTRAINT "commission_invoice_states_reversed_within_base" CHECK ("base" >= 0 AND "reversedBase" BETWEEN 0 AND "base");
ALTER TABLE "partner_statements" ADD CONSTRAINT "partner_statements_period_format" CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "partner_statements" ADD CONSTRAINT "partner_statements_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "partner_statements" ADD CONSTRAINT "partner_statements_total_positive" CHECK ("total" > 0 OR "status" = 'VOID');
ALTER TABLE "partner_statements" ADD CONSTRAINT "partner_statements_approved_stamp" CHECK ("status" NOT IN ('APPROVED', 'PAID') OR "approvedAt" IS NOT NULL);
ALTER TABLE "partner_statements" ADD CONSTRAINT "partner_statements_paid_stamp" CHECK ("status" <> 'PAID' OR ("paidAt" IS NOT NULL AND "paymentReference" IS NOT NULL));
ALTER TABLE "partner_statements" ADD CONSTRAINT "partner_statements_void_stamp" CHECK ("status" <> 'VOID' OR ("voidedAt" IS NOT NULL AND "voidReason" IS NOT NULL));
ALTER TABLE "partner_statements" ADD CONSTRAINT "partner_statements_lengths" CHECK (("paymentReference" IS NULL OR char_length("paymentReference") <= 120) AND ("paymentNote" IS NULL OR char_length("paymentNote") <= 500) AND ("partnerInvoiceNumber" IS NULL OR char_length("partnerInvoiceNumber") <= 60));
ALTER TABLE "partner_statements" ADD CONSTRAINT "partner_statements_tax_lines" CHECK (jsonb_typeof("taxLines") = 'array' AND jsonb_array_length("taxLines") <= 6);
ALTER TABLE "partner_requests" ADD CONSTRAINT "partner_requests_cipher_only_payout" CHECK ("kind" = 'PAYOUT' OR "payloadCipher" IS NULL);
ALTER TABLE "partner_requests" ADD CONSTRAINT "partner_requests_pending_payout_sealed" CHECK ("kind" <> 'PAYOUT' OR "status" <> 'PENDING' OR "payloadCipher" IS NOT NULL);
ALTER TABLE "partner_requests" ADD CONSTRAINT "partner_requests_decision_note_length" CHECK ("decisionNote" IS NULL OR char_length("decisionNote") <= 500);
ALTER TABLE "partner_applications" ADD CONSTRAINT "partner_applications_lengths" CHECK (char_length("companyName") BETWEEN 2 AND 160 AND ("website" IS NULL OR char_length("website") <= 200) AND char_length("contactName") BETWEEN 2 AND 120 AND char_length("contactEmail") BETWEEN 3 AND 254 AND ("contactPhone" IS NULL OR char_length("contactPhone") <= 32) AND char_length("message") BETWEEN 20 AND 4000 AND ("notes" IS NULL OR char_length("notes") <= 4000));
ALTER TABLE "partner_applications" ADD CONSTRAINT "partner_applications_country_format" CHECK ("country" ~ '^[A-Z]{2}$');
ALTER TABLE "partner_audit_log" ADD CONSTRAINT "partner_audit_log_lengths" CHECK (char_length("actorLabel") <= 200 AND char_length("action") <= 60 AND char_length("entity") <= 40);
ALTER TABLE "signup_invites" ADD CONSTRAINT "signup_invites_code_hint_length" CHECK ("codeHint" IS NULL OR char_length("codeHint") <= 8);
ALTER TABLE "pending_signups" ADD CONSTRAINT "pending_signups_referral_code_length" CHECK ("referralCode" IS NULL OR char_length("referralCode") <= 40);
ALTER TABLE "pending_signups" ADD CONSTRAINT "pending_signups_referral_via" CHECK ("referralVia" IS NULL OR "referralVia" IN ('link', 'cookie', 'typed'));
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_refunds_not_negative" CHECK ("amountRefunded" >= 0 AND "amountCredited" >= 0);

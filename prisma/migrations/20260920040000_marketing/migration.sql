-- CreateEnum
CREATE TYPE "MessageChannel" AS ENUM ('EMAIL', 'WHATSAPP', 'TASK', 'NOTIFICATION');

-- CreateEnum
CREATE TYPE "MessageClass" AS ENUM ('TRANSACTIONAL', 'MARKETING');

-- CreateEnum
CREATE TYPE "ProviderKind" AS ENUM ('EMAIL', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "MarketingTopic" AS ENUM ('RENEWALS', 'OFFERS', 'PRODUCT_NEWS', 'EVENTS', 'NEWSLETTER', 'SERVICE');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'SCHEDULED', 'SENDING', 'SENT', 'PAUSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "JourneyStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "EnrolmentStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'EXITED', 'SUPPRESSED');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'OPENED', 'CLICKED', 'BOUNCED', 'COMPLAINED', 'FAILED', 'SUPPRESSED');

-- CreateEnum
CREATE TYPE "MessageEventType" AS ENUM ('DELIVERED', 'OPEN', 'CLICK', 'BOUNCE', 'COMPLAINT', 'UNSUBSCRIBE', 'FAILED');

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('SUBSCRIBED', 'UNSUBSCRIBED', 'PENDING');

-- CreateEnum
CREATE TYPE "ConsentSource" AS ENUM ('IMPORT', 'FORM', 'VERBAL', 'CONTRACT', 'PREFERENCE_CENTRE', 'CAMPAIGN_LINK');

-- CreateEnum
CREATE TYPE "SuppressionScope" AS ENUM ('EMAIL', 'CONTACT', 'COMPANY', 'DOMAIN');

-- CreateEnum
CREATE TYPE "SuppressionReason" AS ENUM ('UNSUBSCRIBED', 'HARD_BOUNCE', 'COMPLAINT', 'MANUAL');

-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "preferenceToken" TEXT;

-- AlterTable
ALTER TABLE "organisation_settings" ADD COLUMN     "marketingApprovalThreshold" INTEGER NOT NULL DEFAULT 200,
ADD COLUMN     "marketingFromDomain" TEXT,
ADD COLUMN     "marketingMaxPerContactPerWeek" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "marketingPostalAddress" TEXT,
ADD COLUMN     "marketingQuietEndMinute" INTEGER NOT NULL DEFAULT 540,
ADD COLUMN     "marketingQuietStartMinute" INTEGER NOT NULL DEFAULT 1200,
ADD COLUMN     "marketingSkipNonWorkingDays" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "messaging_providers" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" "ProviderKind" NOT NULL DEFAULT 'EMAIL',
    "label" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "classes" "MessageClass"[] DEFAULT ARRAY[]::"MessageClass"[],
    "fromName" TEXT,
    "fromEmail" TEXT,
    "replyTo" TEXT,
    "config" JSONB,
    "secretCipher" TEXT,
    "dailyCap" INTEGER,
    "lastVerifiedAt" TIMESTAMP(3),
    "verifyOk" BOOLEAN,
    "verifyDetail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "messaging_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_audiences" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "companyFilters" JSONB NOT NULL,
    "contactFilters" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_audiences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" "MessageChannel" NOT NULL DEFAULT 'EMAIL',
    "topic" "MarketingTopic" NOT NULL DEFAULT 'OFFERS',
    "subject" TEXT,
    "preheader" TEXT,
    "body" TEXT NOT NULL,
    "whatsappTemplateName" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_campaigns" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "audienceId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "channel" "MessageChannel" NOT NULL DEFAULT 'EMAIL',
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduledFor" TIMESTAMP(3),
    "windowStartMinute" INTEGER,
    "windowEndMinute" INTEGER,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_journeys" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "triggerConfig" JSONB,
    "audienceId" TEXT,
    "status" "JourneyStatus" NOT NULL DEFAULT 'DRAFT',
    "exitOn" JSONB,
    "reEnrolAfterDays" INTEGER,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_journeys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_journey_steps" (
    "id" TEXT NOT NULL,
    "journeyId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "delayDays" INTEGER NOT NULL DEFAULT 0,
    "channel" "MessageChannel" NOT NULL DEFAULT 'EMAIL',
    "templateId" TEXT,
    "taskTitle" TEXT,
    "taskDetail" TEXT,
    "taskDueDays" INTEGER,
    "taskAssignee" TEXT,

    CONSTRAINT "marketing_journey_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_enrolments" (
    "id" TEXT NOT NULL,
    "journeyId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "contactId" TEXT,
    "triggerKey" TEXT NOT NULL,
    "status" "EnrolmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "currentStep" INTEGER NOT NULL DEFAULT 0,
    "nextRunAt" TIMESTAMP(3),
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exitedAt" TIMESTAMP(3),
    "exitReason" TEXT,

    CONSTRAINT "marketing_enrolments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_messages" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "campaignId" TEXT,
    "enrolmentId" TEXT,
    "stepId" TEXT,
    "companyId" TEXT NOT NULL,
    "contactId" TEXT,
    "channel" "MessageChannel" NOT NULL DEFAULT 'EMAIL',
    "messageClass" "MessageClass" NOT NULL DEFAULT 'MARKETING',
    "providerId" TEXT,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "toEmail" TEXT,
    "toPhone" TEXT,
    "status" "MessageStatus" NOT NULL DEFAULT 'QUEUED',
    "suppressedReason" TEXT,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "providerMessageId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_message_events" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "type" "MessageEventType" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "url" TEXT,
    "providerEventId" TEXT,
    "detail" TEXT,

    CONSTRAINT "marketing_message_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_consents" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "channel" "MessageChannel" NOT NULL DEFAULT 'EMAIL',
    "topic" "MarketingTopic" NOT NULL,
    "status" "ConsentStatus" NOT NULL DEFAULT 'SUBSCRIBED',
    "source" "ConsentSource" NOT NULL DEFAULT 'IMPORT',
    "evidence" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "capturedById" TEXT,
    "withdrawnAt" TIMESTAMP(3),

    CONSTRAINT "marketing_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_suppressions" (
    "id" TEXT NOT NULL,
    "scope" "SuppressionScope" NOT NULL,
    "value" TEXT NOT NULL,
    "reason" "SuppressionReason" NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "marketing_suppressions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_forms" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "headline" TEXT,
    "intro" TEXT,
    "fields" JSONB NOT NULL,
    "topic" "MarketingTopic" NOT NULL DEFAULT 'OFFERS',
    "createsLead" BOOLEAN NOT NULL DEFAULT true,
    "assignToUserId" TEXT,
    "thankYouText" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_forms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_form_submissions" (
    "id" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "companyName" TEXT,
    "companyId" TEXT,
    "contactId" TEXT,
    "leadId" TEXT,
    "sourceHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_form_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_ticks" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "enrolled" INTEGER NOT NULL DEFAULT 0,
    "claimed" INTEGER NOT NULL DEFAULT 0,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "suppressed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "marketing_ticks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "messaging_providers_key_key" ON "messaging_providers"("key");

-- CreateIndex
CREATE INDEX "messaging_providers_kind_enabled_idx" ON "messaging_providers"("kind", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_campaigns_reference_key" ON "marketing_campaigns"("reference");

-- CreateIndex
CREATE INDEX "marketing_campaigns_status_scheduledFor_idx" ON "marketing_campaigns"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "marketing_journeys_status_trigger_idx" ON "marketing_journeys"("status", "trigger");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_journey_steps_journeyId_order_key" ON "marketing_journey_steps"("journeyId", "order");

-- CreateIndex
CREATE INDEX "marketing_enrolments_status_nextRunAt_idx" ON "marketing_enrolments"("status", "nextRunAt");

-- CreateIndex
CREATE INDEX "marketing_enrolments_companyId_idx" ON "marketing_enrolments"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_enrolments_journeyId_triggerKey_key" ON "marketing_enrolments"("journeyId", "triggerKey");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_messages_token_key" ON "marketing_messages"("token");

-- CreateIndex
CREATE INDEX "marketing_messages_status_scheduledFor_idx" ON "marketing_messages"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "marketing_messages_companyId_idx" ON "marketing_messages"("companyId");

-- CreateIndex
CREATE INDEX "marketing_messages_contactId_sentAt_idx" ON "marketing_messages"("contactId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_messages_campaignId_contactId_key" ON "marketing_messages"("campaignId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_messages_enrolmentId_stepId_key" ON "marketing_messages"("enrolmentId", "stepId");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_message_events_providerEventId_key" ON "marketing_message_events"("providerEventId");

-- CreateIndex
CREATE INDEX "marketing_message_events_messageId_occurredAt_idx" ON "marketing_message_events"("messageId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_consents_contactId_channel_topic_key" ON "marketing_consents"("contactId", "channel", "topic");

-- CreateIndex
CREATE INDEX "marketing_suppressions_reason_idx" ON "marketing_suppressions"("reason");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_suppressions_scope_value_key" ON "marketing_suppressions"("scope", "value");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_forms_slug_key" ON "marketing_forms"("slug");

-- CreateIndex
CREATE INDEX "marketing_form_submissions_formId_createdAt_idx" ON "marketing_form_submissions"("formId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_ticks_runId_key" ON "marketing_ticks"("runId");

-- CreateIndex
CREATE INDEX "marketing_ticks_startedAt_idx" ON "marketing_ticks"("startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_preferenceToken_key" ON "contacts"("preferenceToken");

-- AddForeignKey
ALTER TABLE "marketing_audiences" ADD CONSTRAINT "marketing_audiences_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_templates" ADD CONSTRAINT "marketing_templates_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_audienceId_fkey" FOREIGN KEY ("audienceId") REFERENCES "marketing_audiences"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "marketing_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_journeys" ADD CONSTRAINT "marketing_journeys_audienceId_fkey" FOREIGN KEY ("audienceId") REFERENCES "marketing_audiences"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_journeys" ADD CONSTRAINT "marketing_journeys_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_journey_steps" ADD CONSTRAINT "marketing_journey_steps_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "marketing_journeys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_journey_steps" ADD CONSTRAINT "marketing_journey_steps_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "marketing_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_enrolments" ADD CONSTRAINT "marketing_enrolments_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "marketing_journeys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_enrolments" ADD CONSTRAINT "marketing_enrolments_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_enrolments" ADD CONSTRAINT "marketing_enrolments_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_messages" ADD CONSTRAINT "marketing_messages_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "marketing_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_messages" ADD CONSTRAINT "marketing_messages_enrolmentId_fkey" FOREIGN KEY ("enrolmentId") REFERENCES "marketing_enrolments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_messages" ADD CONSTRAINT "marketing_messages_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "marketing_journey_steps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_messages" ADD CONSTRAINT "marketing_messages_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_messages" ADD CONSTRAINT "marketing_messages_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_messages" ADD CONSTRAINT "marketing_messages_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "messaging_providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_message_events" ADD CONSTRAINT "marketing_message_events_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "marketing_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_consents" ADD CONSTRAINT "marketing_consents_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_consents" ADD CONSTRAINT "marketing_consents_capturedById_fkey" FOREIGN KEY ("capturedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_suppressions" ADD CONSTRAINT "marketing_suppressions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_forms" ADD CONSTRAINT "marketing_forms_assignToUserId_fkey" FOREIGN KEY ("assignToUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_forms" ADD CONSTRAINT "marketing_forms_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_form_submissions" ADD CONSTRAINT "marketing_form_submissions_formId_fkey" FOREIGN KEY ("formId") REFERENCES "marketing_forms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_form_submissions" ADD CONSTRAINT "marketing_form_submissions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_form_submissions" ADD CONSTRAINT "marketing_form_submissions_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_form_submissions" ADD CONSTRAINT "marketing_form_submissions_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;


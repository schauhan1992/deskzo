-- CreateEnum
CREATE TYPE "FeedbackRequestStatus" AS ENUM ('SENT', 'ANSWERED', 'CANCELLED');

-- AlterTable
ALTER TABLE "organisation_settings" ADD COLUMN     "feedbackIntro" TEXT,
ADD COLUMN     "feedbackLinkDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "feedbackReviewMinRating" INTEGER NOT NULL DEFAULT 4,
ADD COLUMN     "feedbackReviewUrl" TEXT;

-- CreateTable
CREATE TABLE "feedback_requests" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "contactId" TEXT,
    "sentToName" TEXT,
    "sentToEmail" TEXT,
    "sentToPhone" TEXT,
    "aboutUserId" TEXT,
    "ticketId" TEXT,
    "visitId" TEXT,
    "companyProductId" TEXT,
    "serviceLabel" TEXT,
    "message" TEXT,
    "status" "FeedbackRequestStatus" NOT NULL DEFAULT 'SENT',
    "sentAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "remindedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "requestedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feedback_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback_responses" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "personRating" INTEGER,
    "serviceRating" INTEGER,
    "comment" TEXT,
    "reviewInvited" BOOLEAN NOT NULL DEFAULT false,
    "reviewMinRatingAtTime" INTEGER,
    "reviewOpenedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" TEXT,
    "actionNote" TEXT,

    CONSTRAINT "feedback_responses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "feedback_requests_token_key" ON "feedback_requests"("token");

-- CreateIndex
CREATE UNIQUE INDEX "feedback_requests_reference_key" ON "feedback_requests"("reference");

-- CreateIndex
CREATE INDEX "feedback_requests_companyId_status_idx" ON "feedback_requests"("companyId", "status");

-- CreateIndex
CREATE INDEX "feedback_requests_aboutUserId_idx" ON "feedback_requests"("aboutUserId");

-- CreateIndex
CREATE INDEX "feedback_requests_status_sentAt_idx" ON "feedback_requests"("status", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "feedback_responses_requestId_key" ON "feedback_responses"("requestId");

-- CreateIndex
CREATE INDEX "feedback_responses_rating_idx" ON "feedback_responses"("rating");

-- CreateIndex
CREATE INDEX "feedback_responses_submittedAt_idx" ON "feedback_responses"("submittedAt");

-- AddForeignKey
ALTER TABLE "feedback_requests" ADD CONSTRAINT "feedback_requests_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_requests" ADD CONSTRAINT "feedback_requests_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_requests" ADD CONSTRAINT "feedback_requests_aboutUserId_fkey" FOREIGN KEY ("aboutUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_requests" ADD CONSTRAINT "feedback_requests_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_requests" ADD CONSTRAINT "feedback_requests_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "visits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_requests" ADD CONSTRAINT "feedback_requests_companyProductId_fkey" FOREIGN KEY ("companyProductId") REFERENCES "company_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_requests" ADD CONSTRAINT "feedback_requests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_responses" ADD CONSTRAINT "feedback_responses_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "feedback_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_responses" ADD CONSTRAINT "feedback_responses_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

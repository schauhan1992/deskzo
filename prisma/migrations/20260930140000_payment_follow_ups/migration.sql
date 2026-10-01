-- COLLECTIONS: a salesperson's (or accounts') follow-up on money a client owes, and any promise to pay.

-- CreateEnum
CREATE TYPE "FollowUpChannel" AS ENUM ('CALL', 'WHATSAPP', 'EMAIL', 'VISIT', 'MEETING', 'OTHER');

-- CreateEnum
CREATE TYPE "PromiseStatus" AS ENUM ('OPEN', 'KEPT', 'BROKEN', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "payment_follow_ups" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "documentId" TEXT,
    "companyProductId" TEXT,
    "byUserId" TEXT,
    "channel" "FollowUpChannel" NOT NULL,
    "remarks" TEXT NOT NULL,
    "promisedOn" DATE,
    "promisedAmount" DECIMAL(14,2),
    "nextFollowUpOn" DATE,
    "promiseStatus" "PromiseStatus",
    "promiseResolvedAt" TIMESTAMP(3),
    "brokenNotifiedAt" TIMESTAMP(3),
    "taskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payment_follow_ups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_follow_ups_companyId_createdAt_idx" ON "payment_follow_ups"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "payment_follow_ups_promiseStatus_promisedOn_idx" ON "payment_follow_ups"("promiseStatus", "promisedOn");

-- CreateIndex
CREATE INDEX "payment_follow_ups_byUserId_createdAt_idx" ON "payment_follow_ups"("byUserId", "createdAt");

-- CreateIndex
CREATE INDEX "payment_follow_ups_documentId_idx" ON "payment_follow_ups"("documentId");

-- CreateIndex
CREATE INDEX "payment_follow_ups_companyProductId_idx" ON "payment_follow_ups"("companyProductId");

-- AddForeignKey
ALTER TABLE "payment_follow_ups" ADD CONSTRAINT "payment_follow_ups_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_follow_ups" ADD CONSTRAINT "payment_follow_ups_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "trade_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_follow_ups" ADD CONSTRAINT "payment_follow_ups_companyProductId_fkey" FOREIGN KEY ("companyProductId") REFERENCES "company_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_follow_ups" ADD CONSTRAINT "payment_follow_ups_byUserId_fkey" FOREIGN KEY ("byUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Written by hand: a promise has a status exactly when it has a date; a promised amount is positive;
-- remarks are never blank or longer than 1,000 characters.
ALTER TABLE "payment_follow_ups"
  ADD CONSTRAINT "payment_follow_ups_promise_status_with_date" CHECK (("promisedOn" IS NULL) = ("promiseStatus" IS NULL)),
  ADD CONSTRAINT "payment_follow_ups_promised_amount_positive" CHECK ("promisedAmount" IS NULL OR "promisedAmount" > 0),
  ADD CONSTRAINT "payment_follow_ups_amount_needs_date" CHECK ("promisedAmount" IS NULL OR "promisedOn" IS NOT NULL),
  ADD CONSTRAINT "payment_follow_ups_remarks_present" CHECK (length(btrim("remarks")) > 0 AND length("remarks") <= 1000);

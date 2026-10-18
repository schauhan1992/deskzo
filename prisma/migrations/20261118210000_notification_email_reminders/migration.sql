-- Reminders the bell's sweep raises, emailed by the scheduled sweep (18 Oct 2026): when each kind was switched
-- on, so only what falls due afterwards is emailed, and each one claimed before it's sent, so it goes once.
ALTER TABLE "notification_email_types" ADD COLUMN "onSince" TIMESTAMP(3);

CREATE TABLE "notification_email_claims" (
    "userId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_email_claims_pkey" PRIMARY KEY ("userId","dedupeKey")
);

CREATE INDEX "notification_email_claims_createdAt_idx" ON "notification_email_claims"("createdAt");

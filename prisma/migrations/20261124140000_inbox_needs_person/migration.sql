-- The Customer inbox's response times (owner, 24 Oct 2026): when a conversation first needed a person, so the
-- clock starts at the bot's handover rather than the customer's first message. Conversations already there
-- that a person had (or that wait for one, the bot having let go) are taken to have needed one from the start.

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "needsPersonAt" TIMESTAMP(3);

-- Backfill
UPDATE "conversations"
   SET "needsPersonAt" = "createdAt"
 WHERE "botActive" = false
   AND ("firstResponseAt" IS NOT NULL OR "assignedToUserId" IS NOT NULL OR "status" = 'OPEN');

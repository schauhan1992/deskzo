-- A promised callback now raises a task, and the two stay in step.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CALLBACK_DUE';

ALTER TABLE "call_logs" ADD COLUMN "followUpTaskId" TEXT;

CREATE UNIQUE INDEX "call_logs_followUpTaskId_key" ON "call_logs"("followUpTaskId");

ALTER TABLE "call_logs"
  ADD CONSTRAINT "call_logs_followUpTaskId_fkey"
  FOREIGN KEY ("followUpTaskId") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

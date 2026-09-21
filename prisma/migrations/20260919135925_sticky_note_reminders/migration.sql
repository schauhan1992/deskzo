-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'NOTE_REMINDER';

-- AlterTable
ALTER TABLE "sticky_notes" ADD COLUMN     "remindAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "sticky_notes_remindAt_idx" ON "sticky_notes"("remindAt");

-- Task reminders (owner, 17 Oct 2026): somebody's own reminder on a task, once or every hour, day or week
-- until the task is closed, delivered as a TASK_REMINDER notification. Expand-only; the notifications
-- sweep (src/lib/notify.ts) treats a workspace without the table as having no reminders.

-- CreateEnum
CREATE TYPE "TaskReminderRepeat" AS ENUM ('ONCE', 'HOURLY', 'DAILY', 'WEEKLY');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'TASK_REMINDER';

-- CreateTable
CREATE TABLE "task_reminders" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "nextAt" TIMESTAMP(3) NOT NULL,
    "repeat" "TaskReminderRepeat" NOT NULL DEFAULT 'ONCE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "task_reminders_userId_nextAt_idx" ON "task_reminders"("userId", "nextAt");

-- CreateIndex
CREATE UNIQUE INDEX "task_reminders_taskId_userId_key" ON "task_reminders"("taskId", "userId");

-- AddForeignKey
ALTER TABLE "task_reminders" ADD CONSTRAINT "task_reminders_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_reminders" ADD CONSTRAINT "task_reminders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


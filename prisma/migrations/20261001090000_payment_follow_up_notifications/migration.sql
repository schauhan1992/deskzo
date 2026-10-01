-- Collections' own notification types: a broken promise to pay, the day's summary for accounts, and a
-- follow-up that is due. They replace TASK_OVERDUE and CALLBACK_DUE, which the collections job borrowed.
-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'PAYMENT_PROMISE_BROKEN';
ALTER TYPE "NotificationType" ADD VALUE 'PAYMENT_PROMISES_SUMMARY';
ALTER TYPE "NotificationType" ADD VALUE 'PAYMENT_FOLLOW_UP_DUE';

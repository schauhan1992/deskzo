-- "Need help" as a task's status (owner, 22 Oct 2026): the person working a task says they're stuck, and what they
-- need — the note is required, kept as a comment on the task, and its maker is told. Still an open task.
-- Additive: no task changes status. Postgres can't drop an enum value, so undoing it means leaving the value unused.

-- AlterEnum
ALTER TYPE "TaskStatus" ADD VALUE 'NEED_HELP' BEFORE 'DONE';

-- Calls logged by hand on an iPhone (owner, 22 Oct 2026): an iPhone can't read its call log, so its person says how a
-- call went on an after-call sheet and it is logged without a length — kept apart from a length of 0, which means
-- nobody answered. Additive: every call logged before keeps its length.

-- AlterTable
ALTER TABLE "call_logs" ADD COLUMN "lengthUnknown" BOOLEAN NOT NULL DEFAULT false;

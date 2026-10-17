-- Deskzo Automate, Phase 3: a test of a draft runs without a published version — the draft travels in
-- the run's own (encrypted) context instead.

-- AlterTable
ALTER TABLE "automation_runs" ALTER COLUMN "versionId" DROP NOT NULL;


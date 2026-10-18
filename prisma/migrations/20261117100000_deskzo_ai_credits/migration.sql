-- Deskzo AI on credits (owner, 17 Oct 2026; src/lib/ai). A workspace no longer brings its own AI key, and
-- the ones saved here are erased with their columns; the models and where they run are Deskzo's, set in the
-- console. What stays is the workspace's own: the copilot's switch, Automate drafting's, and a daily cap
-- for each person, now in credits. Drafting was on wherever the copilot was, and stays so.

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'AI_CREDITS';

-- AlterTable
ALTER TABLE "copilot_settings" ADD COLUMN "draftingEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "dailyCreditLimit" INTEGER;

UPDATE "copilot_settings" SET "draftingEnabled" = "enabled";

ALTER TABLE "copilot_settings" ADD CONSTRAINT "copilot_settings_daily_credit_limit_check" CHECK ("dailyCreditLimit" IS NULL OR "dailyCreditLimit" > 0);

-- The workspace's own keys, its provider and model, and the daily allowance in tokens.
ALTER TABLE "copilot_settings" DROP COLUMN "anthropicKeyCipher",
DROP COLUMN "openaiKeyCipher",
DROP COLUMN "geminiKeyCipher",
DROP COLUMN "provider",
DROP COLUMN "model",
DROP COLUMN "dailyTokenLimit";

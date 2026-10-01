-- Onboarding: the Getting started wizard remembers who has finished, and which optional steps were skipped.

-- AlterTable
ALTER TABLE "organisation_settings" ADD COLUMN     "onboardingSkipped" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "onboardingCompletedAt" TIMESTAMP(3),
ADD COLUMN     "onboardingSkipped" TEXT[] DEFAULT ARRAY[]::TEXT[];


-- Written by hand: everybody already in a workspace when onboarding arrived has finished it — they
-- were set up the old way, and the wizard is for people who come after.
UPDATE "users" SET "onboardingCompletedAt" = CURRENT_TIMESTAMP WHERE "onboardingCompletedAt" IS NULL;

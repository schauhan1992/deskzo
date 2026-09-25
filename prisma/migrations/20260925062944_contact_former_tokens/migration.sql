-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "formerPreferenceTokens" TEXT[] DEFAULT ARRAY[]::TEXT[];

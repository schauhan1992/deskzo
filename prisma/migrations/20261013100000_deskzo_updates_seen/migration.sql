-- What's new from Deskzo is read apart from the company's own news, so each person has a second
-- "seen up to" line for it, null to begin with as updatesSeenAt was.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "deskzoUpdatesSeenAt" TIMESTAMP(3);

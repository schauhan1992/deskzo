-- Data already backfilled into "industries"/"industryId" by a one-off script before this migration.
ALTER TABLE "companies" DROP COLUMN "industry";

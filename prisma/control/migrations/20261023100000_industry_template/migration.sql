-- Industry templates (owner, 2 Oct 2026): the one chosen at signup travels with the signup and its
-- provisioning job, and is applied as the new workspace is set up (src/lib/industry-templates). A key from
-- the code's catalogue; the code checks it, the database only that it is short.
ALTER TABLE "pending_signups" ADD COLUMN "industryTemplate" TEXT;
ALTER TABLE "pending_signups" ADD CONSTRAINT "pending_signups_industryTemplate_check" CHECK ("industryTemplate" IS NULL OR length("industryTemplate") <= 40);
ALTER TABLE "provisioning_jobs" ADD COLUMN "industryTemplate" TEXT;
ALTER TABLE "provisioning_jobs" ADD CONSTRAINT "provisioning_jobs_industryTemplate_check" CHECK ("industryTemplate" IS NULL OR length("industryTemplate") <= 40);

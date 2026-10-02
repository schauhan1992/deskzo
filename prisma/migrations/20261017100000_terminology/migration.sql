-- The workspace's own words (Settings → Wording, src/lib/terms). Only what it changes is stored; an empty
-- table means every word is the app's, which is what every workspace starts with.

-- CreateTable
CREATE TABLE "terminology_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "overrides" JSONB NOT NULL DEFAULT '{}',
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "terminology_settings_pkey" PRIMARY KEY ("id")
);


-- One row, the workspace's; and what is stored is an object.
ALTER TABLE "terminology_settings" ADD CONSTRAINT "terminology_settings_one_row" CHECK ("id" = 'global');
ALTER TABLE "terminology_settings" ADD CONSTRAINT "terminology_settings_overrides_object" CHECK (jsonb_typeof("overrides") = 'object');

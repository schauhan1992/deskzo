-- Team pipelines (src/lib/pipeline): several pipelines per workspace, each with its own stages, a rule
-- per stage, connected pipelines and simple automations — and booking pages (src/lib/booking).
--
-- Every stage made before this belongs to the main pipeline, `lpip_sales`, made here; a lead keeps no
-- pipeline (null), which means the main one. Nothing else about an existing lead changes.

-- CreateEnum
CREATE TYPE "PipelineTrigger" AS ENUM ('LEAD_CREATED', 'STAGE_ENTERED');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('CONFIRMED', 'CANCELLED');

-- The pipelines, and the main one every workspace has.
CREATE TABLE "lead_pipelines" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sales" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "nextPipelineId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_pipelines_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "lead_pipelines_key_key" ON "lead_pipelines"("key");
CREATE INDEX "lead_pipelines_archivedAt_sortOrder_idx" ON "lead_pipelines"("archivedAt", "sortOrder");
ALTER TABLE "lead_pipelines" ADD CONSTRAINT "lead_pipelines_nextPipelineId_fkey" FOREIGN KEY ("nextPipelineId") REFERENCES "lead_pipelines"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "lead_pipelines" ADD CONSTRAINT "lead_pipelines_key_format" CHECK ("key" ~ '^[a-z][a-z0-9_]{0,39}$');
ALTER TABLE "lead_pipelines" ADD CONSTRAINT "lead_pipelines_name_length" CHECK (char_length(btrim("name")) BETWEEN 1 AND 40);
ALTER TABLE "lead_pipelines" ADD CONSTRAINT "lead_pipelines_next_not_self" CHECK ("nextPipelineId" IS NULL OR "nextPipelineId" <> "id");
-- The main pipeline is always sales, never retired.
ALTER TABLE "lead_pipelines" ADD CONSTRAINT "lead_pipelines_main_kept" CHECK ("id" <> 'lpip_sales' OR ("sales" AND "archivedAt" IS NULL));

INSERT INTO "lead_pipelines" ("id", "key", "name", "sales", "sortOrder", "updatedAt")
VALUES ('lpip_sales', 'sales', 'Sales', true, 0, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- Every stage belongs to a pipeline; those that exist, to the main one. Keys are unique within one.
ALTER TABLE "lead_stages" ADD COLUMN "pipelineId" TEXT NOT NULL DEFAULT 'lpip_sales',
ADD COLUMN "requiredFields" TEXT[] DEFAULT ARRAY[]::TEXT[];
DROP INDEX "lead_stages_key_key";
CREATE UNIQUE INDEX "lead_stages_pipelineId_key_key" ON "lead_stages"("pipelineId", "key");
ALTER TABLE "lead_stages" ADD CONSTRAINT "lead_stages_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "lead_pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "lead_stages" ADD CONSTRAINT "lead_stages_required_fields" CHECK (cardinality("requiredFields") <= 12);

-- A lead's pipeline (null: the main one) and the lead it carried on from.
ALTER TABLE "leads" ADD COLUMN "fromLeadId" TEXT,
ADD COLUMN "pipelineId" TEXT;
CREATE INDEX "leads_pipelineId_status_idx" ON "leads"("pipelineId", "status");
CREATE INDEX "leads_fromLeadId_idx" ON "leads"("fromLeadId");
ALTER TABLE "leads" ADD CONSTRAINT "leads_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "lead_pipelines"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "leads" ADD CONSTRAINT "leads_fromLeadId_fkey" FOREIGN KEY ("fromLeadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "leads" ADD CONSTRAINT "leads_not_from_itself" CHECK ("fromLeadId" IS NULL OR "fromLeadId" <> "id");

-- Automations.
CREATE TABLE "pipeline_automations" (
    "id" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trigger" "PipelineTrigger" NOT NULL,
    "stageId" TEXT,
    "actions" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "runs" INTEGER NOT NULL DEFAULT 0,
    "lastRunAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pipeline_automations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "pipeline_automations_pipelineId_trigger_active_idx" ON "pipeline_automations"("pipelineId", "trigger", "active");
ALTER TABLE "pipeline_automations" ADD CONSTRAINT "pipeline_automations_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "lead_pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pipeline_automations" ADD CONSTRAINT "pipeline_automations_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "lead_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pipeline_automations" ADD CONSTRAINT "pipeline_automations_name_length" CHECK (char_length(btrim("name")) BETWEEN 1 AND 80);
ALTER TABLE "pipeline_automations" ADD CONSTRAINT "pipeline_automations_stage_for_trigger" CHECK (("trigger" = 'STAGE_ENTERED') = ("stageId" IS NOT NULL));
ALTER TABLE "pipeline_automations" ADD CONSTRAINT "pipeline_automations_actions" CHECK (jsonb_typeof("actions") = 'array' AND jsonb_array_length("actions") BETWEEN 1 AND 10);
ALTER TABLE "pipeline_automations" ADD CONSTRAINT "pipeline_automations_error_length" CHECK ("lastError" IS NULL OR char_length("lastError") <= 1000);

-- Booking pages and their bookings.
CREATE TABLE "booking_pages" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "durationMinutes" INTEGER NOT NULL DEFAULT 30,
    "hostUserIds" TEXT[],
    "hours" JSONB NOT NULL,
    "daysAhead" INTEGER NOT NULL DEFAULT 14,
    "minNoticeHours" INTEGER NOT NULL DEFAULT 4,
    "bufferMinutes" INTEGER NOT NULL DEFAULT 0,
    "online" BOOLEAN NOT NULL DEFAULT true,
    "pipelineId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "booking_pages_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "booking_pages_slug_key" ON "booking_pages"("slug");
ALTER TABLE "booking_pages" ADD CONSTRAINT "booking_pages_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "lead_pipelines"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "booking_pages" ADD CONSTRAINT "booking_pages_slug_format" CHECK ("slug" ~ '^[a-z0-9][a-z0-9-]{2,40}$');
ALTER TABLE "booking_pages" ADD CONSTRAINT "booking_pages_lengths" CHECK (char_length(btrim("title")) BETWEEN 1 AND 80 AND ("description" IS NULL OR char_length("description") <= 1000));
ALTER TABLE "booking_pages" ADD CONSTRAINT "booking_pages_ranges" CHECK ("durationMinutes" BETWEEN 10 AND 240 AND "daysAhead" BETWEEN 1 AND 90 AND "minNoticeHours" BETWEEN 0 AND 336 AND "bufferMinutes" BETWEEN 0 AND 120);
ALTER TABLE "booking_pages" ADD CONSTRAINT "booking_pages_hosts" CHECK (cardinality("hostUserIds") BETWEEN 1 AND 10);
ALTER TABLE "booking_pages" ADD CONSTRAINT "booking_pages_hours" CHECK (jsonb_typeof("hours") = 'object');

CREATE TABLE "bookings" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "hostUserId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "companyName" TEXT,
    "notes" TEXT,
    "companyId" TEXT,
    "contactId" TEXT,
    "leadId" TEXT,
    "calendarEventId" TEXT,
    "status" "BookingStatus" NOT NULL DEFAULT 'CONFIRMED',
    "sourceHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "bookings_hostUserId_startsAt_idx" ON "bookings"("hostUserId", "startsAt");
CREATE INDEX "bookings_pageId_createdAt_idx" ON "bookings"("pageId", "createdAt");
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "booking_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_hostUserId_fkey" FOREIGN KEY ("hostUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_times" CHECK ("endsAt" > "startsAt");
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_lengths" CHECK (char_length(btrim("name")) BETWEEN 1 AND 120 AND char_length("email") BETWEEN 3 AND 254 AND ("phone" IS NULL OR char_length("phone") <= 40) AND ("companyName" IS NULL OR char_length("companyName") <= 200) AND ("notes" IS NULL OR char_length("notes") <= 1000));

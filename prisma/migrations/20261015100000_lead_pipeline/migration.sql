-- The workspace's own lead pipeline (Settings → Pipeline, src/lib/pipeline).
--
-- Every workspace starts with the stages it always had, under ids `lstg_<key>` that the code also knows
-- (`defaultStages`), and every lead is placed in the one its status names — so nothing looks different
-- until somebody edits the pipeline. `stageChangedAt` is backfilled from the stage-change history,
-- because `updatedAt` moves on every view (the score is rewritten) and so never said when a lead moved.

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "stageChangedAt" TIMESTAMP(3),
ADD COLUMN     "stageId" TEXT;

-- CreateTable
CREATE TABLE "lead_stages" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" "LeadStatus" NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'default',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_stages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lead_stages_key_key" ON "lead_stages"("key");

-- CreateIndex
CREATE INDEX "lead_stages_archivedAt_sortOrder_idx" ON "lead_stages"("archivedAt", "sortOrder");

-- CreateIndex
CREATE INDEX "leads_stageId_idx" ON "leads"("stageId");

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "lead_stages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- What a stage may be: a key like a custom field's, a name that fits a board column, a known colour.
ALTER TABLE "lead_stages" ADD CONSTRAINT "lead_stages_key_shape" CHECK ("key" ~ '^[a-z][a-z0-9_]{0,39}$');
ALTER TABLE "lead_stages" ADD CONSTRAINT "lead_stages_label_length" CHECK (char_length(btrim("label")) BETWEEN 1 AND 40);
ALTER TABLE "lead_stages" ADD CONSTRAINT "lead_stages_color_known" CHECK ("color" IN ('default', 'blue', 'amber', 'brand', 'green', 'red'));

-- The stages every workspace starts with.
INSERT INTO "lead_stages" ("id", "key", "label", "status", "color", "sortOrder", "updatedAt") VALUES
    ('lstg_new', 'new', 'New', 'NEW', 'default', 1, CURRENT_TIMESTAMP),
    ('lstg_contacted', 'contacted', 'Contacted', 'CONTACTED', 'blue', 2, CURRENT_TIMESTAMP),
    ('lstg_qualifying', 'qualifying', 'Qualifying', 'QUALIFYING', 'blue', 3, CURRENT_TIMESTAMP),
    ('lstg_qualified', 'qualified', 'Qualified', 'QUALIFIED', 'amber', 4, CURRENT_TIMESTAMP),
    ('lstg_proposal_sent', 'proposal_sent', 'Proposal sent', 'PROPOSAL_SENT', 'amber', 5, CURRENT_TIMESTAMP),
    ('lstg_negotiation', 'negotiation', 'Negotiation', 'NEGOTIATION', 'amber', 6, CURRENT_TIMESTAMP),
    ('lstg_won', 'won', 'Won', 'WON', 'green', 7, CURRENT_TIMESTAMP),
    ('lstg_lost', 'lost', 'Lost', 'LOST', 'red', 8, CURRENT_TIMESTAMP),
    ('lstg_disqualified', 'disqualified', 'Disqualified', 'DISQUALIFIED', 'red', 9, CURRENT_TIMESTAMP);

-- Every lead in the stage its status names, moved there when its history last says it moved.
UPDATE "leads" SET "stageId" = 'lstg_' || lower("status"::text);
UPDATE "leads" AS l SET "stageChangedAt" = COALESCE(
    (SELECT max(a."occurredAt") FROM "activities" AS a WHERE a."leadId" = l."id" AND a."type" = 'STAGE_CHANGE'),
    l."createdAt"
);

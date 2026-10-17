-- Deskzo Automate, Phase 5: a company's own workflow templates, kept apart from Deskzo's.

-- CreateTable
CREATE TABLE "automation_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "definition" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "automation_templates_createdAt_idx" ON "automation_templates"("createdAt");

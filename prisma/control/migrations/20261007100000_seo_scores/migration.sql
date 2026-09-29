-- CreateEnum
CREATE TYPE "SeoEntityType" AS ENUM ('PAGE', 'POST', 'CATEGORY', 'TAG', 'BLOG_INDEX');

-- CreateTable
CREATE TABLE "seo_scores" (
    "id" TEXT NOT NULL,
    "entityType" "SeoEntityType" NOT NULL,
    "entityKey" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "indexable" BOOLEAN NOT NULL,
    "seoScore" INTEGER NOT NULL,
    "aeoScore" INTEGER NOT NULL,
    "geoScore" INTEGER NOT NULL,
    "overallScore" INTEGER NOT NULL,
    "critical" INTEGER NOT NULL,
    "warnings" INTEGER NOT NULL,
    "missingMetadata" BOOLEAN NOT NULL,
    "missingSchema" BOOLEAN NOT NULL,
    "missingKeywords" BOOLEAN NOT NULL,
    "breakdown" JSONB NOT NULL,
    "engineVersion" INTEGER NOT NULL,
    "contentUpdatedAt" TIMESTAMP(3),
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seo_scores_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "seo_scores_overallScore_idx" ON "seo_scores"("overallScore");

-- CreateIndex
CREATE INDEX "seo_scores_calculatedAt_idx" ON "seo_scores"("calculatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "seo_scores_entityType_entityKey_key" ON "seo_scores"("entityType", "entityKey");


-- Written by hand: scores are 0–100 and counts are never negative (the engine clamps; the database agrees).
ALTER TABLE "seo_scores"
  ADD CONSTRAINT "seo_scores_scores_in_range" CHECK (
    "seoScore" BETWEEN 0 AND 100 AND "aeoScore" BETWEEN 0 AND 100 AND
    "geoScore" BETWEEN 0 AND 100 AND "overallScore" BETWEEN 0 AND 100
  ),
  ADD CONSTRAINT "seo_scores_counts_not_negative" CHECK ("critical" >= 0 AND "warnings" >= 0),
  ADD CONSTRAINT "seo_scores_engine_version_positive" CHECK ("engineVersion" >= 1),
  ADD CONSTRAINT "seo_scores_status_known" CHECK ("status" IN ('published', 'draft', 'default', 'scheduled'));

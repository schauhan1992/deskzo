-- Reporting & Analytics (owner, 23 Oct 2026): reports built in the Report Builder, who they are shared with,
-- who starred them and when each person last opened one. Additive: four new tables and two notification types.
-- A report stores its definition only — never a figure — and is run again as whoever opens it.
-- Postgres can't drop an enum value, so undoing it means dropping the tables and leaving the two values unused.

ALTER TYPE "NotificationType" ADD VALUE 'REPORT_SHARED';
ALTER TYPE "NotificationType" ADD VALUE 'REPORT_ACCESS_REQUESTED';

-- CreateTable
CREATE TABLE "saved_reports" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sourceKey" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "templateKey" TEXT,
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_report_shares" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "userId" TEXT,
    "departmentId" TEXT,
    "canEdit" BOOLEAN NOT NULL DEFAULT false,
    "sharedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_report_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_report_favourites" (
    "userId" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_report_favourites_pkey" PRIMARY KEY ("userId","reportId")
);

-- CreateTable
CREATE TABLE "saved_report_views" (
    "userId" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_report_views_pkey" PRIMARY KEY ("userId","reportId")
);

-- CreateIndex
CREATE INDEX "saved_reports_ownerId_updatedAt_idx" ON "saved_reports"("ownerId", "updatedAt");

-- CreateIndex
CREATE INDEX "saved_report_shares_userId_idx" ON "saved_report_shares"("userId");

-- CreateIndex
CREATE INDEX "saved_report_shares_departmentId_idx" ON "saved_report_shares"("departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "saved_report_shares_reportId_userId_key" ON "saved_report_shares"("reportId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "saved_report_shares_reportId_departmentId_key" ON "saved_report_shares"("reportId", "departmentId");

-- CreateIndex
CREATE INDEX "saved_report_views_userId_viewedAt_idx" ON "saved_report_views"("userId", "viewedAt");

-- AddForeignKey
ALTER TABLE "saved_reports" ADD CONSTRAINT "saved_reports_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_report_shares" ADD CONSTRAINT "saved_report_shares_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "saved_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_report_shares" ADD CONSTRAINT "saved_report_shares_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_report_shares" ADD CONSTRAINT "saved_report_shares_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_report_shares" ADD CONSTRAINT "saved_report_shares_sharedById_fkey" FOREIGN KEY ("sharedById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_report_favourites" ADD CONSTRAINT "saved_report_favourites_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_report_favourites" ADD CONSTRAINT "saved_report_favourites_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "saved_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_report_views" ADD CONSTRAINT "saved_report_views_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_report_views" ADD CONSTRAINT "saved_report_views_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "saved_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A share names a person or a department — exactly one.
ALTER TABLE "saved_report_shares" ADD CONSTRAINT "saved_report_shares_one_target" CHECK (("userId" IS NULL) <> ("departmentId" IS NULL));

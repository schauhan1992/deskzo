-- CreateTable
CREATE TABLE "forecast_stage_weights" (
    "stage" "LeadStatus" NOT NULL,
    "percent" INTEGER NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "forecast_stage_weights_pkey" PRIMARY KEY ("stage")
);

-- CreateTable
CREATE TABLE "forecast_commits" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "commit" DECIMAL(14,2) NOT NULL,
    "bestCase" DECIMAL(14,2),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "forecast_commits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "forecast_commits_month_idx" ON "forecast_commits"("month");

-- CreateIndex
CREATE UNIQUE INDEX "forecast_commits_userId_month_key" ON "forecast_commits"("userId", "month");

-- AddForeignKey
ALTER TABLE "forecast_stage_weights" ADD CONSTRAINT "forecast_stage_weights_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forecast_commits" ADD CONSTRAINT "forecast_commits_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

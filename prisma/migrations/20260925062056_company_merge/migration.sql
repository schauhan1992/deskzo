-- CreateTable
CREATE TABLE "company_merges" (
    "id" TEXT NOT NULL,
    "fromCompanyId" TEXT NOT NULL,
    "fromSeq" INTEGER NOT NULL,
    "fromName" TEXT NOT NULL,
    "intoCompanyId" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "moved" JSONB NOT NULL,
    "choices" JSONB NOT NULL,
    "mergedById" TEXT,
    "mergedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_merges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_duplicate_dismissals" (
    "id" TEXT NOT NULL,
    "companyAId" TEXT NOT NULL,
    "companyBId" TEXT NOT NULL,
    "dismissedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_duplicate_dismissals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "company_merges_fromCompanyId_key" ON "company_merges"("fromCompanyId");

-- CreateIndex
CREATE UNIQUE INDEX "company_merges_fromSeq_key" ON "company_merges"("fromSeq");

-- CreateIndex
CREATE INDEX "company_merges_intoCompanyId_idx" ON "company_merges"("intoCompanyId");

-- CreateIndex
CREATE UNIQUE INDEX "company_duplicate_dismissals_companyAId_companyBId_key" ON "company_duplicate_dismissals"("companyAId", "companyBId");

-- AddForeignKey
ALTER TABLE "company_merges" ADD CONSTRAINT "company_merges_intoCompanyId_fkey" FOREIGN KEY ("intoCompanyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_merges" ADD CONSTRAINT "company_merges_mergedById_fkey" FOREIGN KEY ("mergedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

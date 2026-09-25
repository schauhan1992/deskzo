-- CreateEnum
CREATE TYPE "SourcingStatus" AS ENUM ('NEW', 'PROFILING', 'SUBMITTED', 'RETURNED', 'MOVED', 'REJECTED');

-- AlterEnum
ALTER TYPE "CompanySource" ADD VALUE 'GOVT_REGISTRY';

-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "cin" TEXT;

-- CreateTable
CREATE TABLE "sourcing_batches" (
    "id" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "offset" INTEGER NOT NULL,
    "requested" INTEGER NOT NULL,
    "fetched" INTEGER NOT NULL DEFAULT 0,
    "added" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "fetchedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sourcing_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sourced_companies" (
    "id" TEXT NOT NULL,
    "sourcedSeq" SERIAL NOT NULL,
    "batchId" TEXT,
    "cin" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "companyStatus" TEXT,
    "companyClass" TEXT,
    "category" TEXT,
    "subCategory" TEXT,
    "registeredOn" DATE,
    "registeredState" TEXT,
    "roc" TEXT,
    "authorisedCapital" DECIMAL(18,2),
    "paidUpCapital" DECIMAL(18,2),
    "activity" TEXT,
    "registeredAddress" TEXT,
    "registryEmail" TEXT,
    "raw" JSONB NOT NULL,
    "status" "SourcingStatus" NOT NULL DEFAULT 'NEW',
    "assignedToUserId" TEXT,
    "assignedAt" TIMESTAMP(3),
    "website" TEXT,
    "industryId" TEXT,
    "employeeCount" INTEGER,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "pincode" TEXT,
    "gstNumber" TEXT,
    "notes" TEXT,
    "contactName" TEXT,
    "contactDesignation" "ContactDesignation",
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "emailStatus" "EmailCheckStatus" NOT NULL DEFAULT 'UNCHECKED',
    "emailCheckMethod" "EmailCheckMethod",
    "emailCheckedValue" TEXT,
    "emailCheckedAt" TIMESTAMP(3),
    "emailCheckDetail" TEXT,
    "phoneConfirmedValue" TEXT,
    "phoneConfirmedAt" TIMESTAMP(3),
    "phoneConfirmedById" TEXT,
    "phoneNote" TEXT,
    "submittedAt" TIMESTAMP(3),
    "submittedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "reviewNote" TEXT,
    "companyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sourced_companies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sourced_companies_sourcedSeq_key" ON "sourced_companies"("sourcedSeq");

-- CreateIndex
CREATE UNIQUE INDEX "sourced_companies_cin_key" ON "sourced_companies"("cin");

-- CreateIndex
CREATE UNIQUE INDEX "sourced_companies_companyId_key" ON "sourced_companies"("companyId");

-- CreateIndex
CREATE INDEX "sourced_companies_status_assignedToUserId_idx" ON "sourced_companies"("status", "assignedToUserId");

-- CreateIndex
CREATE INDEX "sourced_companies_registeredState_idx" ON "sourced_companies"("registeredState");

-- CreateIndex
CREATE UNIQUE INDEX "companies_cin_key" ON "companies"("cin");

-- AddForeignKey
ALTER TABLE "sourcing_batches" ADD CONSTRAINT "sourcing_batches_fetchedById_fkey" FOREIGN KEY ("fetchedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sourced_companies" ADD CONSTRAINT "sourced_companies_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "sourcing_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sourced_companies" ADD CONSTRAINT "sourced_companies_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sourced_companies" ADD CONSTRAINT "sourced_companies_industryId_fkey" FOREIGN KEY ("industryId") REFERENCES "industries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sourced_companies" ADD CONSTRAINT "sourced_companies_phoneConfirmedById_fkey" FOREIGN KEY ("phoneConfirmedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sourced_companies" ADD CONSTRAINT "sourced_companies_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sourced_companies" ADD CONSTRAINT "sourced_companies_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sourced_companies" ADD CONSTRAINT "sourced_companies_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

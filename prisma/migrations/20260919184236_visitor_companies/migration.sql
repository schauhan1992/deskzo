-- CreateEnum
CREATE TYPE "VisitorCompanySource" AS ENUM ('VISITOR', 'VENDOR', 'MANUAL');

-- AlterTable
ALTER TABLE "visitor_entries" ADD COLUMN     "visitorCompanyId" TEXT;

-- CreateTable
CREATE TABLE "visitor_companies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "source" "VisitorCompanySource" NOT NULL DEFAULT 'VISITOR',
    "companyId" TEXT,
    "visitCount" INTEGER NOT NULL DEFAULT 0,
    "lastSeenAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "visitor_companies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "visitor_companies_normalizedName_key" ON "visitor_companies"("normalizedName");

-- CreateIndex
CREATE INDEX "visitor_companies_visitCount_idx" ON "visitor_companies"("visitCount");

-- AddForeignKey
ALTER TABLE "visitor_entries" ADD CONSTRAINT "visitor_entries_visitorCompanyId_fkey" FOREIGN KEY ("visitorCompanyId") REFERENCES "visitor_companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visitor_companies" ADD CONSTRAINT "visitor_companies_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

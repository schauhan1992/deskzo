-- CreateEnum
CREATE TYPE "CompanyType" AS ENUM ('PRIVATE_LIMITED', 'PUBLIC_LIMITED', 'PROPRIETORSHIP', 'PARTNERSHIP', 'LLP', 'NGO', 'GOVERNMENT', 'OTHER');

-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "assignedAt" TIMESTAMP(3),
ADD COLUMN     "assignedByUserId" TEXT,
ADD COLUMN     "assignedToUserId" TEXT,
ADD COLUMN     "category" TEXT,
ADD COLUMN     "companyType" "CompanyType",
ADD COLUMN     "country" TEXT,
ADD COLUMN     "dunsNumber" TEXT,
ADD COLUMN     "employeeCount" INTEGER,
ADD COLUMN     "gstNumber" TEXT,
ADD COLUMN     "linkedinUrl" TEXT,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX "companies_assignedToUserId_idx" ON "companies"("assignedToUserId");

-- AddForeignKey
ALTER TABLE "companies" ADD CONSTRAINT "companies_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "companies" ADD CONSTRAINT "companies_assignedByUserId_fkey" FOREIGN KEY ("assignedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

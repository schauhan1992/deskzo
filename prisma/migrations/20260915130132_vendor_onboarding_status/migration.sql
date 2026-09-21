-- CreateEnum
CREATE TYPE "VendorStatus" AS ENUM ('ONBOARDING', 'ACTIVE', 'INACTIVE');

-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "vendorCode" TEXT,
ADD COLUMN     "vendorStatus" "VendorStatus";

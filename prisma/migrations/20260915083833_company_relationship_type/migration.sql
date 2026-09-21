-- CreateEnum
CREATE TYPE "CompanyRelationshipType" AS ENUM ('CLIENT', 'VENDOR', 'OEM', 'DISTRIBUTOR', 'PARTNER', 'OTHER');

-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "relationshipType" "CompanyRelationshipType" NOT NULL DEFAULT 'CLIENT';

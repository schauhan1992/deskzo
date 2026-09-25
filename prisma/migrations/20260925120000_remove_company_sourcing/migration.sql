-- AlterEnum
BEGIN;
CREATE TYPE "CompanySource_new" AS ENUM ('LINKEDIN', 'REFERRAL', 'INBOUND', 'OTHER');
ALTER TABLE "public"."companies" ALTER COLUMN "source" DROP DEFAULT;
ALTER TABLE "companies" ALTER COLUMN "source" TYPE "CompanySource_new" USING ("source"::text::"CompanySource_new");
ALTER TYPE "CompanySource" RENAME TO "CompanySource_old";
ALTER TYPE "CompanySource_new" RENAME TO "CompanySource";
DROP TYPE "public"."CompanySource_old";
ALTER TABLE "companies" ALTER COLUMN "source" SET DEFAULT 'OTHER';
COMMIT;

-- DropForeignKey
ALTER TABLE "sourced_companies" DROP CONSTRAINT "sourced_companies_assignedToUserId_fkey";

-- DropForeignKey
ALTER TABLE "sourced_companies" DROP CONSTRAINT "sourced_companies_batchId_fkey";

-- DropForeignKey
ALTER TABLE "sourced_companies" DROP CONSTRAINT "sourced_companies_companyId_fkey";

-- DropForeignKey
ALTER TABLE "sourced_companies" DROP CONSTRAINT "sourced_companies_industryId_fkey";

-- DropForeignKey
ALTER TABLE "sourced_companies" DROP CONSTRAINT "sourced_companies_phoneConfirmedById_fkey";

-- DropForeignKey
ALTER TABLE "sourced_companies" DROP CONSTRAINT "sourced_companies_reviewedById_fkey";

-- DropForeignKey
ALTER TABLE "sourced_companies" DROP CONSTRAINT "sourced_companies_submittedById_fkey";

-- DropForeignKey
ALTER TABLE "sourcing_batches" DROP CONSTRAINT "sourcing_batches_fetchedById_fkey";

-- DropIndex
DROP INDEX "companies_cin_key";

-- AlterTable
ALTER TABLE "companies" DROP COLUMN "cin";

-- DropTable
DROP TABLE "sourced_companies";

-- DropTable
DROP TABLE "sourcing_batches";

-- DropEnum
DROP TYPE "SourcingStatus";

-- CreateEnum
CREATE TYPE "OrderBusinessType" AS ENUM ('NEW', 'RENEWAL', 'NEW_TO_US_RENEWAL');

-- AlterTable
ALTER TABLE "company_products" ADD COLUMN     "businessType" "OrderBusinessType" NOT NULL DEFAULT 'NEW';

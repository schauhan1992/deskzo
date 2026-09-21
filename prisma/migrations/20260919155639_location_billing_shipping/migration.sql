-- AlterTable
ALTER TABLE "company_locations" ADD COLUMN     "isBilling" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isShipping" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "company_locations" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "country" TEXT,
    "gstNumber" TEXT,
    "gstTreatment" "GstTreatment" NOT NULL DEFAULT 'UNREGISTERED',
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_locations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "company_locations_companyId_idx" ON "company_locations"("companyId");

-- AddForeignKey
ALTER TABLE "company_locations" ADD CONSTRAINT "company_locations_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: one primary location per existing company, carrying over its current address/GST fields
INSERT INTO "company_locations" ("id", "companyId", "label", "address", "city", "state", "country", "gstNumber", "gstTreatment", "isPrimary", "createdAt", "updatedAt")
SELECT "id" || '_primary_location', "id", 'Head Office', "address", "city", "state", "country", "gstNumber", "gstTreatment", true, now(), now()
FROM "companies";

-- AlterTable: add locationId to company_products, nullable for backfill
ALTER TABLE "company_products" ADD COLUMN "locationId" TEXT;

-- Backfill: every existing order points at its company's new primary location
UPDATE "company_products" SET "locationId" = "companyId" || '_primary_location';

-- AlterTable: now require it
ALTER TABLE "company_products" ALTER COLUMN "locationId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "company_products_locationId_idx" ON "company_products"("locationId");

-- AddForeignKey
ALTER TABLE "company_products" ADD CONSTRAINT "company_products_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "company_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable: address/GST now live on company_locations, not companies
ALTER TABLE "companies" DROP COLUMN "address";
ALTER TABLE "companies" DROP COLUMN "city";
ALTER TABLE "companies" DROP COLUMN "state";
ALTER TABLE "companies" DROP COLUMN "country";
ALTER TABLE "companies" DROP COLUMN "gstNumber";
ALTER TABLE "companies" DROP COLUMN "gstTreatment";

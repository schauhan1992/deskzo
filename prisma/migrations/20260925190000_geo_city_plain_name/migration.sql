-- AlterTable
ALTER TABLE "geo_cities" ADD COLUMN     "plainName" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX "geo_cities_countryCode_plainName_idx" ON "geo_cities"("countryCode", "plainName");

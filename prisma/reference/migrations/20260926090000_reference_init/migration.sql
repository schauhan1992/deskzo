-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "post_offices" (
    "id" SERIAL NOT NULL,
    "pincode" CHAR(6) NOT NULL,
    "officeName" TEXT NOT NULL,
    "officeType" TEXT,
    "delivery" BOOLEAN NOT NULL DEFAULT true,
    "district" TEXT NOT NULL,
    "districtKey" TEXT NOT NULL,
    "stateName" TEXT NOT NULL,
    "stateCode" CHAR(2),
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),

    CONSTRAINT "post_offices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reference_datasets" (
    "key" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "unresolvedStates" JSONB,
    "loadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reference_datasets_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "reference_syncs" (
    "key" TEXT NOT NULL,
    "apiKeyCipher" TEXT,
    "status" TEXT NOT NULL DEFAULT 'IDLE',
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "fetched" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER,
    "message" TEXT,
    "startedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reference_syncs_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "geo_states" (
    "countryCode" CHAR(2) NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "asciiName" TEXT NOT NULL,

    CONSTRAINT "geo_states_pkey" PRIMARY KEY ("countryCode","code")
);

-- CreateTable
CREATE TABLE "geo_cities" (
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "asciiName" TEXT NOT NULL,
    "plainName" TEXT NOT NULL DEFAULT '',
    "countryCode" CHAR(2) NOT NULL,
    "stateCode" TEXT,
    "population" INTEGER NOT NULL DEFAULT 0,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),

    CONSTRAINT "geo_cities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "geo_postal_codes" (
    "id" SERIAL NOT NULL,
    "countryCode" CHAR(2) NOT NULL,
    "postalCode" TEXT NOT NULL,
    "postalKey" TEXT NOT NULL,
    "placeName" TEXT NOT NULL,
    "stateName" TEXT,
    "stateCode" TEXT,
    "district" TEXT,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),

    CONSTRAINT "geo_postal_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "post_offices_pincode_idx" ON "post_offices"("pincode");

-- CreateIndex
CREATE INDEX "post_offices_stateCode_districtKey_idx" ON "post_offices"("stateCode", "districtKey");

-- CreateIndex
CREATE INDEX "geo_cities_countryCode_stateCode_idx" ON "geo_cities"("countryCode", "stateCode");

-- CreateIndex
CREATE INDEX "geo_cities_countryCode_asciiName_idx" ON "geo_cities"("countryCode", "asciiName");

-- CreateIndex
CREATE INDEX "geo_cities_countryCode_plainName_idx" ON "geo_cities"("countryCode", "plainName");

-- CreateIndex
CREATE INDEX "geo_postal_codes_countryCode_postalKey_idx" ON "geo_postal_codes"("countryCode", "postalKey");


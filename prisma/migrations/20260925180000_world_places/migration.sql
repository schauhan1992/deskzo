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
CREATE INDEX "geo_cities_countryCode_stateCode_idx" ON "geo_cities"("countryCode", "stateCode");

-- CreateIndex
CREATE INDEX "geo_cities_countryCode_asciiName_idx" ON "geo_cities"("countryCode", "asciiName");

-- CreateIndex
CREATE INDEX "geo_postal_codes_countryCode_postalKey_idx" ON "geo_postal_codes"("countryCode", "postalKey");

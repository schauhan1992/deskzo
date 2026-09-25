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

-- CreateIndex
CREATE INDEX "post_offices_pincode_idx" ON "post_offices"("pincode");

-- CreateIndex
CREATE INDEX "post_offices_stateCode_districtKey_idx" ON "post_offices"("stateCode", "districtKey");

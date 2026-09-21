-- AlterEnum
ALTER TYPE "ItemType" ADD VALUE 'PERPETUAL';

-- AlterTable
ALTER TABLE "items" ADD COLUMN     "brandId" TEXT,
ADD COLUMN     "productFamilyId" TEXT;

-- CreateTable
CREATE TABLE "brands" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_families" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_families_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "brands_name_key" ON "brands"("name");

-- CreateIndex
CREATE INDEX "product_families_brandId_idx" ON "product_families"("brandId");

-- CreateIndex
CREATE UNIQUE INDEX "product_families_brandId_name_key" ON "product_families"("brandId", "name");

-- CreateIndex
CREATE INDEX "items_brandId_idx" ON "items"("brandId");

-- CreateIndex
CREATE INDEX "items_productFamilyId_idx" ON "items"("productFamilyId");

-- AddForeignKey
ALTER TABLE "product_families" ADD CONSTRAINT "product_families_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_productFamilyId_fkey" FOREIGN KEY ("productFamilyId") REFERENCES "product_families"("id") ON DELETE SET NULL ON UPDATE CASCADE;

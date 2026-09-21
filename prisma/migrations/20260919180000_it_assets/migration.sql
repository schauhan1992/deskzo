-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('LAPTOP', 'DESKTOP', 'SERVER', 'MONITOR', 'PRINTER', 'NETWORK', 'PHONE', 'TABLET', 'PERIPHERAL', 'SOFTWARE_LICENCE', 'OTHER');

-- CreateEnum
CREATE TYPE "AssetOwnership" AS ENUM ('INTERNAL', 'DEPLOYED', 'CLIENT_OWNED');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('IN_STOCK', 'ASSIGNED', 'IN_TRANSIT', 'INSTALLED', 'UNDER_REPAIR', 'RETIRED', 'LOST');

-- CreateEnum
CREATE TYPE "AssetMovementType" AS ENUM ('RECEIVED', 'ASSIGNED', 'DISPATCHED', 'DELIVERED', 'INSTALLED', 'RETURNED', 'SENT_FOR_REPAIR', 'BACK_FROM_REPAIR', 'TRANSFERRED', 'SCRAPPED', 'LOST');

-- CreateEnum
CREATE TYPE "ConsignmentStatus" AS ENUM ('DRAFT', 'DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ConsignmentReason" AS ENUM ('SALE_DELIVERY', 'DEPLOYMENT', 'REPAIR_OUT', 'REPAIR_RETURN', 'RETURN_TO_VENDOR', 'INTERNAL_TRANSFER', 'COLLECTION');

-- AlterEnum
ALTER TYPE "TradeDocumentType" ADD VALUE 'DELIVERY_CHALLAN';

-- AlterTable
ALTER TABLE "tickets" ADD COLUMN     "assetId" TEXT;

-- CreateTable
CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "assetTag" TEXT NOT NULL,
    "serialNumber" TEXT,
    "name" TEXT NOT NULL,
    "kind" "AssetKind" NOT NULL DEFAULT 'LAPTOP',
    "status" "AssetStatus" NOT NULL DEFAULT 'IN_STOCK',
    "make" TEXT,
    "model" TEXT,
    "specification" TEXT,
    "itemId" TEXT,
    "ownership" "AssetOwnership" NOT NULL DEFAULT 'INTERNAL',
    "ownerCompanyId" TEXT,
    "fixedAssetId" TEXT,
    "siteCompanyId" TEXT,
    "locationId" TEXT,
    "custodianUserId" TEXT,
    "holderContactId" TEXT,
    "companyProductId" TEXT,
    "amcProductId" TEXT,
    "vendorCompanyId" TEXT,
    "purchasedOn" DATE,
    "purchaseCost" DECIMAL(14,2),
    "warrantyEndsOn" DATE,
    "amcEndsOn" DATE,
    "licenceKey" TEXT,
    "seats" INTEGER,
    "notes" TEXT,
    "retiredOn" DATE,
    "retiredReason" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_movements" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "type" "AssetMovementType" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "fromCompanyId" TEXT,
    "fromLocationId" TEXT,
    "fromUserId" TEXT,
    "fromLabel" TEXT,
    "toCompanyId" TEXT,
    "toLocationId" TEXT,
    "toUserId" TEXT,
    "toContactId" TEXT,
    "toLabel" TEXT,
    "consignmentId" TEXT,
    "ticketId" TEXT,
    "visitId" TEXT,
    "note" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" TEXT,
    "recordedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consignments" (
    "id" TEXT NOT NULL,
    "consignmentNumber" TEXT NOT NULL,
    "reason" "ConsignmentReason" NOT NULL DEFAULT 'SALE_DELIVERY',
    "status" "ConsignmentStatus" NOT NULL DEFAULT 'DRAFT',
    "fromLabel" TEXT,
    "toCompanyId" TEXT,
    "toLocationId" TEXT,
    "toContactId" TEXT,
    "toAddress" TEXT,
    "courier" TEXT,
    "docketNumber" TEXT,
    "lrNumber" TEXT,
    "vehicleNumber" TEXT,
    "dispatchedOn" TIMESTAMP(3),
    "expectedOn" DATE,
    "deliveredOn" TIMESTAMP(3),
    "receivedBy" TEXT,
    "declaredValue" DECIMAL(14,2),
    "interstate" BOOLEAN NOT NULL DEFAULT false,
    "ewayBillNumber" TEXT,
    "ewayBillValidUntil" TIMESTAMP(3),
    "documentId" TEXT,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "assets_assetTag_key" ON "assets"("assetTag");

-- CreateIndex
CREATE UNIQUE INDEX "assets_serialNumber_key" ON "assets"("serialNumber");

-- CreateIndex
CREATE UNIQUE INDEX "assets_fixedAssetId_key" ON "assets"("fixedAssetId");

-- CreateIndex
CREATE INDEX "assets_ownership_status_idx" ON "assets"("ownership", "status");

-- CreateIndex
CREATE INDEX "assets_ownerCompanyId_idx" ON "assets"("ownerCompanyId");

-- CreateIndex
CREATE INDEX "assets_siteCompanyId_idx" ON "assets"("siteCompanyId");

-- CreateIndex
CREATE INDEX "assets_custodianUserId_idx" ON "assets"("custodianUserId");

-- CreateIndex
CREATE INDEX "assets_warrantyEndsOn_idx" ON "assets"("warrantyEndsOn");

-- CreateIndex
CREATE INDEX "assets_amcEndsOn_idx" ON "assets"("amcEndsOn");

-- CreateIndex
CREATE INDEX "asset_movements_assetId_occurredAt_idx" ON "asset_movements"("assetId", "occurredAt");

-- CreateIndex
CREATE INDEX "asset_movements_consignmentId_idx" ON "asset_movements"("consignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "consignments_consignmentNumber_key" ON "consignments"("consignmentNumber");

-- CreateIndex
CREATE INDEX "consignments_status_dispatchedOn_idx" ON "consignments"("status", "dispatchedOn");

-- CreateIndex
CREATE INDEX "consignments_toCompanyId_idx" ON "consignments"("toCompanyId");

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_ownerCompanyId_fkey" FOREIGN KEY ("ownerCompanyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_fixedAssetId_fkey" FOREIGN KEY ("fixedAssetId") REFERENCES "fixed_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_siteCompanyId_fkey" FOREIGN KEY ("siteCompanyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "company_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_custodianUserId_fkey" FOREIGN KEY ("custodianUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_holderContactId_fkey" FOREIGN KEY ("holderContactId") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_companyProductId_fkey" FOREIGN KEY ("companyProductId") REFERENCES "company_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_amcProductId_fkey" FOREIGN KEY ("amcProductId") REFERENCES "company_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_vendorCompanyId_fkey" FOREIGN KEY ("vendorCompanyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_movements" ADD CONSTRAINT "asset_movements_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_movements" ADD CONSTRAINT "asset_movements_fromCompanyId_fkey" FOREIGN KEY ("fromCompanyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_movements" ADD CONSTRAINT "asset_movements_fromLocationId_fkey" FOREIGN KEY ("fromLocationId") REFERENCES "company_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_movements" ADD CONSTRAINT "asset_movements_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_movements" ADD CONSTRAINT "asset_movements_toCompanyId_fkey" FOREIGN KEY ("toCompanyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_movements" ADD CONSTRAINT "asset_movements_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "company_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_movements" ADD CONSTRAINT "asset_movements_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_movements" ADD CONSTRAINT "asset_movements_toContactId_fkey" FOREIGN KEY ("toContactId") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_movements" ADD CONSTRAINT "asset_movements_consignmentId_fkey" FOREIGN KEY ("consignmentId") REFERENCES "consignments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_movements" ADD CONSTRAINT "asset_movements_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_movements" ADD CONSTRAINT "asset_movements_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "visits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_movements" ADD CONSTRAINT "asset_movements_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_movements" ADD CONSTRAINT "asset_movements_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consignments" ADD CONSTRAINT "consignments_toCompanyId_fkey" FOREIGN KEY ("toCompanyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consignments" ADD CONSTRAINT "consignments_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "company_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consignments" ADD CONSTRAINT "consignments_toContactId_fkey" FOREIGN KEY ("toContactId") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consignments" ADD CONSTRAINT "consignments_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "trade_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consignments" ADD CONSTRAINT "consignments_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- CreateEnum
CREATE TYPE "TransportMode" AS ENUM ('ROAD', 'RAIL', 'AIR', 'SHIP');

-- CreateEnum
CREATE TYPE "VehicleType" AS ENUM ('REGULAR', 'OVER_DIMENSIONAL_CARGO');

-- CreateEnum
CREATE TYPE "EwayBillStatus" AS ENUM ('NOT_REQUIRED', 'REQUIRED', 'GENERATED', 'CANCELLED', 'FAILED');

-- AlterTable
ALTER TABLE "consignments"
  ADD COLUMN "ewayBillStatus" "EwayBillStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
  ADD COLUMN "ewayBillDate" TIMESTAMP(3),
  ADD COLUMN "ewayBillError" TEXT,
  ADD COLUMN "ewayBillCancelledAt" TIMESTAMP(3),
  ADD COLUMN "ewayBillCancelReason" TEXT,
  ADD COLUMN "transporterId" TEXT,
  ADD COLUMN "transporterName" TEXT,
  ADD COLUMN "transportMode" "TransportMode" NOT NULL DEFAULT 'ROAD',
  ADD COLUMN "vehicleType" "VehicleType" NOT NULL DEFAULT 'REGULAR',
  ADD COLUMN "distanceKm" INTEGER;

-- A consignment that already has a bill number was generated before this existed; say so rather
-- than leaving it reading NOT_REQUIRED, which would be a false statement about compliance.
UPDATE "consignments" SET "ewayBillStatus" = 'GENERATED' WHERE "ewayBillNumber" IS NOT NULL;

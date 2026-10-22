-- Field work in the Deskzo app (owner, 22 Oct 2026): where the phone was at a visit's check-in and check-out, and
-- the amount above which an expense claim needs its receipt.

-- CreateEnum
CREATE TYPE "VisitLocationKind" AS ENUM ('IN', 'OUT');

-- CreateTable
CREATE TABLE "visit_locations" (
    "id" TEXT NOT NULL,
    "visitId" TEXT NOT NULL,
    "kind" "VisitLocationKind" NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "accuracyM" INTEGER,
    "mocked" BOOLEAN,
    "appDeviceId" TEXT,

    CONSTRAINT "visit_locations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "visit_locations_visitId_idx" ON "visit_locations"("visitId");

-- AddForeignKey
ALTER TABLE "visit_locations" ADD CONSTRAINT "visit_locations_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "visits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit_locations" ADD CONSTRAINT "visit_locations_appDeviceId_fkey" FOREIGN KEY ("appDeviceId") REFERENCES "app_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "expense_settings" ADD COLUMN "receiptRequiredAbove" DECIMAL(12,2);

-- GPS attendance with administrator exceptions (owner, 22 Oct 2026) — src/lib/hr/geofence.ts, src/lib/hr/clock.ts.
--
-- Additive only. Each office (branch) gains its point, a radius (100 m to start), the least accuracy a reading
-- may have (50 m), and two switches — enforcement, OFF for every existing office, so nobody's clocking changes
-- until an administrator sets the office up and turns it on; and whether an approved exception may stand in.
-- Each clocking's location row gains how it was checked; its coordinates become optional, for a clocking an
-- exception allowed with no location at all. Exceptions get their own table.
--
-- Nothing existing is rewritten: old attendance_locations rows keep their coordinates and read as "checked: —".
--
-- Recovery: restore the pre-migration dump; or, by hand, DROP TABLE "attendance_exceptions", drop the new
-- columns from "branches" and "attendance_locations", drop the four new types (the two notification values stay — Postgres cannot drop an enum value), and — only if no row has NULL
-- coordinates — set "attendance_locations"."latitude"/"longitude" NOT NULL again.

-- AlterEnum: the notices an exception request and its decision send.
ALTER TYPE "NotificationType" ADD VALUE 'ATTENDANCE_EXCEPTION_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE 'ATTENDANCE_EXCEPTION_DECIDED';

-- CreateEnum
CREATE TYPE "AttendanceGeoCheck" AS ENUM ('INSIDE', 'EXCEPTION', 'NOT_ENFORCED');

-- CreateEnum
CREATE TYPE "AttendanceExceptionScope" AS ENUM ('IN', 'OUT', 'IN_AND_OUT');

-- CreateEnum
CREATE TYPE "AttendanceExceptionReason" AS ENUM ('ALTERNATE_LOCATION', 'GPS_UNAVAILABLE', 'CORRECTION', 'OTHER');

-- CreateEnum
CREATE TYPE "AttendanceExceptionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'REVOKED');

-- AlterTable
ALTER TABLE "branches" ADD COLUMN     "geoExceptionsAllowed" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "geoMaxAccuracyM" INTEGER NOT NULL DEFAULT 50,
ADD COLUMN     "geofenceEnforced" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "geofenceRadiusM" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "longitude" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "attendance_locations" ADD COLUMN     "branchId" TEXT,
ADD COLUMN     "check" "AttendanceGeoCheck",
ADD COLUMN     "distanceM" INTEGER,
ADD COLUMN     "exceptionId" TEXT,
ADD COLUMN     "mocked" BOOLEAN,
ADD COLUMN     "radiusM" INTEGER,
ALTER COLUMN "latitude" DROP NOT NULL,
ALTER COLUMN "longitude" DROP NOT NULL;

-- CreateTable
CREATE TABLE "attendance_exceptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scope" "AttendanceExceptionScope" NOT NULL,
    "reasonCode" "AttendanceExceptionReason" NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "AttendanceExceptionStatus" NOT NULL DEFAULT 'PENDING',
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attemptDistanceM" INTEGER,
    "attemptAccuracyM" INTEGER,
    "attemptProblem" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "revokedById" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "usedInAt" TIMESTAMP(3),
    "usedOutAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attendance_exceptions_userId_status_validUntil_idx" ON "attendance_exceptions"("userId", "status", "validUntil");

-- CreateIndex
CREATE INDEX "attendance_exceptions_status_requestedAt_idx" ON "attendance_exceptions"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "attendance_locations_exceptionId_idx" ON "attendance_locations"("exceptionId");

-- AddForeignKey
ALTER TABLE "attendance_locations" ADD CONSTRAINT "attendance_locations_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_locations" ADD CONSTRAINT "attendance_locations_exceptionId_fkey" FOREIGN KEY ("exceptionId") REFERENCES "attendance_exceptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_exceptions" ADD CONSTRAINT "attendance_exceptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_exceptions" ADD CONSTRAINT "attendance_exceptions_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_exceptions" ADD CONSTRAINT "attendance_exceptions_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_exceptions" ADD CONSTRAINT "attendance_exceptions_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- The rules the app keeps, kept by the database too.
ALTER TABLE "branches" ADD CONSTRAINT "branches_geo_point_check" CHECK (
  ("latitude" IS NULL AND "longitude" IS NULL)
  OR ("latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180)
);
ALTER TABLE "branches" ADD CONSTRAINT "branches_geofence_radius_check" CHECK ("geofenceRadiusM" BETWEEN 10 AND 5000);
ALTER TABLE "branches" ADD CONSTRAINT "branches_geo_accuracy_check" CHECK ("geoMaxAccuracyM" BETWEEN 5 AND 1000);
ALTER TABLE "attendance_locations" ADD CONSTRAINT "attendance_locations_point_check" CHECK (
  ("latitude" IS NULL AND "longitude" IS NULL)
  OR ("latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180)
);
ALTER TABLE "attendance_exceptions" ADD CONSTRAINT "attendance_exceptions_window_check" CHECK ("validUntil" > "validFrom");
ALTER TABLE "attendance_exceptions" ADD CONSTRAINT "attendance_exceptions_reason_check" CHECK (length(btrim("reason")) > 0);

-- Where somebody clocked in or out from the Deskzo app (src/app/api/app/attendance).
-- CreateEnum
CREATE TYPE "AttendanceLocationKind" AS ENUM ('IN', 'OUT');

-- CreateTable
CREATE TABLE "attendance_locations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "kind" "AttendanceLocationKind" NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "accuracyM" INTEGER,
    "appDeviceId" TEXT,

    CONSTRAINT "attendance_locations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attendance_locations_userId_date_idx" ON "attendance_locations"("userId", "date");

-- AddForeignKey
ALTER TABLE "attendance_locations" ADD CONSTRAINT "attendance_locations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_locations" ADD CONSTRAINT "attendance_locations_appDeviceId_fkey" FOREIGN KEY ("appDeviceId") REFERENCES "app_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Written by hand: a place on Earth.
ALTER TABLE "attendance_locations" ADD CONSTRAINT "attendance_locations_on_earth" CHECK ("latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180);

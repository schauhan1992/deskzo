-- AlterTable
ALTER TABLE "employee_profiles" ADD COLUMN     "biometricId" TEXT;

-- CreateTable
CREATE TABLE "biometric_devices" (
    "id" TEXT NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deviceModel" TEXT,
    "firmware" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "lastPunchAt" TIMESTAMP(3),
    "punchesReceived" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "biometric_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "biometric_punches" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "deviceUserId" TEXT NOT NULL,
    "punchedAt" TIMESTAMP(3) NOT NULL,
    "punchType" INTEGER,
    "verifyMode" INTEGER,
    "raw" TEXT NOT NULL,
    "userId" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "biometric_punches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "biometric_devices_serialNumber_key" ON "biometric_devices"("serialNumber");

-- CreateIndex
CREATE INDEX "biometric_punches_userId_punchedAt_idx" ON "biometric_punches"("userId", "punchedAt");

-- CreateIndex
CREATE INDEX "biometric_punches_processedAt_idx" ON "biometric_punches"("processedAt");

-- CreateIndex
CREATE INDEX "biometric_punches_deviceUserId_idx" ON "biometric_punches"("deviceUserId");

-- CreateIndex
CREATE UNIQUE INDEX "biometric_punches_deviceId_deviceUserId_punchedAt_key" ON "biometric_punches"("deviceId", "deviceUserId", "punchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "employee_profiles_biometricId_key" ON "employee_profiles"("biometricId");

-- AddForeignKey
ALTER TABLE "biometric_punches" ADD CONSTRAINT "biometric_punches_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "biometric_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biometric_punches" ADD CONSTRAINT "biometric_punches_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


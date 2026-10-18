-- CreateEnum
CREATE TYPE "CallSource" AS ENUM ('TYPED', 'PHONE');

-- CreateEnum
CREATE TYPE "AppCallRequestStatus" AS ENUM ('WAITING', 'TAKEN', 'LOGGED', 'EXPIRED');

-- AlterTable
ALTER TABLE "call_logs" ADD COLUMN     "appDeviceId" TEXT,
ADD COLUMN     "phoneCallKey" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "source" "CallSource" NOT NULL DEFAULT 'TYPED';

-- CreateTable
CREATE TABLE "app_devices" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "model" TEXT,
    "appVersion" TEXT,
    "pushToken" TEXT,
    "callSync" BOOLEAN NOT NULL DEFAULT false,
    "windowStart" TIMESTAMP(3),
    "windowCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_pairings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "appDeviceId" TEXT,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_pairings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_call_requests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "appDeviceId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "contactId" TEXT,
    "leadId" TEXT,
    "ticketId" TEXT,
    "companyProductId" TEXT,
    "phoneNumber" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" "AppCallRequestStatus" NOT NULL DEFAULT 'WAITING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "takenAt" TIMESTAMP(3),
    "callLogId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_call_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_devices_deviceId_key" ON "app_devices"("deviceId");

-- CreateIndex
CREATE INDEX "app_devices_userId_idx" ON "app_devices"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "app_pairings_codeHash_key" ON "app_pairings"("codeHash");

-- CreateIndex
CREATE UNIQUE INDEX "app_pairings_appDeviceId_key" ON "app_pairings"("appDeviceId");

-- CreateIndex
CREATE INDEX "app_pairings_userId_idx" ON "app_pairings"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "app_call_requests_callLogId_key" ON "app_call_requests"("callLogId");

-- CreateIndex
CREATE INDEX "app_call_requests_appDeviceId_status_idx" ON "app_call_requests"("appDeviceId", "status");

-- CreateIndex
CREATE INDEX "app_call_requests_userId_createdAt_idx" ON "app_call_requests"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "call_logs_appDeviceId_phoneCallKey_key" ON "call_logs"("appDeviceId", "phoneCallKey");

-- AddForeignKey
ALTER TABLE "call_logs" ADD CONSTRAINT "call_logs_appDeviceId_fkey" FOREIGN KEY ("appDeviceId") REFERENCES "app_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_devices" ADD CONSTRAINT "app_devices_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "user_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_devices" ADD CONSTRAINT "app_devices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_pairings" ADD CONSTRAINT "app_pairings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_call_requests" ADD CONSTRAINT "app_call_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_call_requests" ADD CONSTRAINT "app_call_requests_appDeviceId_fkey" FOREIGN KEY ("appDeviceId") REFERENCES "app_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Written by hand: a phone's number matched to a contact by its last ten digits (src/lib/app/match.ts) — how
-- India writes a mobile with or without +91 or 0. The expression is the lookup's own, character for character,
-- so the lookup can use it.
CREATE INDEX "contacts_phone_last_ten" ON "contacts" ((right(regexp_replace("phone", '[^0-9]', '', 'g'), 10))) WHERE "phone" IS NOT NULL;

-- CreateEnum
CREATE TYPE "DeviceKind" AS ENUM ('MOBILE', 'TABLET', 'COMPUTER');

-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "UnknownNetworkAction" AS ENUM ('ALLOW', 'ALERT', 'HOLD', 'BLOCK');

-- CreateEnum
CREATE TYPE "IpRuleAction" AS ENUM ('ALLOW', 'BLOCK');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActivityKind" ADD VALUE 'NEW_DEVICE';
ALTER TYPE "ActivityKind" ADD VALUE 'DEVICE_APPROVED';
ALTER TYPE "ActivityKind" ADD VALUE 'DEVICE_BLOCKED';
ALTER TYPE "ActivityKind" ADD VALUE 'NEW_NETWORK';
ALTER TYPE "ActivityKind" ADD VALUE 'ACCESS_HELD';
ALTER TYPE "ActivityKind" ADD VALUE 'IMPOSSIBLE_TRAVEL';
ALTER TYPE "ActivityKind" ADD VALUE 'SESSION_ENDED';

-- CreateTable
CREATE TABLE "user_devices" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "kind" "DeviceKind" NOT NULL,
    "label" TEXT NOT NULL,
    "userAgent" TEXT,
    "status" "DeviceStatus" NOT NULL DEFAULT 'PENDING',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastIp" TEXT,
    "lastPlace" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "locationSessionId" TEXT,

    CONSTRAINT "user_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sign_ins" (
    "id" TEXT NOT NULL,
    "sid" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT,
    "provider" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "userAgent" TEXT,
    "deviceKind" "DeviceKind",
    "city" TEXT,
    "region" TEXT,
    "countryCode" TEXT,
    "country" TEXT,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "gpsLatitude" DECIMAL(9,6),
    "gpsLongitude" DECIMAL(9,6),
    "gpsAccuracyM" INTEGER,
    "gpsAt" TIMESTAMP(3),
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "endedAt" TIMESTAMP(3),
    "endedById" TEXT,

    CONSTRAINT "sign_ins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_access_policies" (
    "roleKey" TEXT NOT NULL,
    "allowMobile" BOOLEAN NOT NULL DEFAULT true,
    "allowTablet" BOOLEAN NOT NULL DEFAULT true,
    "allowComputer" BOOLEAN NOT NULL DEFAULT true,
    "requireDeviceApproval" BOOLEAN NOT NULL DEFAULT false,
    "unknownNetwork" "UnknownNetworkAction" NOT NULL DEFAULT 'ALLOW',
    "requireLocation" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "role_access_policies_pkey" PRIMARY KEY ("roleKey")
);

-- CreateTable
CREATE TABLE "ip_rules" (
    "id" TEXT NOT NULL,
    "cidr" TEXT NOT NULL,
    "action" "IpRuleAction" NOT NULL,
    "label" TEXT NOT NULL,
    "roleKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "ip_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "network_addresses" (
    "ip" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUserId" TEXT,
    "lastUserName" TEXT,
    "city" TEXT,
    "region" TEXT,
    "countryCode" TEXT,
    "country" TEXT,
    "isPrivate" BOOLEAN NOT NULL DEFAULT false,
    "heldAt" TIMESTAMP(3),
    "alertedAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),

    CONSTRAINT "network_addresses_pkey" PRIMARY KEY ("ip")
);

-- CreateIndex
CREATE INDEX "user_devices_status_idx" ON "user_devices"("status");

-- CreateIndex
CREATE UNIQUE INDEX "user_devices_userId_tokenHash_key" ON "user_devices"("userId", "tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "sign_ins_sid_key" ON "sign_ins"("sid");

-- CreateIndex
CREATE INDEX "sign_ins_userId_at_idx" ON "sign_ins"("userId", "at");

-- CreateIndex
CREATE INDEX "sign_ins_at_idx" ON "sign_ins"("at");

-- CreateIndex
CREATE INDEX "ip_rules_action_idx" ON "ip_rules"("action");

-- CreateIndex
CREATE INDEX "network_addresses_lastSeenAt_idx" ON "network_addresses"("lastSeenAt");

-- AddForeignKey
ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sign_ins" ADD CONSTRAINT "sign_ins_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sign_ins" ADD CONSTRAINT "sign_ins_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "user_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sign_ins" ADD CONSTRAINT "sign_ins_endedById_fkey" FOREIGN KEY ("endedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_access_policies" ADD CONSTRAINT "role_access_policies_roleKey_fkey" FOREIGN KEY ("roleKey") REFERENCES "roles"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_access_policies" ADD CONSTRAINT "role_access_policies_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ip_rules" ADD CONSTRAINT "ip_rules_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

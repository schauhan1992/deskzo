-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('OWNER', 'ADMIN', 'SUPPORT', 'BILLING', 'READONLY');

-- CreateEnum
CREATE TYPE "SupportAccessLevel" AS ENUM ('READONLY', 'ADMIN');

-- CreateTable
CREATE TABLE "platform_users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "StaffRole" NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "totpSecretCipher" TEXT,
    "totpEnabledAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastSignInAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "mfaAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "platform_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_access_grants" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "level" "SupportAccessLevel" NOT NULL,
    "reason" TEXT NOT NULL,
    "grantedByUserId" TEXT NOT NULL,
    "grantedByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "support_access_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_users_email_key" ON "platform_users"("email");

-- CreateIndex
CREATE INDEX "platform_sessions_userId_idx" ON "platform_sessions"("userId");

-- CreateIndex
CREATE INDEX "support_access_grants_tenantId_expiresAt_idx" ON "support_access_grants"("tenantId", "expiresAt");

-- AddForeignKey
ALTER TABLE "platform_sessions" ADD CONSTRAINT "platform_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "platform_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


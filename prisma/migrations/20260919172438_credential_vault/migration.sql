-- CreateEnum
CREATE TYPE "VaultAccessLevel" AS ENUM ('VIEW', 'MANAGE');

-- CreateEnum
CREATE TYPE "VaultRevealVia" AS ENUM ('OWNER', 'SHARE', 'DEPARTMENT', 'ADMIN');

-- CreateEnum
CREATE TYPE "VaultField" AS ENUM ('PASSWORD', 'RECOVERY_KEY');

-- CreateEnum
CREATE TYPE "CredentialTagKind" AS ENUM ('CATEGORY', 'ACCESS_TYPE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'VAULT_CREDENTIAL_OPENED';
ALTER TYPE "NotificationType" ADD VALUE 'VAULT_SHARED';

-- CreateTable
CREATE TABLE "credential_tags" (
    "id" TEXT NOT NULL,
    "kind" "CredentialTagKind" NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credential_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vault_credentials" (
    "id" TEXT NOT NULL,
    "loginName" TEXT NOT NULL,
    "categoryId" TEXT,
    "accessTypeId" TEXT,
    "username" TEXT,
    "email" TEXT,
    "loginUrl" TEXT,
    "phone" TEXT,
    "secretCipher" TEXT NOT NULL,
    "secretDigest" TEXT NOT NULL,
    "recoveryKeyCipher" TEXT,
    "remarks" TEXT,
    "billingExpiry" TIMESTAMP(3),
    "passwordChangedAt" TIMESTAMP(3),
    "rotateAfterDays" INTEGER,
    "ownerId" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vault_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vault_shares" (
    "id" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "userId" TEXT,
    "departmentId" TEXT,
    "level" "VaultAccessLevel" NOT NULL DEFAULT 'VIEW',
    "sharedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "vault_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vault_reveals" (
    "id" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "via" "VaultRevealVia" NOT NULL,
    "field" "VaultField" NOT NULL DEFAULT 'PASSWORD',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vault_reveals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "credential_tags_kind_name_key" ON "credential_tags"("kind", "name");

-- CreateIndex
CREATE INDEX "vault_credentials_ownerId_idx" ON "vault_credentials"("ownerId");

-- CreateIndex
CREATE INDEX "vault_credentials_secretDigest_idx" ON "vault_credentials"("secretDigest");

-- CreateIndex
CREATE INDEX "vault_shares_userId_idx" ON "vault_shares"("userId");

-- CreateIndex
CREATE INDEX "vault_shares_departmentId_idx" ON "vault_shares"("departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "vault_shares_credentialId_userId_key" ON "vault_shares"("credentialId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "vault_shares_credentialId_departmentId_key" ON "vault_shares"("credentialId", "departmentId");

-- CreateIndex
CREATE INDEX "vault_reveals_credentialId_idx" ON "vault_reveals"("credentialId");

-- CreateIndex
CREATE INDEX "vault_reveals_userId_idx" ON "vault_reveals"("userId");

-- AddForeignKey
ALTER TABLE "vault_credentials" ADD CONSTRAINT "vault_credentials_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "credential_tags"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vault_credentials" ADD CONSTRAINT "vault_credentials_accessTypeId_fkey" FOREIGN KEY ("accessTypeId") REFERENCES "credential_tags"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vault_credentials" ADD CONSTRAINT "vault_credentials_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vault_credentials" ADD CONSTRAINT "vault_credentials_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vault_shares" ADD CONSTRAINT "vault_shares_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "vault_credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vault_shares" ADD CONSTRAINT "vault_shares_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vault_shares" ADD CONSTRAINT "vault_shares_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vault_shares" ADD CONSTRAINT "vault_shares_sharedById_fkey" FOREIGN KEY ("sharedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vault_reveals" ADD CONSTRAINT "vault_reveals_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "vault_credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vault_reveals" ADD CONSTRAINT "vault_reveals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

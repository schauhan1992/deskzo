-- AlterTable
ALTER TABLE "users" ADD COLUMN     "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "twoFactorEnabledAt" TIMESTAMP(3),
ADD COLUMN     "twoFactorSecretCipher" TEXT;

-- CreateTable
CREATE TABLE "security_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "enforceTwoFactor" BOOLEAN NOT NULL DEFAULT false,
    "ssoEnabled" BOOLEAN NOT NULL DEFAULT false,
    "enforceSso" BOOLEAN NOT NULL DEFAULT false,
    "microsoftTenantId" TEXT,
    "microsoftClientId" TEXT,
    "microsoftClientSecretCipher" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "security_settings_pkey" PRIMARY KEY ("id")
);

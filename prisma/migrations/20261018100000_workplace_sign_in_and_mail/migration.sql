-- Microsoft 365, Google Workspace and Zoho: sign-in and people's own mailboxes with any of them, and the
-- authenticator app the two-factor screens recommend (src/lib/workplace, src/lib/mail, Settings → Security).

-- The authenticator app the setup screens name. Every app reads the same code; ANY lets each person pick.
CREATE TYPE "AuthenticatorApp" AS ENUM ('ANY', 'GOOGLE', 'MICROSOFT');
ALTER TABLE "security_settings" ADD COLUMN "authenticatorApp" "AuthenticatorApp" NOT NULL DEFAULT 'ANY';

-- A mailbox can now be Gmail or Zoho Mail as well as Outlook. (The new values are not used again in this
-- migration: a value added to an enum can't be used in the transaction that adds it.)
ALTER TYPE "MailConnectionProvider" ADD VALUE 'GOOGLE';
ALTER TYPE "MailConnectionProvider" ADD VALUE 'ZOHO';

-- Zoho's data centre and Zoho Mail account for a Zoho mailbox.
ALTER TABLE "mail_connections" ADD COLUMN "zohoAccountsServer" TEXT,
ADD COLUMN "zohoMailAccountId" TEXT;

-- CreateTable
CREATE TABLE "workplace_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "microsoftMail" BOOLEAN NOT NULL DEFAULT true,
    "googleClientId" TEXT,
    "googleClientSecretCipher" TEXT,
    "googleSso" BOOLEAN NOT NULL DEFAULT false,
    "googleDomain" TEXT,
    "googleMail" BOOLEAN NOT NULL DEFAULT true,
    "zohoClientId" TEXT,
    "zohoClientSecretCipher" TEXT,
    "zohoRegion" TEXT NOT NULL DEFAULT 'in',
    "zohoSso" BOOLEAN NOT NULL DEFAULT false,
    "zohoMail" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workplace_settings_pkey" PRIMARY KEY ("id")
);

-- One row, the workspace's; a data centre Zoho has.
ALTER TABLE "workplace_settings" ADD CONSTRAINT "workplace_settings_one_row" CHECK ("id" = 'global');
ALTER TABLE "workplace_settings" ADD CONSTRAINT "workplace_settings_zoho_region" CHECK ("zohoRegion" IN ('com', 'eu', 'in', 'com.au', 'jp', 'ca', 'sa', 'uk'));

-- Platform mail (owner, 5 Oct 2026): the accounts the platform's own mail goes through — Microsoft 365
-- (OAuth), AWS SES, Elastic Email, SendGrid, Brevo, Mailgun, Postmark or any SMTP server — chosen per
-- type of mail in the console (Settings › Mail), and a log of every send kept 90 days
-- (src/lib/platform/mail). PLATFORM_SMTP_URL stays as the fallback while no account is set.


-- CreateEnum
CREATE TYPE "MailProvider" AS ENUM ('MICROSOFT_365', 'AWS_SES', 'ELASTIC_EMAIL', 'SENDGRID', 'BREVO', 'MAILGUN', 'POSTMARK', 'SMTP');

-- CreateEnum
CREATE TYPE "MailSecurity" AS ENUM ('TLS', 'STARTTLS');

-- CreateEnum
CREATE TYPE "MailStream" AS ENUM ('DEFAULT', 'ACCOUNT', 'BILLING', 'SUPPORT', 'ALERTS');

-- CreateEnum
CREATE TYPE "MailDeliveryStatus" AS ENUM ('SENT', 'FAILED', 'OUTBOX');

-- CreateTable
CREATE TABLE "mail_connections" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" "MailProvider" NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "security" "MailSecurity" NOT NULL,
    "username" TEXT,
    "secretCipher" TEXT,
    "msTenantId" TEXT,
    "msClientId" TEXT,
    "fromAddress" TEXT NOT NULL,
    "fromName" TEXT,
    "lastTestAt" TIMESTAMP(3),
    "lastTestOk" BOOLEAN,
    "lastTestError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "mail_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_routes" (
    "stream" "MailStream" NOT NULL,
    "connectionId" TEXT,
    "fromName" TEXT,
    "fromAddress" TEXT,
    "replyTo" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "mail_routes_pkey" PRIMARY KEY ("stream")
);

-- CreateTable
CREATE TABLE "mail_deliveries" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stream" "MailStream" NOT NULL,
    "status" "MailDeliveryStatus" NOT NULL,
    "connectionId" TEXT,
    "via" TEXT NOT NULL,
    "toAddresses" TEXT[],
    "ccAddresses" TEXT[],
    "addresses" TEXT NOT NULL DEFAULT '',
    "fromAddress" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "error" TEXT,
    "messageId" TEXT,
    "ms" INTEGER,
    "test" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "mail_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mail_deliveries_at_idx" ON "mail_deliveries"("at");

-- CreateIndex
CREATE INDEX "mail_deliveries_stream_at_idx" ON "mail_deliveries"("stream", "at");

-- CreateIndex
CREATE INDEX "mail_deliveries_status_at_idx" ON "mail_deliveries"("status", "at");

-- AddForeignKey
ALTER TABLE "mail_routes" ADD CONSTRAINT "mail_routes_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "mail_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Written by hand: limits the schema cannot say.
ALTER TABLE "mail_connections" ADD CONSTRAINT "mail_connections_name_length" CHECK (char_length("name") BETWEEN 1 AND 80);
ALTER TABLE "mail_connections" ADD CONSTRAINT "mail_connections_host_length" CHECK (char_length("host") BETWEEN 1 AND 253);
ALTER TABLE "mail_connections" ADD CONSTRAINT "mail_connections_port_range" CHECK ("port" BETWEEN 1 AND 65535);
ALTER TABLE "mail_connections" ADD CONSTRAINT "mail_connections_from_length" CHECK (char_length("fromAddress") BETWEEN 3 AND 254);
ALTER TABLE "mail_connections" ADD CONSTRAINT "mail_connections_m365_signin" CHECK ("provider" <> 'MICROSOFT_365' OR ("msTenantId" IS NOT NULL AND "msClientId" IS NOT NULL AND "username" IS NOT NULL));
ALTER TABLE "mail_deliveries" ADD CONSTRAINT "mail_deliveries_subject_length" CHECK (char_length("subject") <= 300);
ALTER TABLE "mail_deliveries" ADD CONSTRAINT "mail_deliveries_error_length" CHECK ("error" IS NULL OR char_length("error") <= 300);

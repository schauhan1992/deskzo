-- CreateEnum
CREATE TYPE "PortalAccessMode" AS ENUM ('ALL', 'SELECTED');

-- CreateEnum
CREATE TYPE "PortalRequestKind" AS ENUM ('RENEWAL', 'ADD_SEATS', 'QUESTION');

-- CreateEnum
CREATE TYPE "PortalRequestStatus" AS ENUM ('NEW', 'IN_PROGRESS', 'DONE', 'DECLINED');

-- AlterTable
ALTER TABLE "companies" ADD COLUMN "portalEnabled" BOOLEAN;

-- CreateTable
CREATE TABLE "portal_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "access" "PortalAccessMode" NOT NULL DEFAULT 'SELECTED',
    "showSubscriptions" BOOLEAN NOT NULL DEFAULT true,
    "showInvoices" BOOLEAN NOT NULL DEFAULT true,
    "showPayments" BOOLEAN NOT NULL DEFAULT false,
    "showTickets" BOOLEAN NOT NULL DEFAULT true,
    "showAssets" BOOLEAN NOT NULL DEFAULT false,
    "showContacts" BOOLEAN NOT NULL DEFAULT false,
    "allowRenewalRequest" BOOLEAN NOT NULL DEFAULT true,
    "allowSeatRequest" BOOLEAN NOT NULL DEFAULT true,
    "allowQuestion" BOOLEAN NOT NULL DEFAULT true,
    "linkValidityDays" INTEGER,
    "welcomeMessage" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "portal_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portal_logins" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "contactId" TEXT,
    "personName" TEXT NOT NULL,
    "personEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "expiresAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "visits" INTEGER NOT NULL DEFAULT 0,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,

    CONSTRAINT "portal_logins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portal_requests" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "loginId" TEXT,
    "personName" TEXT NOT NULL,
    "personEmail" TEXT,
    "kind" "PortalRequestKind" NOT NULL,
    "companyProductId" TEXT,
    "quantity" INTEGER,
    "message" TEXT,
    "status" "PortalRequestStatus" NOT NULL DEFAULT 'NEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "handledById" TEXT,
    "handledAt" TIMESTAMP(3),
    "response" TEXT,

    CONSTRAINT "portal_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "portal_logins_token_key" ON "portal_logins"("token");

-- CreateIndex
CREATE INDEX "portal_logins_companyId_idx" ON "portal_logins"("companyId");

-- CreateIndex
CREATE INDEX "portal_requests_status_createdAt_idx" ON "portal_requests"("status", "createdAt");

-- CreateIndex
CREATE INDEX "portal_requests_companyId_idx" ON "portal_requests"("companyId");

-- AddForeignKey
ALTER TABLE "portal_settings" ADD CONSTRAINT "portal_settings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_logins" ADD CONSTRAINT "portal_logins_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_logins" ADD CONSTRAINT "portal_logins_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_logins" ADD CONSTRAINT "portal_logins_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_logins" ADD CONSTRAINT "portal_logins_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_requests" ADD CONSTRAINT "portal_requests_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_requests" ADD CONSTRAINT "portal_requests_loginId_fkey" FOREIGN KEY ("loginId") REFERENCES "portal_logins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_requests" ADD CONSTRAINT "portal_requests_companyProductId_fkey" FOREIGN KEY ("companyProductId") REFERENCES "company_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_requests" ADD CONSTRAINT "portal_requests_handledById_fkey" FOREIGN KEY ("handledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

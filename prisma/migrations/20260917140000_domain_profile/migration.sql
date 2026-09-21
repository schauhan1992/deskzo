-- CreateTable
CREATE TABLE "domain_profiles" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "finalUrl" TEXT,
    "httpStatus" INTEGER,
    "siteTitle" TEXT,
    "siteDescription" TEXT,
    "platform" TEXT,
    "platformEvidence" TEXT,
    "hostProvider" TEXT,
    "hostEvidence" TEXT,
    "ipAddress" TEXT,
    "mxHosts" TEXT[],
    "emailProvider" TEXT,
    "emailSecurityProvider" TEXT,
    "nsHosts" TEXT[],
    "dnsProvider" TEXT,
    "registrar" TEXT,
    "registeredOn" TIMESTAMP(3),
    "expiresOn" TIMESTAMP(3),
    "spfRecord" TEXT,
    "dmarcRecord" TEXT,
    "dmarcPolicy" TEXT,
    "dkimFound" BOOLEAN NOT NULL DEFAULT false,
    "screenshotUrl" TEXT,
    "fetchedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "domain_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "domain_profiles_companyId_key" ON "domain_profiles"("companyId");

-- CreateIndex
CREATE INDEX "domain_profiles_domain_idx" ON "domain_profiles"("domain");

-- CreateIndex
CREATE INDEX "domain_profiles_platform_idx" ON "domain_profiles"("platform");

-- CreateIndex
CREATE INDEX "domain_profiles_emailProvider_idx" ON "domain_profiles"("emailProvider");

-- AddForeignKey
ALTER TABLE "domain_profiles" ADD CONSTRAINT "domain_profiles_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;


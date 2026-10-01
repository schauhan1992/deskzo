-- Custom domains: a workspace adds an address of its own, proves it with a DNS record, and it is served
-- once verified. Plans say how many a workspace may have; staff may override it for one workspace.

-- CreateEnum
CREATE TYPE "DomainStatus" AS ENUM ('PENDING', 'ACTIVE', 'BROKEN');

-- DropIndex
DROP INDEX "tenant_domains_host_key";

-- AlterTable
ALTER TABLE "plans" ADD COLUMN     "customDomains" INTEGER DEFAULT 0;

-- AlterTable
ALTER TABLE "tenant_domains" ADD COLUMN     "addedBy" TEXT,
ADD COLUMN     "failingSince" TIMESTAMP(3),
ADD COLUMN     "lastCheckError" TEXT,
ADD COLUMN     "lastCheckedAt" TIMESTAMP(3),
ADD COLUMN     "status" "DomainStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "verifiedAt" TIMESTAMP(3),
ADD COLUMN     "verifyToken" TEXT;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "customDomainOverride" INTEGER;

-- CreateIndex
CREATE INDEX "tenant_domains_host_idx" ON "tenant_domains"("host");

-- CreateIndex
CREATE INDEX "tenant_domains_status_idx" ON "tenant_domains"("status");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_domains_tenantId_host_key" ON "tenant_domains"("tenantId", "host");


-- Written by hand: an address is unique among those that are served or were (several workspaces may
-- wait on the same one while PENDING; whichever proves it first gets it, and the others' are removed).
CREATE UNIQUE INDEX "tenant_domains_host_live" ON "tenant_domains" ("host") WHERE "status" <> 'PENDING';

-- Written by hand: a pending address always has the token its TXT record must carry; limits are never
-- negative.
ALTER TABLE "tenant_domains"
  ADD CONSTRAINT "tenant_domains_pending_has_token" CHECK ("status" <> 'PENDING' OR "verifyToken" IS NOT NULL);
ALTER TABLE "plans"
  ADD CONSTRAINT "plans_custom_domains_not_negative" CHECK ("customDomains" IS NULL OR "customDomains" >= 0);
ALTER TABLE "tenants"
  ADD CONSTRAINT "tenants_custom_domain_override_not_negative" CHECK ("customDomainOverride" IS NULL OR "customDomainOverride" >= 0);

-- Written by hand: the plans never sold (the installation's own workspace, staff test workspaces) have
-- no limit, like their seats; every sold plan starts with none until staff give it some.
UPDATE "plans" SET "customDomains" = NULL WHERE "kind" = 'INTERNAL';

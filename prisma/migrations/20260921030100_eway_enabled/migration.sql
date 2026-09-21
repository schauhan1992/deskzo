-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'PORTAL_REQUEST';

-- DropIndex
DROP INDEX "vault_credentials_companyId_idx";

-- AlterTable
ALTER TABLE "organisation_settings" ADD COLUMN     "ewayEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AddForeignKey
ALTER TABLE "eway_bills" ADD CONSTRAINT "eway_bills_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

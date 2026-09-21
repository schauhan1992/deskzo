-- CreateEnum
CREATE TYPE "VaultOwnership" AS ENUM ('OURS', 'CLIENT');

-- AlterTable
ALTER TABLE "vault_credentials" ADD COLUMN     "ownership" "VaultOwnership" NOT NULL DEFAULT 'OURS',
ADD COLUMN     "companyId" TEXT;

-- CreateIndex
CREATE INDEX "vault_credentials_companyId_idx" ON "vault_credentials"("companyId");

-- AddForeignKey
ALTER TABLE "vault_credentials" ADD CONSTRAINT "vault_credentials_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

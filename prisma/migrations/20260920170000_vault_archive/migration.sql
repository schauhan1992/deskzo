-- AlterTable
ALTER TABLE "vault_credentials" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "archivedById" TEXT,
ADD COLUMN     "archiveReason" TEXT;

-- CreateIndex
CREATE INDEX "vault_credentials_archivedAt_idx" ON "vault_credentials"("archivedAt");

-- AddForeignKey
ALTER TABLE "vault_credentials" ADD CONSTRAINT "vault_credentials_archivedById_fkey" FOREIGN KEY ("archivedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "impersonatedByUserId" TEXT;

-- CreateIndex
CREATE INDEX "audit_logs_impersonatedByUserId_idx" ON "audit_logs"("impersonatedByUserId");

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_impersonatedByUserId_fkey" FOREIGN KEY ("impersonatedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


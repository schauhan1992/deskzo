-- AlterTable
ALTER TABLE "trade_documents" ADD COLUMN     "leadId" TEXT;

-- CreateIndex
CREATE INDEX "trade_documents_leadId_idx" ON "trade_documents"("leadId");

-- AddForeignKey
ALTER TABLE "trade_documents" ADD CONSTRAINT "trade_documents_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;


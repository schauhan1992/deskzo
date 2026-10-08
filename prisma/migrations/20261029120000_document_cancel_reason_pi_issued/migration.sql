-- Owner, 8 Oct 2026: why a document was cancelled, by whom and when; and the salesperson told when
-- their proforma is issued.

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'PROFORMA_ISSUED';

-- AlterTable
ALTER TABLE "trade_documents" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledById" TEXT;

-- AddForeignKey
ALTER TABLE "trade_documents" ADD CONSTRAINT "trade_documents_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Those cancelled with their e-invoice already said why, on the e-invoice.
UPDATE "trade_documents"
SET "cancelReason" = "einvoiceCancelReason", "cancelledAt" = "einvoiceCancelledAt"
WHERE "status" = 'CANCELLED' AND "cancelReason" IS NULL AND "einvoiceCancelReason" IS NOT NULL;

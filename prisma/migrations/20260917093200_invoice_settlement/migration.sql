-- AlterTable
ALTER TABLE "payment_allocations" ADD COLUMN     "documentId" TEXT,
ALTER COLUMN "companyProductId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "credit_note_applications" (
    "id" TEXT NOT NULL,
    "creditNoteId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "appliedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_note_applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "credit_note_applications_creditNoteId_idx" ON "credit_note_applications"("creditNoteId");

-- CreateIndex
CREATE INDEX "credit_note_applications_invoiceId_idx" ON "credit_note_applications"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_note_applications_creditNoteId_invoiceId_key" ON "credit_note_applications"("creditNoteId", "invoiceId");

-- CreateIndex
CREATE INDEX "payment_allocations_documentId_idx" ON "payment_allocations"("documentId");

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "trade_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_applications" ADD CONSTRAINT "credit_note_applications_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "trade_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_applications" ADD CONSTRAINT "credit_note_applications_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "trade_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_applications" ADD CONSTRAINT "credit_note_applications_appliedByUserId_fkey" FOREIGN KEY ("appliedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

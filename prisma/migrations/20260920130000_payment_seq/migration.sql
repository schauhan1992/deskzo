-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "paymentSeq" SERIAL NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "payments_paymentSeq_key" ON "payments"("paymentSeq");


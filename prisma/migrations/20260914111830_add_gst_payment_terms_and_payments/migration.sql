-- CreateEnum
CREATE TYPE "GstTreatment" AS ENUM ('REGISTERED_REGULAR', 'REGISTERED_COMPOSITION', 'UNREGISTERED', 'CONSUMER', 'OVERSEAS', 'SEZ', 'DEEMED_EXPORT');

-- CreateEnum
CREATE TYPE "PaymentTerms" AS ENUM ('DUE_ON_RECEIPT', 'ADVANCE', 'NET_15', 'NET_30', 'NET_45', 'NET_60');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('BANK_TRANSFER', 'UPI', 'CHEQUE', 'CASH', 'CARD', 'OTHER');

-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'ACCOUNTS';

-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "gstTreatment" "GstTreatment" NOT NULL DEFAULT 'UNREGISTERED',
ADD COLUMN     "paymentTerms" "PaymentTerms" NOT NULL DEFAULT 'NET_30';

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "companyProductId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "paidOn" TIMESTAMP(3) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "recordedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payments_companyProductId_idx" ON "payments"("companyProductId");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_companyProductId_fkey" FOREIGN KEY ("companyProductId") REFERENCES "company_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_recordedByUserId_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

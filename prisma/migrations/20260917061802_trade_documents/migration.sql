-- CreateEnum
CREATE TYPE "TradeDirection" AS ENUM ('SALES', 'PURCHASE');

-- CreateEnum
CREATE TYPE "TradeDocumentType" AS ENUM ('PROPOSAL', 'PROFORMA', 'INVOICE', 'CREDIT_NOTE', 'PURCHASE_ORDER', 'BILL');

-- CreateEnum
CREATE TYPE "TradeDocumentStatus" AS ENUM ('DRAFT', 'ISSUED', 'ACCEPTED', 'REJECTED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "EInvoiceStatus" AS ENUM ('NOT_APPLICABLE', 'PENDING', 'GENERATED', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "items" ADD COLUMN     "hsnCode" TEXT;

-- CreateTable
CREATE TABLE "organisation_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "legalName" TEXT NOT NULL DEFAULT '',
    "tradeName" TEXT,
    "gstin" TEXT,
    "pan" TEXT,
    "cin" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "stateCode" TEXT,
    "pincode" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "bankName" TEXT,
    "bankAccountNumber" TEXT,
    "bankIfsc" TEXT,
    "bankBranch" TEXT,
    "upiId" TEXT,
    "invoiceTerms" TEXT,
    "invoiceNotes" TEXT,
    "signatureDataUrl" TEXT,
    "einvoiceEnabled" BOOLEAN NOT NULL DEFAULT false,
    "einvoiceProvider" TEXT NOT NULL DEFAULT 'mock',
    "einvoiceUsername" TEXT,
    "einvoicePasswordCipher" TEXT,
    "einvoiceClientId" TEXT,
    "einvoiceClientSecretCipher" TEXT,
    "einvoiceMinValue" DECIMAL(12,2),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organisation_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trade_documents" (
    "id" TEXT NOT NULL,
    "docNumber" TEXT NOT NULL,
    "docType" "TradeDocumentType" NOT NULL,
    "direction" "TradeDirection" NOT NULL,
    "status" "TradeDocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "companyId" TEXT NOT NULL,
    "locationId" TEXT,
    "placeOfSupplyCode" TEXT,
    "sellerGstin" TEXT,
    "buyerGstin" TEXT,
    "reverseCharge" BOOLEAN NOT NULL DEFAULT false,
    "issueDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueDate" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "sourceDocumentId" TEXT,
    "againstDocumentId" TEXT,
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discountTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxableValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "cgstAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "sgstAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "igstAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "roundOff" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "reference" TEXT,
    "notes" TEXT,
    "terms" TEXT,
    "einvoiceStatus" "EInvoiceStatus" NOT NULL DEFAULT 'NOT_APPLICABLE',
    "irn" TEXT,
    "ackNo" TEXT,
    "ackDate" TIMESTAMP(3),
    "signedQrCode" TEXT,
    "einvoiceError" TEXT,
    "einvoiceCancelledAt" TIMESTAMP(3),
    "einvoiceCancelReason" TEXT,
    "createdById" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trade_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trade_document_lines" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "itemId" TEXT,
    "companyProductId" TEXT,
    "description" TEXT NOT NULL,
    "hsnCode" TEXT,
    "unit" TEXT,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unitPrice" DECIMAL(14,2) NOT NULL,
    "discountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "taxRatePercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "taxableValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "cgstAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "sgstAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "igstAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "trade_document_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_counters" (
    "id" TEXT NOT NULL,
    "docType" "TradeDocumentType" NOT NULL,
    "financialYear" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "document_counters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trade_documents_docNumber_key" ON "trade_documents"("docNumber");

-- CreateIndex
CREATE UNIQUE INDEX "trade_documents_irn_key" ON "trade_documents"("irn");

-- CreateIndex
CREATE INDEX "trade_documents_companyId_idx" ON "trade_documents"("companyId");

-- CreateIndex
CREATE INDEX "trade_documents_docType_status_idx" ON "trade_documents"("docType", "status");

-- CreateIndex
CREATE INDEX "trade_documents_direction_issueDate_idx" ON "trade_documents"("direction", "issueDate");

-- CreateIndex
CREATE INDEX "trade_document_lines_documentId_idx" ON "trade_document_lines"("documentId");

-- CreateIndex
CREATE INDEX "trade_document_lines_itemId_idx" ON "trade_document_lines"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "document_counters_docType_financialYear_key" ON "document_counters"("docType", "financialYear");

-- AddForeignKey
ALTER TABLE "trade_documents" ADD CONSTRAINT "trade_documents_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_documents" ADD CONSTRAINT "trade_documents_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "company_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_documents" ADD CONSTRAINT "trade_documents_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "trade_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_documents" ADD CONSTRAINT "trade_documents_againstDocumentId_fkey" FOREIGN KEY ("againstDocumentId") REFERENCES "trade_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_documents" ADD CONSTRAINT "trade_documents_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_document_lines" ADD CONSTRAINT "trade_document_lines_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "trade_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_document_lines" ADD CONSTRAINT "trade_document_lines_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_document_lines" ADD CONSTRAINT "trade_document_lines_companyProductId_fkey" FOREIGN KEY ("companyProductId") REFERENCES "company_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

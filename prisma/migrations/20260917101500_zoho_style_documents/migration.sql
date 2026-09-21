-- New enums
CREATE TYPE "DocumentNumberMode" AS ENUM ('AUTO', 'MANUAL');
CREATE TYPE "DiscountMode" AS ENUM ('PERCENT', 'AMOUNT');
CREATE TYPE "WithholdingMode" AS ENUM ('NONE', 'TDS', 'TCS');

-- Per-document-type number format (prefix + next serial), separate from the GST year series.
CREATE TABLE "document_number_settings" (
    "docType" "TradeDocumentType" NOT NULL,
    "mode" "DocumentNumberMode" NOT NULL DEFAULT 'AUTO',
    "prefix" TEXT NOT NULL DEFAULT '',
    "nextNumber" INTEGER NOT NULL DEFAULT 1,
    "padding" INTEGER NOT NULL DEFAULT 4,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "document_number_settings_pkey" PRIMARY KEY ("docType")
);

-- Document: GST treatment, addresses, document-level charges
ALTER TABLE "trade_documents"
  ADD COLUMN "gstTreatment" "GstTreatment" NOT NULL DEFAULT 'UNREGISTERED',
  ADD COLUMN "dispatchFromAddress" TEXT,
  ADD COLUMN "billingAttention" TEXT,
  ADD COLUMN "billingLine1" TEXT,
  ADD COLUMN "billingLine2" TEXT,
  ADD COLUMN "billingCity" TEXT,
  ADD COLUMN "billingState" TEXT,
  ADD COLUMN "billingStateCode" TEXT,
  ADD COLUMN "billingPincode" TEXT,
  ADD COLUMN "billingCountry" TEXT DEFAULT 'India',
  ADD COLUMN "billingPhone" TEXT,
  ADD COLUMN "shippingSameAsBilling" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "shippingAttention" TEXT,
  ADD COLUMN "shippingLine1" TEXT,
  ADD COLUMN "shippingLine2" TEXT,
  ADD COLUMN "shippingCity" TEXT,
  ADD COLUMN "shippingState" TEXT,
  ADD COLUMN "shippingStateCode" TEXT,
  ADD COLUMN "shippingPincode" TEXT,
  ADD COLUMN "shippingCountry" TEXT DEFAULT 'India',
  ADD COLUMN "shippingPhone" TEXT,
  ADD COLUMN "shippingGstin" TEXT,
  ADD COLUMN "shippingCharge" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "shippingTaxRatePercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN "withholdingMode" "WithholdingMode" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "withholdingSection" TEXT,
  ADD COLUMN "withholdingRatePercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN "withholdingAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "adjustmentLabel" TEXT,
  ADD COLUMN "adjustment" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- Line discount: percent-or-amount, with the resolved rupee figure stored alongside.
ALTER TABLE "trade_document_lines"
  ADD COLUMN "discountMode" "DiscountMode" NOT NULL DEFAULT 'PERCENT',
  ADD COLUMN "discountValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "discountAmount" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- Carry existing percentage discounts across, and derive the rupee amount they worked out to.
UPDATE "trade_document_lines"
SET "discountValue" = "discountPercent",
    "discountAmount" = ROUND(("quantity" * "unitPrice") * ("discountPercent" / 100.0), 2)
WHERE "discountPercent" <> 0;

ALTER TABLE "trade_document_lines" DROP COLUMN "discountPercent";

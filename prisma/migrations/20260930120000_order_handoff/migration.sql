-- CreateEnum
CREATE TYPE "PurchaseRelease" AS ENUM ('HELD', 'SCHEDULED', 'RELEASED');

-- CreateEnum
CREATE TYPE "VendorPoCancel" AS ENUM ('PENDING', 'CANCELLED', 'NOT_NEEDED');

-- CreateEnum
CREATE TYPE "OrderPriceEvent" AS ENUM ('QUOTED', 'PURCHASED', 'INCREASE_REQUESTED', 'INCREASE_ACCEPTED', 'SENT_BACK');

-- AlterTable
ALTER TABLE "company_products" ADD COLUMN     "bookedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledById" TEXT,
ADD COLUMN     "pendingPurchasePrice" DECIMAL(12,2),
ADD COLUMN     "pendingVendorId" TEXT,
ADD COLUMN     "priceIncreaseReason" TEXT,
ADD COLUMN     "priceReviewRequestedAt" TIMESTAMP(3),
ADD COLUMN     "priceReviewRequestedById" TEXT,
ADD COLUMN     "purchaseRelease" "PurchaseRelease" NOT NULL DEFAULT 'RELEASED',
ADD COLUMN     "quoteContact" TEXT,
ADD COLUMN     "quoteRemarks" TEXT,
ADD COLUMN     "quoteVendorId" TEXT,
ADD COLUMN     "quoteVendorName" TEXT,
ADD COLUMN     "quotedById" TEXT,
ADD COLUMN     "quotedOn" DATE,
ADD COLUMN     "quotedPurchasePrice" DECIMAL(12,2),
ADD COLUMN     "releaseOn" DATE,
ADD COLUMN     "releasedAt" TIMESTAMP(3),
ADD COLUMN     "releasedById" TEXT,
ADD COLUMN     "vendorPoCancel" "VendorPoCancel",
ADD COLUMN     "vendorPoSettledAt" TIMESTAMP(3),
ADD COLUMN     "vendorPoSettledById" TEXT;

-- CreateTable
CREATE TABLE "order_price_changes" (
    "id" TEXT NOT NULL,
    "companyProductId" TEXT NOT NULL,
    "event" "OrderPriceEvent" NOT NULL,
    "fromPrice" DECIMAL(12,2),
    "toPrice" DECIMAL(12,2),
    "vendorId" TEXT,
    "reason" TEXT,
    "byUserId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_price_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_savings" (
    "id" TEXT NOT NULL,
    "companyProductId" TEXT NOT NULL,
    "purchaserId" TEXT NOT NULL,
    "quotedPrice" DECIMAL(12,2) NOT NULL,
    "actualPrice" DECIMAL(12,2) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedOn" DATE NOT NULL,
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "purchase_savings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_price_changes_companyProductId_at_idx" ON "order_price_changes"("companyProductId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_savings_companyProductId_key" ON "purchase_savings"("companyProductId");

-- CreateIndex
CREATE INDEX "purchase_savings_purchaserId_recordedOn_idx" ON "purchase_savings"("purchaserId", "recordedOn");

-- CreateIndex
CREATE INDEX "company_products_purchaseRelease_releaseOn_idx" ON "company_products"("purchaseRelease", "releaseOn");

-- CreateIndex
CREATE INDEX "company_products_bookedAt_idx" ON "company_products"("bookedAt");

-- AddForeignKey
ALTER TABLE "company_products" ADD CONSTRAINT "company_products_releasedById_fkey" FOREIGN KEY ("releasedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_products" ADD CONSTRAINT "company_products_quoteVendorId_fkey" FOREIGN KEY ("quoteVendorId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_products" ADD CONSTRAINT "company_products_quotedById_fkey" FOREIGN KEY ("quotedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_products" ADD CONSTRAINT "company_products_pendingVendorId_fkey" FOREIGN KEY ("pendingVendorId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_products" ADD CONSTRAINT "company_products_priceReviewRequestedById_fkey" FOREIGN KEY ("priceReviewRequestedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_products" ADD CONSTRAINT "company_products_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_products" ADD CONSTRAINT "company_products_vendorPoSettledById_fkey" FOREIGN KEY ("vendorPoSettledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_price_changes" ADD CONSTRAINT "order_price_changes_companyProductId_fkey" FOREIGN KEY ("companyProductId") REFERENCES "company_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_price_changes" ADD CONSTRAINT "order_price_changes_byUserId_fkey" FOREIGN KEY ("byUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_savings" ADD CONSTRAINT "purchase_savings_companyProductId_fkey" FOREIGN KEY ("companyProductId") REFERENCES "company_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_savings" ADD CONSTRAINT "purchase_savings_purchaserId_fkey" FOREIGN KEY ("purchaserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Written by hand ─────────────────────────────────────────────────────────────────────────────────
-- Every existing order counts as booked from when it was punched, as the targets have measured it.
UPDATE "company_products" SET "bookedAt" = "createdAt";

ALTER TABLE "company_products"
  -- A scheduled go-ahead has its date; nothing else does.
  ADD CONSTRAINT "company_products_release_on_iff_scheduled" CHECK (("purchaseRelease" = 'SCHEDULED') = ("releaseOn" IS NOT NULL)),
  ADD CONSTRAINT "company_products_quoted_price_not_negative" CHECK ("quotedPurchasePrice" IS NULL OR "quotedPurchasePrice" >= 0),
  ADD CONSTRAINT "company_products_pending_price_not_negative" CHECK ("pendingPurchasePrice" IS NULL OR "pendingPurchasePrice" >= 0),
  -- A price review is a price, a reason and a time together, or nothing.
  ADD CONSTRAINT "company_products_price_review_together" CHECK (
    ("pendingPurchasePrice" IS NULL) = ("priceIncreaseReason" IS NULL) AND
    ("pendingPurchasePrice" IS NULL) = ("priceReviewRequestedAt" IS NULL)
  ),
  -- The vendor PO's fate is only a question for a cancelled order.
  ADD CONSTRAINT "company_products_vendor_po_only_when_cancelled" CHECK ("vendorPoCancel" IS NULL OR "cancelledAt" IS NOT NULL);

ALTER TABLE "purchase_savings"
  ADD CONSTRAINT "purchase_savings_quantity_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "purchase_savings_prices_not_negative" CHECK ("quotedPrice" >= 0 AND "actualPrice" >= 0);

ALTER TABLE "order_price_changes"
  ADD CONSTRAINT "order_price_changes_prices_not_negative" CHECK (("fromPrice" IS NULL OR "fromPrice" >= 0) AND ("toPrice" IS NULL OR "toPrice" >= 0));

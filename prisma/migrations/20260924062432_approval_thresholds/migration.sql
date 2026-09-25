-- AlterTable
ALTER TABLE "document_approval_policies" ADD COLUMN     "maxDiscountPercent" DECIMAL(5,2),
ADD COLUMN     "minValue" DECIMAL(14,2);

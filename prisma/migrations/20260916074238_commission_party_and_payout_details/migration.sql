-- AlterEnum
ALTER TYPE "CompanyRelationshipType" ADD VALUE 'COMMISSION_PARTY';

-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "bankAccountName" TEXT,
ADD COLUMN     "bankAccountNumber" TEXT,
ADD COLUMN     "bankIfsc" TEXT,
ADD COLUMN     "bankName" TEXT,
ADD COLUMN     "panNumber" TEXT;

-- AlterTable
ALTER TABLE "order_expenses" ADD COLUMN     "payeeCompanyId" TEXT;

-- CreateIndex
CREATE INDEX "order_expenses_payeeCompanyId_idx" ON "order_expenses"("payeeCompanyId");

-- AddForeignKey
ALTER TABLE "order_expenses" ADD CONSTRAINT "order_expenses_payeeCompanyId_fkey" FOREIGN KEY ("payeeCompanyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "CreditRating" AS ENUM ('RELIABLE', 'FAIR', 'RISKY', 'NEW');

-- CreateEnum
CREATE TYPE "CreditDecisionKind" AS ENUM ('TERMS', 'LIMIT', 'ORDER');

-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "creditLimit" DECIMAL(14,2),
ADD COLUMN     "creditRating" "CreditRating",
ADD COLUMN     "creditScore" INTEGER,
ADD COLUMN     "creditScoredAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "credit_decisions" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "orderId" TEXT,
    "kind" "CreditDecisionKind" NOT NULL,
    "detail" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "rating" "CreditRating" NOT NULL,
    "score" INTEGER,
    "decidedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "credit_decisions_companyId_createdAt_idx" ON "credit_decisions"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "credit_decisions_orderId_idx" ON "credit_decisions"("orderId");

-- CreateIndex
CREATE INDEX "companies_creditRating_idx" ON "companies"("creditRating");

-- AddForeignKey
ALTER TABLE "credit_decisions" ADD CONSTRAINT "credit_decisions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_decisions" ADD CONSTRAINT "credit_decisions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "company_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_decisions" ADD CONSTRAINT "credit_decisions_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

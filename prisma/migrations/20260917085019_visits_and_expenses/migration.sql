-- CreateEnum
CREATE TYPE "VisitPurpose" AS ENUM ('INTRO_MEETING', 'REQUIREMENT_GATHERING', 'PRODUCT_DEMO', 'PROPOSAL_DISCUSSION', 'NEGOTIATION', 'ORDER_COLLECTION', 'PAYMENT_FOLLOW_UP', 'SUPPORT_ESCALATION', 'RELATIONSHIP_BUILDING', 'DELIVERY_INSTALLATION', 'OTHER');

-- CreateEnum
CREATE TYPE "VisitStatus" AS ENUM ('PLANNED', 'CHECKED_IN', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "ExpenseCategory" AS ENUM ('TRAVEL', 'FUEL', 'MILEAGE', 'TOLL_PARKING', 'ACCOMMODATION', 'MEALS', 'CLIENT_ENTERTAINMENT', 'COURIER', 'PHONE_INTERNET', 'OFFICE_SUPPLIES', 'SOFTWARE_SUBSCRIPTION', 'MARKETING', 'TRAINING', 'REPAIRS_MAINTENANCE', 'PROFESSIONAL_FEES', 'OTHER');

-- CreateEnum
CREATE TYPE "ExpensePaymentMode" AS ENUM ('CASH', 'PERSONAL_CARD', 'COMPANY_CARD', 'UPI', 'BANK_TRANSFER');

-- CreateEnum
CREATE TYPE "ExpenseStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'REIMBURSED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'VISIT_SCHEDULED';
ALTER TYPE "NotificationType" ADD VALUE 'EXPENSE_SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE 'EXPENSE_DECIDED';
ALTER TYPE "NotificationType" ADD VALUE 'EXPENSE_REIMBURSED';

-- CreateTable
CREATE TABLE "visits" (
    "id" TEXT NOT NULL,
    "visitSeq" SERIAL NOT NULL,
    "companyId" TEXT NOT NULL,
    "contactId" TEXT,
    "leadId" TEXT,
    "locationId" TEXT,
    "purpose" "VisitPurpose" NOT NULL DEFAULT 'INTRO_MEETING',
    "status" "VisitStatus" NOT NULL DEFAULT 'PLANNED',
    "agenda" TEXT,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "checkInAt" TIMESTAMP(3),
    "checkOutAt" TIMESTAMP(3),
    "address" TEXT,
    "outcome" TEXT,
    "distanceKm" DECIMAL(8,2),
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "visits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" TEXT NOT NULL,
    "expenseSeq" SERIAL NOT NULL,
    "category" "ExpenseCategory" NOT NULL DEFAULT 'TRAVEL',
    "amount" DECIMAL(12,2) NOT NULL,
    "taxAmount" DECIMAL(12,2),
    "spentOn" TIMESTAMP(3) NOT NULL,
    "description" TEXT NOT NULL,
    "paymentMode" "ExpensePaymentMode" NOT NULL DEFAULT 'CASH',
    "reimbursable" BOOLEAN NOT NULL DEFAULT true,
    "visitId" TEXT,
    "companyId" TEXT,
    "leadId" TEXT,
    "receiptDataUrl" TEXT,
    "receiptName" TEXT,
    "status" "ExpenseStatus" NOT NULL DEFAULT 'DRAFT',
    "userId" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "approverUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "reimbursedAt" TIMESTAMP(3),
    "reimbursementRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "visits_visitSeq_key" ON "visits"("visitSeq");

-- CreateIndex
CREATE INDEX "visits_companyId_idx" ON "visits"("companyId");

-- CreateIndex
CREATE INDEX "visits_userId_scheduledFor_idx" ON "visits"("userId", "scheduledFor");

-- CreateIndex
CREATE INDEX "visits_status_scheduledFor_idx" ON "visits"("status", "scheduledFor");

-- CreateIndex
CREATE UNIQUE INDEX "expenses_expenseSeq_key" ON "expenses"("expenseSeq");

-- CreateIndex
CREATE INDEX "expenses_userId_status_idx" ON "expenses"("userId", "status");

-- CreateIndex
CREATE INDEX "expenses_approverUserId_status_idx" ON "expenses"("approverUserId", "status");

-- CreateIndex
CREATE INDEX "expenses_status_spentOn_idx" ON "expenses"("status", "spentOn");

-- CreateIndex
CREATE INDEX "expenses_visitId_idx" ON "expenses"("visitId");

-- CreateIndex
CREATE INDEX "expenses_companyId_idx" ON "expenses"("companyId");

-- AddForeignKey
ALTER TABLE "visits" ADD CONSTRAINT "visits_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visits" ADD CONSTRAINT "visits_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visits" ADD CONSTRAINT "visits_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visits" ADD CONSTRAINT "visits_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "company_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visits" ADD CONSTRAINT "visits_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "visits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_approverUserId_fkey" FOREIGN KEY ("approverUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

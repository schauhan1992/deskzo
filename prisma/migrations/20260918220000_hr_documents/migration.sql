-- CreateEnum
CREATE TYPE "EmployeeDocumentType" AS ENUM ('CV', 'PHOTO', 'PAN_CARD', 'AADHAAR', 'EDUCATION', 'EXPERIENCE_CERTIFICATE', 'RELIEVING_LETTER', 'PAYSLIP_PREVIOUS', 'BANK_PROOF', 'OFFER_LETTER', 'APPOINTMENT_LETTER', 'CONTRACT', 'INTERNAL', 'OTHER');

-- CreateEnum
CREATE TYPE "LetterType" AS ENUM ('OFFER', 'APPOINTMENT', 'CONFIRMATION', 'EXPERIENCE', 'RELIEVING', 'SALARY_CERTIFICATE', 'ADDRESS_PROOF');

-- CreateEnum
CREATE TYPE "LetterStatus" AS ENUM ('DRAFT', 'ISSUED', 'REVOKED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'BIRTHDAY_TODAY';
ALTER TYPE "NotificationType" ADD VALUE 'WORK_ANNIVERSARY';
ALTER TYPE "NotificationType" ADD VALUE 'HOLIDAY_UPCOMING';
ALTER TYPE "NotificationType" ADD VALUE 'LETTER_ISSUED';

-- CreateTable
CREATE TABLE "employee_documents" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "EmployeeDocumentType" NOT NULL DEFAULT 'OTHER',
    "name" TEXT NOT NULL,
    "note" TEXT,
    "fileDataUrl" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "visibleToEmployee" BOOLEAN NOT NULL DEFAULT true,
    "letterId" TEXT,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employment_history" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "designation" TEXT,
    "location" TEXT,
    "fromDate" DATE,
    "toDate" DATE,
    "lastDrawnCtc" DECIMAL(12,2),
    "reasonForLeaving" TEXT,
    "referenceName" TEXT,
    "referenceContact" TEXT,
    "note" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verifiedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employment_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_letters" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "LetterType" NOT NULL,
    "letterNumber" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "issuedOn" DATE NOT NULL,
    "payload" JSONB NOT NULL,
    "body" TEXT NOT NULL,
    "status" "LetterStatus" NOT NULL DEFAULT 'DRAFT',
    "issuedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_letters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "employee_documents_letterId_key" ON "employee_documents"("letterId");

-- CreateIndex
CREATE INDEX "employee_documents_userId_type_idx" ON "employee_documents"("userId", "type");

-- CreateIndex
CREATE INDEX "employment_history_userId_idx" ON "employment_history"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "employee_letters_letterNumber_key" ON "employee_letters"("letterNumber");

-- CreateIndex
CREATE INDEX "employee_letters_userId_type_idx" ON "employee_letters"("userId", "type");

-- AddForeignKey
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_letterId_fkey" FOREIGN KEY ("letterId") REFERENCES "employee_letters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employment_history" ADD CONSTRAINT "employment_history_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employment_history" ADD CONSTRAINT "employment_history_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_letters" ADD CONSTRAINT "employee_letters_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_letters" ADD CONSTRAINT "employee_letters_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


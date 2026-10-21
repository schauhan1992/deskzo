-- The file manager (owner, 21 Oct 2026): every employee's payslips, letters and documents in one place, an
-- admin turning each on or off for the person it belongs to, and a letter of intent among the letters.
ALTER TYPE "LetterType" ADD VALUE IF NOT EXISTS 'LETTER_OF_INTENT' BEFORE 'OFFER';

CREATE TYPE "EmployeeFileKind" AS ENUM ('PAYSLIP', 'LETTER');

-- No row is shown, as every payslip and letter always was; a row with "hidden" keeps it from its owner.
CREATE TABLE "employee_file_visibility" (
    "kind" "EmployeeFileKind" NOT NULL,
    "refId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "hidden" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "employee_file_visibility_pkey" PRIMARY KEY ("kind","refId")
);

CREATE INDEX "employee_file_visibility_userId_idx" ON "employee_file_visibility"("userId");

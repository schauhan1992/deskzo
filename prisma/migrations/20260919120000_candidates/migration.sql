-- CreateEnum
CREATE TYPE "CandidateStatus" AS ENUM ('PROSPECT', 'OFFERED', 'ACCEPTED', 'DECLINED', 'JOINED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "HrStage" AS ENUM ('ONBOARDING', 'OFFBOARDING');

-- AlterTable
ALTER TABLE "employee_documents" ADD COLUMN     "candidateId" TEXT,
ALTER COLUMN "userId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "employee_letters" ADD COLUMN     "candidateId" TEXT,
ALTER COLUMN "userId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "aboutUserId" TEXT,
ADD COLUMN     "hrStage" "HrStage";

-- CreateTable
CREATE TABLE "candidates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "designation" TEXT,
    "departmentId" TEXT,
    "employmentType" "EmploymentType" NOT NULL DEFAULT 'FULL_TIME',
    "workLocation" TEXT,
    "managerId" TEXT,
    "role" "Role" NOT NULL DEFAULT 'SALES',
    "status" "CandidateStatus" NOT NULL DEFAULT 'PROSPECT',
    "source" TEXT,
    "offeredCtc" DECIMAL(12,2),
    "expectedJoining" DATE,
    "offeredOn" DATE,
    "acceptedOn" DATE,
    "declinedReason" TEXT,
    "notes" TEXT,
    "intakeToken" TEXT,
    "intakeExpiresAt" TIMESTAMP(3),
    "intakeSubmittedAt" TIMESTAMP(3),
    "intakeData" JSONB,
    "convertedUserId" TEXT,
    "convertedAt" TIMESTAMP(3),
    "ownerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "candidates_intakeToken_key" ON "candidates"("intakeToken");

-- CreateIndex
CREATE UNIQUE INDEX "candidates_convertedUserId_key" ON "candidates"("convertedUserId");

-- CreateIndex
CREATE INDEX "candidates_status_idx" ON "candidates"("status");

-- CreateIndex
CREATE INDEX "candidates_email_idx" ON "candidates"("email");

-- CreateIndex
CREATE INDEX "employee_documents_candidateId_idx" ON "employee_documents"("candidateId");

-- CreateIndex
CREATE INDEX "employee_letters_candidateId_idx" ON "employee_letters"("candidateId");

-- CreateIndex
CREATE INDEX "tasks_aboutUserId_hrStage_idx" ON "tasks"("aboutUserId", "hrStage");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_aboutUserId_fkey" FOREIGN KEY ("aboutUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_letters" ADD CONSTRAINT "employee_letters_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_convertedUserId_fkey" FOREIGN KEY ("convertedUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


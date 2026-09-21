-- CreateEnum
CREATE TYPE "EmploymentType" AS ENUM ('FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN', 'CONSULTANT');

-- CreateEnum
CREATE TYPE "ExitType" AS ENUM ('RESIGNED', 'TERMINATED', 'RETIRED', 'CONTRACT_ENDED', 'ABSCONDED');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('FEMALE', 'MALE', 'OTHER', 'UNDISCLOSED');

-- CreateEnum
CREATE TYPE "LeaveAccrual" AS ENUM ('ANNUAL', 'MONTHLY');

-- CreateEnum
CREATE TYPE "LeaveStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'WORK_FROM_HOME', 'HALF_DAY', 'ON_LEAVE', 'ABSENT', 'WEEK_OFF', 'HOLIDAY');

-- CreateEnum
CREATE TYPE "PayrollRunStatus" AS ENUM ('DRAFT', 'LOCKED', 'PAID');

-- CreateTable
CREATE TABLE "employee_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "employeeCode" TEXT,
    "designation" TEXT,
    "employmentType" "EmploymentType" NOT NULL DEFAULT 'FULL_TIME',
    "workLocation" TEXT,
    "joinedOn" DATE,
    "probationEndsOn" DATE,
    "confirmedOn" DATE,
    "exitedOn" DATE,
    "exitType" "ExitType",
    "exitReason" TEXT,
    "dateOfBirth" DATE,
    "gender" "Gender",
    "bloodGroup" TEXT,
    "maritalStatus" TEXT,
    "personalEmail" TEXT,
    "personalPhone" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "pincode" TEXT,
    "emergencyContactName" TEXT,
    "emergencyContactPhone" TEXT,
    "emergencyContactRelation" TEXT,
    "panNumber" TEXT,
    "aadhaarLast4" TEXT,
    "uanNumber" TEXT,
    "pfNumber" TEXT,
    "esicNumber" TEXT,
    "bankName" TEXT,
    "bankAccountNumber" TEXT,
    "bankIfsc" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holidays" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "optional" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_types" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "annualQuota" DECIMAL(5,2) NOT NULL,
    "accrual" "LeaveAccrual" NOT NULL DEFAULT 'ANNUAL',
    "carryForward" BOOLEAN NOT NULL DEFAULT false,
    "maxCarryForward" DECIMAL(5,2),
    "paid" BOOLEAN NOT NULL DEFAULT true,
    "proofAfterDays" INTEGER,
    "colour" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leave_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_balances" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "typeId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "opening" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "credited" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "used" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "adjustment" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "adjustmentNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leave_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_requests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "typeId" TEXT NOT NULL,
    "fromDate" DATE NOT NULL,
    "toDate" DATE NOT NULL,
    "fromHalfDay" BOOLEAN NOT NULL DEFAULT false,
    "toHalfDay" BOOLEAN NOT NULL DEFAULT false,
    "days" DECIMAL(5,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "LeaveStatus" NOT NULL DEFAULT 'PENDING',
    "approverId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_days" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "status" "AttendanceStatus" NOT NULL,
    "checkInAt" TIMESTAMP(3),
    "checkOutAt" TIMESTAMP(3),
    "workedMinutes" INTEGER,
    "note" TEXT,
    "leaveRequestId" TEXT,
    "regularisedById" TEXT,
    "regularisedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_structures" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "basic" DECIMAL(12,2) NOT NULL,
    "hra" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "conveyance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "medical" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "specialAllowance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "otherAllowance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "pfApplicable" BOOLEAN NOT NULL DEFAULT true,
    "esiApplicable" BOOLEAN NOT NULL DEFAULT true,
    "ptApplicable" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salary_structures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_runs" (
    "id" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "status" "PayrollRunStatus" NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "lockedAt" TIMESTAMP(3),
    "lockedById" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslips" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "monthDays" DECIMAL(5,2) NOT NULL,
    "paidDays" DECIMAL(5,2) NOT NULL,
    "lopDays" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "basic" DECIMAL(12,2) NOT NULL,
    "hra" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "conveyance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "medical" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "specialAllowance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "otherAllowance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "grossEarnings" DECIMAL(12,2) NOT NULL,
    "pfEmployee" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "pfEmployer" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "esiEmployee" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "esiEmployer" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "professionalTax" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "incomeTax" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "otherDeduction" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "otherDeductionNote" TEXT,
    "totalDeductions" DECIMAL(12,2) NOT NULL,
    "netPay" DECIMAL(12,2) NOT NULL,
    "employerCost" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payslips_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "employee_profiles_userId_key" ON "employee_profiles"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "employee_profiles_employeeCode_key" ON "employee_profiles"("employeeCode");

-- CreateIndex
CREATE INDEX "employee_profiles_employmentType_idx" ON "employee_profiles"("employmentType");

-- CreateIndex
CREATE INDEX "holidays_date_idx" ON "holidays"("date");

-- CreateIndex
CREATE UNIQUE INDEX "holidays_date_name_key" ON "holidays"("date", "name");

-- CreateIndex
CREATE UNIQUE INDEX "leave_types_code_key" ON "leave_types"("code");

-- CreateIndex
CREATE INDEX "leave_balances_userId_year_idx" ON "leave_balances"("userId", "year");

-- CreateIndex
CREATE UNIQUE INDEX "leave_balances_userId_typeId_year_key" ON "leave_balances"("userId", "typeId", "year");

-- CreateIndex
CREATE INDEX "leave_requests_userId_fromDate_idx" ON "leave_requests"("userId", "fromDate");

-- CreateIndex
CREATE INDEX "leave_requests_status_idx" ON "leave_requests"("status");

-- CreateIndex
CREATE INDEX "leave_requests_approverId_status_idx" ON "leave_requests"("approverId", "status");

-- CreateIndex
CREATE INDEX "attendance_days_date_idx" ON "attendance_days"("date");

-- CreateIndex
CREATE INDEX "attendance_days_userId_date_idx" ON "attendance_days"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_days_userId_date_key" ON "attendance_days"("userId", "date");

-- CreateIndex
CREATE INDEX "salary_structures_userId_effectiveFrom_idx" ON "salary_structures"("userId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_month_year_key" ON "payroll_runs"("month", "year");

-- CreateIndex
CREATE INDEX "payslips_userId_idx" ON "payslips"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "payslips_runId_userId_key" ON "payslips"("runId", "userId");

-- AddForeignKey
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "leave_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "leave_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_days_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_days_regularisedById_fkey" FOREIGN KEY ("regularisedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_structures" ADD CONSTRAINT "salary_structures_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_structures" ADD CONSTRAINT "salary_structures_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_lockedById_fkey" FOREIGN KEY ("lockedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_runId_fkey" FOREIGN KEY ("runId") REFERENCES "payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


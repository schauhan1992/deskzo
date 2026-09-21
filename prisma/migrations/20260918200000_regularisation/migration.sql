-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'REGULARISATION_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE 'REGULARISATION_DECIDED';

-- CreateTable
CREATE TABLE "attendance_regularisations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "requestedStatus" "AttendanceStatus" NOT NULL,
    "requestedCheckIn" TIMESTAMP(3),
    "requestedCheckOut" TIMESTAMP(3),
    "reason" TEXT NOT NULL,
    "status" "LeaveStatus" NOT NULL DEFAULT 'PENDING',
    "approverId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_regularisations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attendance_regularisations_userId_date_idx" ON "attendance_regularisations"("userId", "date");

-- CreateIndex
CREATE INDEX "attendance_regularisations_status_idx" ON "attendance_regularisations"("status");

-- CreateIndex
CREATE INDEX "attendance_regularisations_approverId_status_idx" ON "attendance_regularisations"("approverId", "status");

-- AddForeignKey
ALTER TABLE "attendance_regularisations" ADD CONSTRAINT "attendance_regularisations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_regularisations" ADD CONSTRAINT "attendance_regularisations_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


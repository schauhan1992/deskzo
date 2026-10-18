-- Short leave (owner, 18 Oct 2026): a couple of hours off on one working day, approved like leave, a few a
-- month; and the company's limits for it (2 hours, 2 a month until whoever manages HR changes them).

-- CreateTable
CREATE TABLE "short_leave_requests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "fromMinute" INTEGER NOT NULL,
    "toMinute" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "LeaveStatus" NOT NULL DEFAULT 'PENDING',
    "approverId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "short_leave_requests_pkey" PRIMARY KEY ("id"),
    -- A span inside one day, of a positive length.
    CONSTRAINT "short_leave_requests_minutes_check" CHECK ("fromMinute" >= 0 AND "toMinute" <= 1440 AND "toMinute" > "fromMinute")
);

-- CreateTable
CREATE TABLE "short_leave_policy" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "maxMinutes" INTEGER NOT NULL DEFAULT 120,
    "perMonth" INTEGER NOT NULL DEFAULT 2,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "short_leave_policy_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "short_leave_policy_limits_check" CHECK ("maxMinutes" BETWEEN 15 AND 480 AND "perMonth" BETWEEN 0 AND 31)
);

-- CreateIndex
CREATE INDEX "short_leave_requests_userId_date_idx" ON "short_leave_requests"("userId", "date");

-- CreateIndex
CREATE INDEX "short_leave_requests_status_idx" ON "short_leave_requests"("status");

-- CreateIndex
CREATE INDEX "short_leave_requests_approverId_status_idx" ON "short_leave_requests"("approverId", "status");

-- AddForeignKey
ALTER TABLE "short_leave_requests" ADD CONSTRAINT "short_leave_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "short_leave_requests" ADD CONSTRAINT "short_leave_requests_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

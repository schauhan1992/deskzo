-- The company's office hours (owner, 16 Oct 2026): what the attendance grid measures Late, Early and
-- Overtime against. One row, id "global"; none means not set.

-- CreateTable
CREATE TABLE "attendance_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "graceMinutes" INTEGER NOT NULL DEFAULT 15,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_settings_pkey" PRIMARY KEY ("id")
);

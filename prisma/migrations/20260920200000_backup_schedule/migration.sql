-- CreateTable
CREATE TABLE "backup_schedule" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "hour" INTEGER NOT NULL DEFAULT 2,
    "minute" INTEGER NOT NULL DEFAULT 0,
    "keepDays" INTEGER,
    "keepMinimum" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "backup_schedule_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "backup_schedule" ADD CONSTRAINT "backup_schedule_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

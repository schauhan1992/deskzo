-- Deskzo Automate: the worker's wake list (src/lib/automate/wake.ts).

-- CreateTable
CREATE TABLE "automation_wake" (
    "tenantId" TEXT NOT NULL,
    "nextDueAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_wake_pkey" PRIMARY KEY ("tenantId")
);

-- CreateIndex
CREATE INDEX "automation_wake_nextDueAt_idx" ON "automation_wake"("nextDueAt");


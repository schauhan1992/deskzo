-- Deskzo Automate, Phase 7: steps counted by the month, against the plan's allowance.

-- CreateTable
CREATE TABLE "automation_usage" (
    "month" DATE NOT NULL,
    "steps" INTEGER NOT NULL DEFAULT 0,
    "warned80At" TIMESTAMP(3),
    "warned100At" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_usage_pkey" PRIMARY KEY ("month")
);

-- Deskzo Automate, Phase 8: steps that reached outside Deskzo, kept where a workspace's restore can't forget them.

-- CreateTable
CREATE TABLE "automation_sent_steps" (
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_sent_steps_pkey" PRIMARY KEY ("tenantId","key")
);

-- CreateIndex
CREATE INDEX "automation_sent_steps_sentAt_idx" ON "automation_sent_steps"("sentAt");

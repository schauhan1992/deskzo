-- CreateTable
CREATE TABLE "handovers" (
    "id" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "performedById" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "handovers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "handover_lines" (
    "id" TEXT NOT NULL,
    "handoverId" TEXT NOT NULL,
    "areaKey" TEXT NOT NULL,
    "areaLabel" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "handover_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "handovers_fromUserId_idx" ON "handovers"("fromUserId");

-- CreateIndex
CREATE INDEX "handover_lines_handoverId_idx" ON "handover_lines"("handoverId");

-- CreateIndex
CREATE INDEX "handover_lines_toUserId_idx" ON "handover_lines"("toUserId");

-- AddForeignKey
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_performedById_fkey" FOREIGN KEY ("performedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handover_lines" ADD CONSTRAINT "handover_lines_handoverId_fkey" FOREIGN KEY ("handoverId") REFERENCES "handovers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handover_lines" ADD CONSTRAINT "handover_lines_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

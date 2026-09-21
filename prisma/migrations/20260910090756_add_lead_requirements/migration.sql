-- CreateTable
CREATE TABLE "lead_requirements" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lead_requirements_leadId_idx" ON "lead_requirements"("leadId");

-- CreateIndex
CREATE INDEX "lead_requirements_itemId_idx" ON "lead_requirements"("itemId");

-- AddForeignKey
ALTER TABLE "lead_requirements" ADD CONSTRAINT "lead_requirements_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_requirements" ADD CONSTRAINT "lead_requirements_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

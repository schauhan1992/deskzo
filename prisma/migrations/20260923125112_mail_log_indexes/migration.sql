-- CreateIndex
CREATE INDEX "marketing_messages_companyId_createdAt_idx" ON "marketing_messages"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "marketing_messages_createdAt_idx" ON "marketing_messages"("createdAt");

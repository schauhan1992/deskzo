-- Deskzo Automate, Phase 4: a webhook call found again by its Idempotency-Key, without reading a day of events.

-- CreateIndex
CREATE INDEX "automation_events_type_recordId_idx" ON "automation_events"("type", "recordId");

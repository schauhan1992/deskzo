-- Indexes on every column a report can put a date window on.
--
-- The Reports page bounds its query on whichever "Dated on" field is chosen, so each of these is a
-- range scan on every report, filter-panel open, export and printed sheet. Without a leading index
-- each is a sequential scan of the whole table.
--
-- `visits.scheduledFor` and `trade_documents.issueDate` were already the second key of a composite
-- index — `(status, scheduledFor)` and `(direction, issueDate)` — which cannot serve a window on the
-- date alone. That is why there are nine here rather than the three a reading of the schema suggests.
CREATE INDEX "leads_createdAt_idx" ON "leads"("createdAt");
CREATE INDEX "tickets_createdAt_idx" ON "tickets"("createdAt");
CREATE INDEX "tickets_resolvedAt_idx" ON "tickets"("resolvedAt");
CREATE INDEX "payments_paidOn_idx" ON "payments"("paidOn");
CREATE INDEX "company_products_startDate_idx" ON "company_products"("startDate");
CREATE INDEX "trade_documents_issueDate_idx" ON "trade_documents"("issueDate");
CREATE INDEX "trade_documents_dueDate_idx" ON "trade_documents"("dueDate");
CREATE INDEX "visits_scheduledFor_idx" ON "visits"("scheduledFor");
CREATE INDEX "visits_checkInAt_idx" ON "visits"("checkInAt");

-- Activity on records (19 Oct 2026): each change linked to the customer or vendor, and the lead, it belongs to,
-- and what an edit changed, field by field.
ALTER TABLE "audit_logs" ADD COLUMN "companyId" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "leadId" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "changes" JSONB;

CREATE INDEX "audit_logs_companyId_createdAt_idx" ON "audit_logs"("companyId", "createdAt");
CREATE INDEX "audit_logs_leadId_createdAt_idx" ON "audit_logs"("leadId", "createdAt");

-- The changes already recorded, linked the same way as new ones (src/lib/activity/subjects.ts — the owner chose
-- to include the past). Only rows whose record is still there can be placed, as at write time.
UPDATE "audit_logs" a SET "companyId" = a."entityId" WHERE a."entityType" IN ('Company', 'DomainProfile');
UPDATE "audit_logs" a SET "companyId" = r."companyId", "leadId" = r."id" FROM "leads" r WHERE a."entityType" = 'Lead' AND r."id" = a."entityId";
UPDATE "audit_logs" a SET "companyId" = r."companyId" FROM "contacts" r WHERE a."entityType" IN ('Contact', 'ContactConsent') AND r."id" = a."entityId";
UPDATE "audit_logs" a SET "companyId" = r."companyId" FROM "company_bank_accounts" r WHERE a."entityType" = 'CompanyBankAccount' AND r."id" = a."entityId";
UPDATE "audit_logs" a SET "companyId" = r."companyId" FROM "company_products" r WHERE a."entityType" IN ('Order', 'CompanyProduct') AND r."id" = a."entityId";
UPDATE "audit_logs" a SET "companyId" = p."companyId" FROM "order_rebates" r JOIN "company_products" p ON p."id" = r."companyProductId" WHERE a."entityType" = 'OrderRebate' AND r."id" = a."entityId";
UPDATE "audit_logs" a SET "companyId" = r."companyId", "leadId" = r."leadId" FROM "trade_documents" r WHERE a."entityType" = 'TradeDocument' AND r."id" = a."entityId";
UPDATE "audit_logs" a SET "companyId" = d."companyId", "leadId" = d."leadId" FROM "eway_bills" r JOIN "trade_documents" d ON d."id" = r."documentId" WHERE a."entityType" = 'EwayBill' AND r."id" = a."entityId";
UPDATE "audit_logs" a SET "companyId" = d."companyId", "leadId" = d."leadId" FROM "consignments" r JOIN "trade_documents" d ON d."id" = r."documentId" WHERE a."entityType" = 'Consignment' AND r."id" = a."entityId";
UPDATE "audit_logs" a SET "companyId" = r."companyId" FROM "payments" r WHERE a."entityType" = 'Payment' AND r."id" = a."entityId";
UPDATE "audit_logs" a SET "companyId" = r."companyId" FROM "payment_follow_ups" r WHERE a."entityType" = 'PaymentFollowUp' AND r."id" = a."entityId";
UPDATE "audit_logs" a SET "companyId" = r."companyId" FROM "tickets" r WHERE a."entityType" = 'Ticket' AND r."id" = a."entityId";
UPDATE "audit_logs" a SET "companyId" = r."companyId", "leadId" = r."leadId" FROM "tasks" r WHERE a."entityType" = 'Task' AND r."id" = a."entityId";
UPDATE "audit_logs" a SET "companyId" = r."companyId", "leadId" = r."leadId" FROM "calendar_events" r WHERE a."entityType" = 'CalendarEvent' AND r."id" = a."entityId";
UPDATE "audit_logs" a SET "companyId" = r."companyId", "leadId" = r."leadId" FROM "visits" r WHERE a."entityType" = 'Visit' AND r."id" = a."entityId";
UPDATE "audit_logs" a SET "companyId" = r."companyId", "leadId" = r."leadId" FROM "call_logs" r WHERE a."entityType" = 'CallLog' AND r."id" = a."entityId";
UPDATE "audit_logs" a SET "companyId" = r."companyId", "leadId" = r."leadId" FROM "bookings" r WHERE a."entityType" = 'Booking' AND r."id" = a."entityId";
UPDATE "audit_logs" a SET "companyId" = r."companyId", "leadId" = r."leadId" FROM "expenses" r WHERE a."entityType" = 'Expense' AND r."id" = a."entityId";
UPDATE "audit_logs" a SET "companyId" = r."companyId" FROM "projects" r WHERE a."entityType" = 'Project' AND r."id" = a."entityId";
UPDATE "audit_logs" a SET "companyId" = p."companyId" FROM "project_documents" r JOIN "projects" p ON p."id" = r."projectId" WHERE a."entityType" = 'ProjectDocument' AND r."id" = a."entityId";
UPDATE "audit_logs" a SET "companyId" = p."companyId" FROM "project_billing_milestones" r JOIN "projects" p ON p."id" = r."projectId" WHERE a."entityType" = 'ProjectBillingMilestone' AND r."id" = a."entityId";
UPDATE "audit_logs" a SET "companyId" = r."vendorId" FROM "vendor_credits" r WHERE a."entityType" = 'VendorCredit' AND r."id" = a."entityId";
UPDATE "audit_logs" a SET "companyId" = r."vendorId" FROM "vendor_statements" r WHERE a."entityType" = 'VendorStatement' AND r."id" = a."entityId";
UPDATE "audit_logs" a SET "companyId" = r."companyId" FROM "feedback_requests" r WHERE a."entityType" = 'FeedbackRequest' AND r."id" = a."entityId";
UPDATE "audit_logs" a SET "companyId" = r."companyId" FROM "portal_logins" r WHERE a."entityType" = 'PortalLogin' AND r."id" = a."entityId";

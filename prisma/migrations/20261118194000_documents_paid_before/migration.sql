-- What an invoice, bill or credit note brought from the old system had already settled there (owner,
-- 18 Oct 2026), so its balance due is what was left. Zero on everything raised in Deskzo.
ALTER TABLE "trade_documents" ADD COLUMN "paidBefore" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "trade_documents" ADD CONSTRAINT "trade_documents_paid_before_check" CHECK ("paidBefore" >= 0);

-- Debit notes (owner, 23 Oct 2026): a sales document that adds to an issued invoice — interest on late payment
-- (src/lib/collect/msme.ts), a price revised upward, short billing — posted and owed like an invoice.
ALTER TYPE "TradeDocumentType" ADD VALUE 'DEBIT_NOTE';
ALTER TYPE "JournalSource" ADD VALUE 'DEBIT_NOTE';

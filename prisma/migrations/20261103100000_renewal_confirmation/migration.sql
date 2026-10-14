-- A third customer notice (src/lib/marketing/customer-notices.ts): confirming a renewal, sent from a
-- renewed subscription on the renewals list. Kept on the message, as the other two are, for the mail log.
ALTER TYPE "CustomerNoticeKind" ADD VALUE IF NOT EXISTS 'RENEWED';

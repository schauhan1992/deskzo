-- Where a helpdesk's replies go out from (src/lib/support-mail/reply-from.ts).
ALTER TABLE "support_mail_settings" ADD COLUMN IF NOT EXISTS "replyFrom" TEXT NOT NULL DEFAULT 'DESKZO';
ALTER TABLE "support_mail_settings" ADD COLUMN IF NOT EXISTS "companyFrom" TEXT;

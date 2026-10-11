-- AlterTable
ALTER TABLE "signature_templates" ADD COLUMN     "replyStyle" TEXT NOT NULL DEFAULT 'FULL';

-- Written by hand: only the three styles the template editor offers.
ALTER TABLE "signature_templates" ADD CONSTRAINT "signature_templates_reply_style" CHECK ("replyStyle" IN ('FULL', 'SHORT', 'NONE'));

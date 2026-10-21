-- HR letters (owner, 21 Oct 2026): a signature image for letters, chosen letter by letter and copied onto
-- each one when it is issued; and HR's own templates for letters and official documents.
ALTER TYPE "LetterType" ADD VALUE 'CUSTOM';

ALTER TABLE "organisation_settings" ADD COLUMN "letterSignByDefault" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "letterSignatureDataUrl" TEXT;

CREATE TABLE "letter_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "letter_templates_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "employee_letters" ADD COLUMN "signatureDataUrl" TEXT,
ADD COLUMN "signed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "templateId" TEXT,
ADD COLUMN "templateName" TEXT;

ALTER TABLE "employee_letters" ADD CONSTRAINT "employee_letters_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "letter_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Every letter before today printed the invoice stamp under its signatory whenever one was set: they stay
-- signed, and with no copy of their own they go on printing the stamp as before.
UPDATE "employee_letters" SET "signed" = true;

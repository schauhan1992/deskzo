-- Several bank accounts per vendor and for the organisation, each with one primary; a vendor code prefix
-- (owner, 8 Oct 2026). Expand only: the old single-account columns on companies, organisation_settings
-- and branches are copied across below and left in place, unread, for a later release to drop.

-- AlterTable
ALTER TABLE "organisation_settings" ADD COLUMN     "vendorCodePrefix" TEXT NOT NULL DEFAULT 'VEN-';

-- AlterTable
ALTER TABLE "branches" ADD COLUMN     "defaultBankAccountId" TEXT;

-- AlterTable
ALTER TABLE "trade_documents" ADD COLUMN     "bankAccountId" TEXT;

-- CreateTable
CREATE TABLE "company_bank_accounts" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "accountHolderName" TEXT,
    "bankName" TEXT,
    "branchName" TEXT,
    "accountNumber" TEXT,
    "ifsc" TEXT,
    "swift" TEXT,
    "upiId" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organisation_bank_accounts" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "accountHolderName" TEXT,
    "bankName" TEXT,
    "branchName" TEXT,
    "accountNumber" TEXT,
    "ifsc" TEXT,
    "swift" TEXT,
    "upiId" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organisation_bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "company_bank_accounts_companyId_idx" ON "company_bank_accounts"("companyId");

-- At most one primary: per company, and for the organisation as a whole. Not expressible in the Prisma
-- schema; the actions keep it by clearing the old primary in the same transaction.
CREATE UNIQUE INDEX "company_bank_accounts_one_primary" ON "company_bank_accounts"("companyId") WHERE "isPrimary";
CREATE UNIQUE INDEX "organisation_bank_accounts_one_primary" ON "organisation_bank_accounts"((true)) WHERE "isPrimary";

-- AddForeignKey
ALTER TABLE "company_bank_accounts" ADD CONSTRAINT "company_bank_accounts_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_defaultBankAccountId_fkey" FOREIGN KEY ("defaultBankAccountId") REFERENCES "organisation_bank_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_documents" ADD CONSTRAINT "trade_documents_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "organisation_bank_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Moved across (owner: "Yes, move them across"). Blank and whitespace count as empty, as they did when
-- printed (src/lib/branches/format.ts `given`). Fixed ids, so the moves can be recognised afterwards.

-- 1. The organisation's bank block becomes its primary account.
INSERT INTO "organisation_bank_accounts" ("id", "label", "bankName", "branchName", "accountNumber", "ifsc", "upiId", "isPrimary", "active", "createdAt", "updatedAt")
SELECT 'orgbank-main', 'Main account',
       NULLIF(btrim(o."bankName"), ''), NULLIF(btrim(o."bankBranch"), ''), NULLIF(btrim(o."bankAccountNumber"), ''),
       NULLIF(upper(btrim(o."bankIfsc")), ''), NULLIF(btrim(o."upiId"), ''),
       true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "organisation_settings" o
WHERE o."id" = 'global'
  AND COALESCE(NULLIF(btrim(o."bankName"), ''), NULLIF(btrim(o."bankAccountNumber"), ''), NULLIF(btrim(o."bankIfsc"), ''),
               NULLIF(btrim(o."bankBranch"), ''), NULLIF(btrim(o."upiId"), '')) IS NOT NULL;

-- 2. A branch that printed its own account (it had an account number or a UPI id) gets that account as
--    one of the organisation's, and as its default — unless it is the organisation's own account again.
INSERT INTO "organisation_bank_accounts" ("id", "label", "bankName", "branchName", "accountNumber", "ifsc", "upiId", "isPrimary", "active", "createdAt", "updatedAt")
SELECT 'brbank-' || b."id", left(b."name", 60) || ' account',
       NULLIF(btrim(b."bankName"), ''), NULLIF(btrim(b."bankBranch"), ''), NULLIF(btrim(b."bankAccountNumber"), ''),
       NULLIF(upper(btrim(b."bankIfsc")), ''), NULLIF(btrim(b."upiId"), ''),
       false, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "branches" b
WHERE COALESCE(NULLIF(btrim(b."bankAccountNumber"), ''), NULLIF(btrim(b."upiId"), '')) IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "organisation_bank_accounts" m
    WHERE m."id" = 'orgbank-main'
      AND m."accountNumber" IS NOT DISTINCT FROM NULLIF(btrim(b."bankAccountNumber"), '')
      AND m."upiId" IS NOT DISTINCT FROM NULLIF(btrim(b."upiId"), '')
  );

UPDATE "branches" b
SET "defaultBankAccountId" = CASE
      WHEN EXISTS (SELECT 1 FROM "organisation_bank_accounts" a WHERE a."id" = 'brbank-' || b."id") THEN 'brbank-' || b."id"
      ELSE 'orgbank-main'
    END
WHERE COALESCE(NULLIF(btrim(b."bankAccountNumber"), ''), NULLIF(btrim(b."upiId"), '')) IS NOT NULL
  AND EXISTS (SELECT 1 FROM "organisation_bank_accounts" a WHERE a."id" IN ('brbank-' || b."id", 'orgbank-main'));

-- 3. Each company's single payout account becomes its primary account.
INSERT INTO "company_bank_accounts" ("id", "companyId", "label", "accountHolderName", "bankName", "accountNumber", "ifsc", "isPrimary", "createdAt", "updatedAt")
SELECT 'cba-' || c."id", c."id", 'Primary account',
       NULLIF(btrim(c."bankAccountName"), ''), NULLIF(btrim(c."bankName"), ''), NULLIF(btrim(c."bankAccountNumber"), ''),
       NULLIF(upper(btrim(c."bankIfsc")), ''),
       true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "companies" c
WHERE COALESCE(NULLIF(btrim(c."bankAccountName"), ''), NULLIF(btrim(c."bankName"), ''), NULLIF(btrim(c."bankAccountNumber"), ''),
               NULLIF(btrim(c."bankIfsc"), '')) IS NOT NULL;

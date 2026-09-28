-- Branches and GST registrations — the expand half.
--
-- One company, several places of business and several GST registrations. This release only adds:
-- new tables, and nullable columns that point at them, filled in below for everything that already
-- exists. An older build keeps working against the result — it ignores the new tables and columns, and
-- nothing is moved *out* of organisation_settings (the GSTIN and the portal credentials are copied, not
-- taken). Rows that build writes between this migration and the deploy are adopted by the new code at
-- runtime (adoptUnassigned). The next release sets branchId NOT NULL with the head office as its default.

-- CreateEnum
CREATE TYPE "DocumentSeriesScope" AS ENUM ('COMPANY', 'REGISTRATION', 'BRANCH');

-- AlterTable
ALTER TABLE "consignments" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "document_number_settings" ADD COLUMN     "scope" "DocumentSeriesScope" NOT NULL DEFAULT 'COMPANY';

-- AlterTable
ALTER TABLE "journal_lines" ADD COLUMN     "branchId" TEXT,
ADD COLUMN     "gstRegistrationId" TEXT;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "trade_documents" ADD COLUMN     "branchId" TEXT,
ADD COLUMN     "gstRegistrationId" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "branchId" TEXT;

-- CreateTable
CREATE TABLE "gst_registrations" (
    "id" TEXT NOT NULL,
    "gstin" TEXT NOT NULL,
    "stateCode" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "einvoiceProvider" TEXT,
    "einvoiceUsername" TEXT,
    "einvoicePasswordCipher" TEXT,
    "einvoiceClientId" TEXT,
    "einvoiceClientSecretCipher" TEXT,
    "ewayIntraStateThreshold" DECIMAL(12,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "gst_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branches" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "gstRegistrationId" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "pincode" TEXT,
    "country" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "bankName" TEXT,
    "bankAccountNumber" TEXT,
    "bankIfsc" TEXT,
    "bankBranch" TEXT,
    "upiId" TEXT,
    "logoDataUrl" TEXT,
    "signatureDataUrl" TEXT,
    "invoiceTerms" TEXT,
    "invoiceNotes" TEXT,
    "isHeadOffice" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_series" (
    "id" TEXT NOT NULL,
    "docType" "TradeDocumentType" NOT NULL,
    "gstRegistrationId" TEXT,
    "branchId" TEXT,
    "ownerKey" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "nextNumber" INTEGER NOT NULL DEFAULT 1,
    "padding" INTEGER NOT NULL DEFAULT 4,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_series_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gst_registrations_gstin_key" ON "gst_registrations"("gstin");

-- CreateIndex
CREATE UNIQUE INDEX "gst_registrations_code_key" ON "gst_registrations"("code");

-- CreateIndex
CREATE INDEX "gst_registrations_active_idx" ON "gst_registrations"("active");

-- CreateIndex
CREATE UNIQUE INDEX "branches_code_key" ON "branches"("code");

-- CreateIndex
CREATE INDEX "branches_active_idx" ON "branches"("active");

-- CreateIndex
CREATE INDEX "branches_gstRegistrationId_idx" ON "branches"("gstRegistrationId");

-- CreateIndex
CREATE UNIQUE INDEX "document_series_docType_ownerKey_key" ON "document_series"("docType", "ownerKey");

-- CreateIndex
CREATE INDEX "consignments_branchId_idx" ON "consignments"("branchId");

-- CreateIndex
CREATE INDEX "journal_lines_branchId_idx" ON "journal_lines"("branchId");

-- CreateIndex
CREATE INDEX "journal_lines_gstRegistrationId_idx" ON "journal_lines"("gstRegistrationId");

-- CreateIndex
CREATE INDEX "payments_branchId_idx" ON "payments"("branchId");

-- CreateIndex
CREATE INDEX "trade_documents_branchId_docType_idx" ON "trade_documents"("branchId", "docType");

-- CreateIndex
CREATE INDEX "trade_documents_gstRegistrationId_issueDate_idx" ON "trade_documents"("gstRegistrationId", "issueDate");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gst_registrations" ADD CONSTRAINT "gst_registrations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_gstRegistrationId_fkey" FOREIGN KEY ("gstRegistrationId") REFERENCES "gst_registrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_documents" ADD CONSTRAINT "trade_documents_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_documents" ADD CONSTRAINT "trade_documents_gstRegistrationId_fkey" FOREIGN KEY ("gstRegistrationId") REFERENCES "gst_registrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_series" ADD CONSTRAINT "document_series_gstRegistrationId_fkey" FOREIGN KEY ("gstRegistrationId") REFERENCES "gst_registrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_series" ADD CONSTRAINT "document_series_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_gstRegistrationId_fkey" FOREIGN KEY ("gstRegistrationId") REFERENCES "gst_registrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consignments" ADD CONSTRAINT "consignments_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Constraints Prisma cannot express ─────────────────────────────────────────
-- At most one head office. At least one is the application's job: the flag can only be moved.
CREATE UNIQUE INDEX "branches_one_head_office" ON "branches" ("isHeadOffice") WHERE "isHeadOffice";

ALTER TABLE "gst_registrations" ADD CONSTRAINT "gst_registrations_state_is_gstin_prefix"
  CHECK (length("gstin") = 15 AND "stateCode" = substr("gstin", 1, 2));

ALTER TABLE "document_series" ADD CONSTRAINT "document_series_one_owner" CHECK (
  ("gstRegistrationId" IS NOT NULL AND "branchId" IS NULL AND "ownerKey" = "gstRegistrationId")
  OR ("branchId" IS NOT NULL AND "gstRegistrationId" IS NULL AND "ownerKey" = "branchId"));

-- ── 1. Registrations ──────────────────────────────────────────────────────────
-- The organisation's GSTIN becomes the head office's registration, taking the portal connection with it.
-- INSERT … SELECT, never VALUES: check:data-reset treats INSERT … VALUES as fixed install rows.
-- The code is the vehicle-registration-style default (GST_STATE_ABBREVIATIONS, src/lib/gst-engine.ts).
INSERT INTO "gst_registrations" ("id", "gstin", "stateCode", "code", "active", "einvoiceProvider", "einvoiceUsername",
  "einvoicePasswordCipher", "einvoiceClientId", "einvoiceClientSecretCipher", "ewayIntraStateThreshold", "createdAt", "updatedAt")
SELECT 'gstreg_head_office', g, substr(g, 1, 2),
       CASE substr(g, 1, 2)
         WHEN '01' THEN 'JK' WHEN '02' THEN 'HP' WHEN '03' THEN 'PB' WHEN '04' THEN 'CH' WHEN '05' THEN 'UK'
         WHEN '06' THEN 'HR' WHEN '07' THEN 'DL' WHEN '08' THEN 'RJ' WHEN '09' THEN 'UP' WHEN '10' THEN 'BR'
         WHEN '11' THEN 'SK' WHEN '12' THEN 'AR' WHEN '13' THEN 'NL' WHEN '14' THEN 'MN' WHEN '15' THEN 'MZ'
         WHEN '16' THEN 'TR' WHEN '17' THEN 'ML' WHEN '18' THEN 'AS' WHEN '19' THEN 'WB' WHEN '20' THEN 'JH'
         WHEN '21' THEN 'OD' WHEN '22' THEN 'CG' WHEN '23' THEN 'MP' WHEN '24' THEN 'GJ' WHEN '26' THEN 'DD'
         WHEN '27' THEN 'MH' WHEN '29' THEN 'KA' WHEN '30' THEN 'GA' WHEN '31' THEN 'LD' WHEN '32' THEN 'KL'
         WHEN '33' THEN 'TN' WHEN '34' THEN 'PY' WHEN '35' THEN 'AN' WHEN '36' THEN 'TG' WHEN '37' THEN 'AP'
         WHEN '38' THEN 'LA' WHEN '97' THEN 'OT'
         ELSE substr(g, 1, 2) END,
       true, o."einvoiceProvider", o."einvoiceUsername", o."einvoicePasswordCipher", o."einvoiceClientId",
       o."einvoiceClientSecretCipher", o."ewayIntraStateThreshold", now(), now()
  FROM (SELECT upper(btrim("gstin")) AS g, * FROM "organisation_settings" WHERE "id" = 'global') o
 WHERE length(g) = 15 AND substr(g, 1, 2) ~ '^[0-9]{2}$'
ON CONFLICT DO NOTHING;

-- Earlier GSTINs this company issued under (a company that moved state has two): same PAN, inactive,
-- so history keeps its registration and nobody can pick them for anything new.
INSERT INTO "gst_registrations" ("id", "gstin", "stateCode", "code", "active", "createdAt", "updatedAt")
SELECT 'gstreg_' || substr(md5(s.g), 1, 20), s.g, substr(s.g, 1, 2), substr(s.g, 1, 2) || substr(s.g, 13, 1), false, now(), now()
  FROM (SELECT DISTINCT upper(btrim("sellerGstin")) AS g FROM "trade_documents"
         WHERE "direction" = 'SALES' AND "sellerGstin" IS NOT NULL) s,
       (SELECT coalesce(nullif(upper(btrim("pan")), ''), substr(upper(btrim("gstin")), 3, 10)) AS pan
          FROM "organisation_settings" WHERE "id" = 'global') o
 WHERE length(s.g) = 15 AND substr(s.g, 1, 2) ~ '^[0-9]{2}$' AND substr(s.g, 3, 10) = o.pan
   AND NOT EXISTS (SELECT 1 FROM "gst_registrations" r WHERE r."gstin" = s.g)
ON CONFLICT DO NOTHING;

-- ── 2. The head office ───────────────────────────────────────────────────────
-- Every override blank, address included: it prints the registered office, as the company does today.
-- Only when there is something to attach to it — a fresh install gets its head office lazily, the same
-- way a reset one does, so the two stay identical.
INSERT INTO "branches" ("id", "name", "code", "gstRegistrationId", "isHeadOffice", "active", "createdAt", "updatedAt")
SELECT 'branch_head_office', 'Head office', 'HO',
       (SELECT "id" FROM "gst_registrations" WHERE "id" = 'gstreg_head_office'), true, true, now(), now()
 WHERE EXISTS (SELECT 1 FROM "organisation_settings") OR EXISTS (SELECT 1 FROM "trade_documents")
    OR EXISTS (SELECT 1 FROM "payments") OR EXISTS (SELECT 1 FROM "consignments") OR EXISTS (SELECT 1 FROM "journal_entries")
ON CONFLICT DO NOTHING;

-- ── 3. Documents ─────────────────────────────────────────────────────────────
-- Registration first: on a sales document the one its snapshot names; a sales document without a
-- snapshot, and every purchase, the head office's — which is what the single-GSTIN returns counted.
UPDATE "trade_documents" d SET "gstRegistrationId" = r."id"
  FROM "gst_registrations" r
 WHERE d."gstRegistrationId" IS NULL AND d."direction" = 'SALES' AND upper(btrim(d."sellerGstin")) = r."gstin";
UPDATE "trade_documents" SET "gstRegistrationId" = 'gstreg_head_office'
 WHERE "gstRegistrationId" IS NULL AND ("direction" = 'PURCHASE' OR "sellerGstin" IS NULL)
   AND EXISTS (SELECT 1 FROM "gst_registrations" WHERE "id" = 'gstreg_head_office');
UPDATE "trade_documents" SET "branchId" = 'branch_head_office'
 WHERE "branchId" IS NULL AND EXISTS (SELECT 1 FROM "branches" WHERE "id" = 'branch_head_office');

-- ── 4. Our GSTIN on purchase documents (X1) ───────────────────────────────────
-- The form sent the vendor's GSTIN as buyerGstin; keep it as the seller's and put ours where it belongs.
UPDATE "trade_documents" d
   SET "sellerGstin" = coalesce(nullif(upper(btrim(d."buyerGstin")), r."gstin"), d."sellerGstin"),
       "buyerGstin"  = r."gstin"
  FROM "gst_registrations" r
 WHERE d."direction" = 'PURCHASE' AND d."gstRegistrationId" = r."id" AND d."buyerGstin" IS DISTINCT FROM r."gstin";

-- ── 5. Payments, consignments ────────────────────────────────────────────────
UPDATE "payments" SET "branchId" = 'branch_head_office'
 WHERE "branchId" IS NULL AND EXISTS (SELECT 1 FROM "branches" WHERE "id" = 'branch_head_office');
UPDATE "consignments" SET "branchId" = 'branch_head_office'
 WHERE "branchId" IS NULL AND EXISTS (SELECT 1 FROM "branches" WHERE "id" = 'branch_head_office');

-- ── 6. Journal lines ──────────────────────────────────────────────────────────
-- A document's entry, and the reversal of one, take the document's branch and registration on every line.
UPDATE "journal_lines" l SET "branchId" = d."branchId", "gstRegistrationId" = d."gstRegistrationId"
  FROM "journal_entries" e JOIN "trade_documents" d ON d."id" = e."documentId"
 WHERE l."entryId" = e."id" AND l."branchId" IS NULL;
UPDATE "journal_lines" l SET "branchId" = d."branchId", "gstRegistrationId" = d."gstRegistrationId"
  FROM "journal_entries" e JOIN "journal_entries" o ON o."id" = e."reversesId" JOIN "trade_documents" d ON d."id" = o."documentId"
 WHERE l."entryId" = e."id" AND l."branchId" IS NULL;
-- Everything else happened at the only place of business there was.
UPDATE "journal_lines" SET "branchId" = 'branch_head_office'
 WHERE "branchId" IS NULL AND EXISTS (SELECT 1 FROM "branches" WHERE "id" = 'branch_head_office');
-- The registration matters only on the GST accounts.
UPDATE "journal_lines" l SET "gstRegistrationId" = 'gstreg_head_office'
  FROM "ledger_accounts" a
 WHERE l."accountId" = a."id" AND l."gstRegistrationId" IS NULL
   AND a."systemKey" IN ('INPUT_CGST', 'INPUT_SGST', 'INPUT_IGST', 'OUTPUT_CGST', 'OUTPUT_SGST', 'OUTPUT_IGST')
   AND EXISTS (SELECT 1 FROM "gst_registrations" WHERE "id" = 'gstreg_head_office');

-- Numbering: nothing. Every type stays COMPANY-scoped (the column default); the existing
-- DocumentNumberSetting rows become the head office's series only when somebody switches scope.
-- Users: nothing. No home branch means "the head office" until somebody sets one.

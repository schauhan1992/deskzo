-- The GST portal's HSN/SAC directory (prisma/reference/hsn.ts loads it).

-- CreateEnum
CREATE TYPE "HsnKind" AS ENUM ('GOODS', 'SERVICES');

-- CreateTable
CREATE TABLE "hsn_codes" (
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "kind" "HsnKind" NOT NULL,
    "heading" TEXT,

    CONSTRAINT "hsn_codes_pkey" PRIMARY KEY ("code"),
    -- Digits only, two to eight of them — the loader normalises "2307 00" and restores a dropped zero.
    CONSTRAINT "hsn_codes_code_digits" CHECK ("code" ~ '^[0-9]{2,8}$'),
    -- Every SAC starts with 99 and no HSN does: what tells a goods code from a services one.
    CONSTRAINT "hsn_codes_kind_matches_code" CHECK (("kind" = 'SERVICES') = ("code" LIKE '99%'))
);

-- CreateIndex
CREATE INDEX "hsn_codes_kind_idx" ON "hsn_codes"("kind");

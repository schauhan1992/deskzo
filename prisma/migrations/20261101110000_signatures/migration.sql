-- Deskzo Signatures (owner, 10 Oct 2026; docs/digital-cards-and-signatures.md §5): the company's
-- email signature settings and each person's own choice. Two new tables; no existing table changes,
-- so a workspace not yet migrated reads exactly as before.

-- CreateTable
CREATE TABLE "signature_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "templateKey" TEXT NOT NULL DEFAULT 'simple',
    "lockTemplate" BOOLEAN NOT NULL DEFAULT false,
    "accentColor" TEXT NOT NULL DEFAULT '#2563eb',
    "website" TEXT,
    "socials" JSONB NOT NULL DEFAULT '{}',
    "disclaimer" TEXT,
    "bannerImageUrl" TEXT,
    "bannerLink" TEXT,
    "showPhoto" BOOLEAN NOT NULL DEFAULT true,
    "showCard" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signature_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_signatures" (
    "userId" TEXT NOT NULL,
    "templateKey" TEXT,
    "mobile" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_signatures_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "user_signatures" ADD CONSTRAINT "user_signatures_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

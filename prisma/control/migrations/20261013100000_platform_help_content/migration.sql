-- Help and What's new from Deskzo: articles, walkthrough videos and release notes, published from the
-- console and shown read-only in every workspace they apply to (src/lib/platform/help-content.ts).

-- CreateEnum
CREATE TYPE "PlatformHelpKind" AS ENUM ('ARTICLE', 'VIDEO');

-- CreateTable
CREATE TABLE "platform_help_links" (
    "id" TEXT NOT NULL,
    "kind" "PlatformHelpKind" NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "modules" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "countries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "publishedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_help_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_updates" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "linkUrl" TEXT,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "modules" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "countries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "publishedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_updates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_help_links_archivedAt_publishedAt_idx" ON "platform_help_links"("archivedAt", "publishedAt");

-- CreateIndex
CREATE INDEX "platform_updates_archivedAt_publishedAt_idx" ON "platform_updates"("archivedAt", "publishedAt");


-- Written by hand: the limits the console holds them to (PLATFORM_HELP_LIMITS in help-content.ts).
-- A link is an https:// address or a single-slash path in the app, with no spaces or control
-- characters — a browser drops a tab or a newline from an address, so "/<tab>/evil.example" would
-- open another site. Which hosts are allowed is the console's rule, and the loader's, not this one:
-- it may grow without a migration. Module keys and country codes are stored as they are compared.
ALTER TABLE "platform_help_links"
  ADD CONSTRAINT "platform_help_links_lengths" CHECK (char_length("title") BETWEEN 3 AND 120 AND ("description" IS NULL OR char_length("description") <= 300)),
  ADD CONSTRAINT "platform_help_links_url_shape" CHECK (
    char_length("url") <= 2000
    AND "url" ~ '^(https://[^/[:space:]]|/([^/\\]|$))'
    AND "url" !~ '[[:space:][:cntrl:]]'
  ),
  ADD CONSTRAINT "platform_help_links_sort_order" CHECK ("sortOrder" BETWEEN 0 AND 9999),
  ADD CONSTRAINT "platform_help_links_targets" CHECK (
    cardinality("modules") <= 100
    AND cardinality("countries") <= 250
    AND array_to_string("modules", ',') ~ '^([a-z][a-z0-9_]{0,39}(,[a-z][a-z0-9_]{0,39})*)?$'
    AND array_to_string("countries", ',') ~ '^([A-Z]{2}(,[A-Z]{2})*)?$'
  );
ALTER TABLE "platform_updates"
  ADD CONSTRAINT "platform_updates_lengths" CHECK (char_length("title") BETWEEN 3 AND 120 AND char_length("body") BETWEEN 1 AND 4000),
  ADD CONSTRAINT "platform_updates_link_shape" CHECK (
    "linkUrl" IS NULL
    OR (
      char_length("linkUrl") <= 2000
      AND "linkUrl" ~ '^(https://[^/[:space:]]|/([^/\\]|$))'
      AND "linkUrl" !~ '[[:space:][:cntrl:]]'
    )
  ),
  ADD CONSTRAINT "platform_updates_targets" CHECK (
    cardinality("modules") <= 100
    AND cardinality("countries") <= 250
    AND array_to_string("modules", ',') ~ '^([a-z][a-z0-9_]{0,39}(,[a-z][a-z0-9_]{0,39})*)?$'
    AND array_to_string("countries", ',') ~ '^([A-Z]{2}(,[A-Z]{2})*)?$'
  );

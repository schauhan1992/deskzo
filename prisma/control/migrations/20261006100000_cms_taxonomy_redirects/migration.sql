-- CreateEnum
CREATE TYPE "SiteRedirectMatch" AS ENUM ('EXACT', 'PREFIX');

-- CreateTable
CREATE TABLE "site_categories" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "parentId" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "seo" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "site_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_tags" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "seo" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "site_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_post_categories" (
    "postId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "site_post_categories_pkey" PRIMARY KEY ("postId","categoryId")
);

-- CreateTable
CREATE TABLE "site_post_tags" (
    "postId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    CONSTRAINT "site_post_tags_pkey" PRIMARY KEY ("postId","tagId")
);

-- CreateTable
CREATE TABLE "site_redirects" (
    "id" TEXT NOT NULL,
    "fromPath" TEXT NOT NULL,
    "toUrl" TEXT NOT NULL,
    "status" INTEGER NOT NULL DEFAULT 301,
    "match" "SiteRedirectMatch" NOT NULL DEFAULT 'EXACT',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "automatic" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "lastHitAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "site_redirects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "site_categories_slug_key" ON "site_categories"("slug");

-- CreateIndex
CREATE INDEX "site_categories_parentId_position_idx" ON "site_categories"("parentId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "site_tags_slug_key" ON "site_tags"("slug");

-- CreateIndex
CREATE INDEX "site_post_categories_categoryId_idx" ON "site_post_categories"("categoryId");

-- CreateIndex
CREATE INDEX "site_post_tags_tagId_idx" ON "site_post_tags"("tagId");

-- CreateIndex
CREATE UNIQUE INDEX "site_redirects_fromPath_key" ON "site_redirects"("fromPath");

-- AddForeignKey
ALTER TABLE "site_categories" ADD CONSTRAINT "site_categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "site_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_post_categories" ADD CONSTRAINT "site_post_categories_postId_fkey" FOREIGN KEY ("postId") REFERENCES "site_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_post_categories" ADD CONSTRAINT "site_post_categories_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "site_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_post_tags" ADD CONSTRAINT "site_post_tags_postId_fkey" FOREIGN KEY ("postId") REFERENCES "site_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_post_tags" ADD CONSTRAINT "site_post_tags_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "site_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Written by hand: limits the schema cannot say.
ALTER TABLE "site_categories" ADD CONSTRAINT "site_categories_slug_format" CHECK (char_length("slug") <= 60 AND "slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
ALTER TABLE "site_categories" ADD CONSTRAINT "site_categories_lengths" CHECK (char_length("name") BETWEEN 1 AND 60 AND ("description" IS NULL OR char_length("description") <= 500));
ALTER TABLE "site_categories" ADD CONSTRAINT "site_categories_not_own_parent" CHECK ("parentId" IS NULL OR "parentId" <> "id");
ALTER TABLE "site_tags" ADD CONSTRAINT "site_tags_slug_format" CHECK (char_length("slug") <= 60 AND "slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
ALTER TABLE "site_tags" ADD CONSTRAINT "site_tags_lengths" CHECK (char_length("name") BETWEEN 1 AND 40 AND ("description" IS NULL OR char_length("description") <= 500));
ALTER TABLE "site_redirects" ADD CONSTRAINT "site_redirects_status" CHECK ("status" IN (301, 302, 307, 308));
-- A normalised path: from "/", at most 2000, no ASCII capitals, no query, no trailing "/" but "/" itself.
ALTER TABLE "site_redirects" ADD CONSTRAINT "site_redirects_from_path" CHECK (left("fromPath", 1) = '/' AND char_length("fromPath") <= 2000 AND "fromPath" !~ '[A-Z]' AND strpos("fromPath", '?') = 0 AND ("fromPath" = '/' OR right("fromPath", 1) <> '/'));
-- A site path (never "//" or "/" then a backslash, which browsers read as another host) or an https://
-- URL with a host; no spaces or control characters. Rules out javascript:, data: and http: outright.
ALTER TABLE "site_redirects" ADD CONSTRAINT "site_redirects_to_url" CHECK (char_length("toUrl") BETWEEN 1 AND 2000 AND "toUrl" !~ '[[:space:][:cntrl:]]' AND ((left("toUrl", 1) = '/' AND substr("toUrl", 2, 1) NOT IN ('/', chr(92))) OR (left("toUrl", 8) = 'https://' AND char_length("toUrl") > 8 AND substr("toUrl", 9, 1) NOT IN ('/', chr(92)))));
-- PREFIX, and only PREFIX, matches from a "/*" source; only a PREFIX one may carry the rest to a "/*" target.
ALTER TABLE "site_redirects" ADD CONSTRAINT "site_redirects_prefix_splat" CHECK (("match" = 'PREFIX') = (right("fromPath", 2) = '/*') AND ("match" = 'PREFIX' OR right("toUrl", 2) <> '/*'));
ALTER TABLE "site_redirects" ADD CONSTRAINT "site_redirects_note_length" CHECK ("note" IS NULL OR char_length("note") <= 500);
ALTER TABLE "site_redirects" ADD CONSTRAINT "site_redirects_hits" CHECK ("hits" >= 0);

-- Written by hand: the backfill. Posts' free-text tags (site_posts.tags, kept for now) become SiteTag
-- records and join rows. Each value is slugified as src/lib/cms/validate.ts slugify() does, cut at 60:
-- NFKD, combining marks (U+0300 to U+036F, as chr(768) to chr(879)) dropped, lower-cased, every run of
-- anything but a-z and 0-9 made one "-", hyphens trimmed from both ends, cut, trailing hyphens trimmed
-- again. Tags that slugify alike are one tag, named after the value that is its own slug if there is
-- one, else the first in order; a value that slugifies to nothing is left out. Safe to run twice.
INSERT INTO "site_tags" ("id", "slug", "name", "createdAt", "updatedAt", "updatedBy")
SELECT DISTINCT ON (v."slug") gen_random_uuid()::text, v."slug", left(btrim(v."tag"), 40), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'script'
FROM (
    SELECT DISTINCT t."tag",
        regexp_replace(left(regexp_replace(regexp_replace(lower(regexp_replace(normalize(t."tag", NFKD), '[' || chr(768) || '-' || chr(879) || ']', '', 'g')), '[^a-z0-9]+', '-', 'g'), '^-+|-+$', '', 'g'), 60), '-+$', '') AS "slug"
    FROM "site_posts" p CROSS JOIN LATERAL unnest(p."tags") AS t("tag")
) v
WHERE v."slug" <> ''
ORDER BY v."slug", (v."tag" = v."slug") DESC, v."tag"
ON CONFLICT ("slug") DO NOTHING;

INSERT INTO "site_post_tags" ("postId", "tagId")
SELECT DISTINCT p."id", g."id"
FROM "site_posts" p CROSS JOIN LATERAL unnest(p."tags") AS t("tag")
JOIN "site_tags" g ON g."slug" = regexp_replace(left(regexp_replace(regexp_replace(lower(regexp_replace(normalize(t."tag", NFKD), '[' || chr(768) || '-' || chr(879) || ']', '', 'g')), '[^a-z0-9]+', '-', 'g'), '^-+|-+$', '', 'g'), 60), '-+$', '')
ON CONFLICT DO NOTHING;

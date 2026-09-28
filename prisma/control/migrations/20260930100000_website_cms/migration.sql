-- CreateEnum
CREATE TYPE "CmsRole" AS ENUM ('ADMIN', 'EDITOR', 'AUTHOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "SitePageStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "SitePostStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "SiteLeadStatus" AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'CLOSED', 'SPAM');

-- CreateTable
CREATE TABLE "cms_users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "CmsRole" NOT NULL,
    "passwordHash" TEXT,
    "setupTokenHash" TEXT,
    "setupExpiresAt" TIMESTAMP(3),
    "totpSecretCipher" TEXT,
    "totpEnabledAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "lastSignInAt" TIMESTAMP(3),

    CONSTRAINT "cms_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cms_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "mfaAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "cms_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cms_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "cms_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "site_pages" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "SitePageStatus" NOT NULL DEFAULT 'DRAFT',
    "draft" JSONB NOT NULL,
    "published" JSONB,
    "publishedAt" TIMESTAMP(3),
    "publishedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "site_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_page_versions" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "document" JSONB NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "site_page_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_posts" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "excerpt" TEXT,
    "coverMediaId" TEXT,
    "body" JSONB NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "SitePostStatus" NOT NULL DEFAULT 'DRAFT',
    "publishAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "seo" JSONB,
    "authorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "site_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_media" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "alt" TEXT NOT NULL DEFAULT '',
    "data" BYTEA NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "site_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_settings" (
    "key" TEXT NOT NULL,
    "draft" JSONB NOT NULL,
    "published" JSONB,
    "publishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "site_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "site_leads" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "company" TEXT,
    "phone" TEXT,
    "topic" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" "SiteLeadStatus" NOT NULL DEFAULT 'NEW',
    "notes" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "handledBy" TEXT,

    CONSTRAINT "site_leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cms_audit_log" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" TEXT,
    "actorLabel" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "detail" JSONB,

    CONSTRAINT "cms_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cms_users_email_key" ON "cms_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "cms_users_setupTokenHash_key" ON "cms_users"("setupTokenHash");

-- CreateIndex
CREATE INDEX "cms_sessions_userId_idx" ON "cms_sessions"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "site_pages_slug_key" ON "site_pages"("slug");

-- CreateIndex
CREATE INDEX "site_page_versions_pageId_createdAt_idx" ON "site_page_versions"("pageId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "site_posts_slug_key" ON "site_posts"("slug");

-- CreateIndex
CREATE INDEX "site_posts_status_publishAt_idx" ON "site_posts"("status", "publishAt");

-- CreateIndex
CREATE UNIQUE INDEX "site_media_sha256_key" ON "site_media"("sha256");

-- CreateIndex
CREATE INDEX "site_media_createdAt_idx" ON "site_media"("createdAt");

-- CreateIndex
CREATE INDEX "site_leads_status_createdAt_idx" ON "site_leads"("status", "createdAt");

-- CreateIndex
CREATE INDEX "site_leads_createdAt_idx" ON "site_leads"("createdAt");

-- CreateIndex
CREATE INDEX "cms_audit_log_at_idx" ON "cms_audit_log"("at");

-- CreateIndex
CREATE INDEX "cms_audit_log_actorId_at_idx" ON "cms_audit_log"("actorId", "at");

-- CreateIndex
CREATE INDEX "cms_audit_log_entity_entityId_idx" ON "cms_audit_log"("entity", "entityId");

-- AddForeignKey
ALTER TABLE "cms_sessions" ADD CONSTRAINT "cms_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "cms_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_page_versions" ADD CONSTRAINT "site_page_versions_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "site_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_posts" ADD CONSTRAINT "site_posts_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "cms_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Written by hand: limits the schema cannot say.
ALTER TABLE "cms_users" ADD CONSTRAINT "cms_users_email_lower" CHECK ("email" = lower("email") AND char_length("email") BETWEEN 3 AND 254);
ALTER TABLE "cms_users" ADD CONSTRAINT "cms_users_name_length" CHECK (char_length("name") BETWEEN 1 AND 120);
ALTER TABLE "cms_settings" ADD CONSTRAINT "cms_settings_value_length" CHECK (char_length("value") <= 200);
ALTER TABLE "site_pages" ADD CONSTRAINT "site_pages_slug_format" CHECK (char_length("slug") <= 120 AND "slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*(/[a-z0-9]+(-[a-z0-9]+)*)*$');
ALTER TABLE "site_pages" ADD CONSTRAINT "site_pages_title_length" CHECK (char_length("title") BETWEEN 1 AND 200);
ALTER TABLE "site_pages" ADD CONSTRAINT "site_pages_published_when_status" CHECK ("status" = 'DRAFT' OR "published" IS NOT NULL);
ALTER TABLE "site_page_versions" ADD CONSTRAINT "site_page_versions_note_length" CHECK ("note" IS NULL OR char_length("note") <= 200);
ALTER TABLE "site_posts" ADD CONSTRAINT "site_posts_slug_format" CHECK (char_length("slug") <= 120 AND "slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
ALTER TABLE "site_posts" ADD CONSTRAINT "site_posts_lengths" CHECK (char_length("title") BETWEEN 1 AND 200 AND ("excerpt" IS NULL OR char_length("excerpt") <= 500));
ALTER TABLE "site_posts" ADD CONSTRAINT "site_posts_tags_at_most_ten" CHECK (cardinality("tags") <= 10);
ALTER TABLE "site_posts" ADD CONSTRAINT "site_posts_scheduled_has_time" CHECK ("status" = 'DRAFT' OR "publishAt" IS NOT NULL);
ALTER TABLE "site_media" ADD CONSTRAINT "site_media_mime" CHECK ("mime" IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif'));
ALTER TABLE "site_media" ADD CONSTRAINT "site_media_size" CHECK ("size" BETWEEN 1 AND 5242880 AND "size" = octet_length("data"));
ALTER TABLE "site_media" ADD CONSTRAINT "site_media_lengths" CHECK (char_length("filename") BETWEEN 1 AND 200 AND char_length("alt") <= 300);
ALTER TABLE "site_leads" ADD CONSTRAINT "site_leads_lengths" CHECK (char_length("name") BETWEEN 1 AND 120 AND char_length("email") BETWEEN 3 AND 254 AND ("company" IS NULL OR char_length("company") <= 160) AND ("phone" IS NULL OR char_length("phone") <= 32) AND char_length("message") BETWEEN 1 AND 4000 AND ("notes" IS NULL OR char_length("notes") <= 4000));
ALTER TABLE "site_leads" ADD CONSTRAINT "site_leads_topic" CHECK ("topic" IN ('demo', 'sales', 'support', 'other'));

-- CreateEnum
CREATE TYPE "HelpLinkKind" AS ENUM ('ARTICLE', 'VIDEO');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "updatesSeenAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "help_desk" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "helplineLabel" TEXT,
    "helplinePhone" TEXT,
    "helplineHours" TEXT,
    "helplineLanguages" TEXT,
    "supportEmail" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "help_desk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "help_links" (
    "id" TEXT NOT NULL,
    "kind" "HelpLinkKind" NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "help_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcements" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "linkUrl" TEXT,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "help_links_kind_active_sortOrder_idx" ON "help_links"("kind", "active", "sortOrder");

-- CreateIndex
CREATE INDEX "announcements_publishedAt_idx" ON "announcements"("publishedAt");

-- AddForeignKey
ALTER TABLE "help_desk" ADD CONSTRAINT "help_desk_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "help_links" ADD CONSTRAINT "help_links_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

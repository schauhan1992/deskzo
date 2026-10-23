-- Over-the-air updates of the Deskzo phone app's screens (owner, 23 Oct 2026): what's been published, and its files.

-- CreateEnum
CREATE TYPE "AppUpdateKind" AS ENUM ('UPDATE', 'ROLL_BACK_TO_EMBEDDED');

-- CreateTable
CREATE TABLE "app_updates" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "runtimeVersion" TEXT NOT NULL,
    "kind" "AppUpdateKind" NOT NULL,
    "body" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assetHashes" TEXT[],

    CONSTRAINT "app_updates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_update_assets" (
    "hash" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "bytes" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_update_assets_pkey" PRIMARY KEY ("hash")
);

-- CreateIndex
CREATE INDEX "app_updates_platform_runtimeVersion_createdAt_idx" ON "app_updates"("platform", "runtimeVersion", "createdAt");

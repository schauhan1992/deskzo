-- CreateEnum
CREATE TYPE "CelebrationSource" AS ENUM ('MANUAL', 'DEAL_WON', 'TARGET_HIT', 'FIRST_ORDER', 'TOP_PERFORMER');

-- CreateEnum
CREATE TYPE "SplashScope" AS ENUM ('EVERYONE', 'SUBJECT');

-- DropForeignKey
ALTER TABLE "celebrations" DROP CONSTRAINT "celebrations_createdById_fkey";

-- AlterTable
ALTER TABLE "celebrations" ADD COLUMN     "amount" DECIMAL(14,2),
ADD COLUMN     "details" JSONB,
ADD COLUMN     "occasionKey" TEXT,
ADD COLUMN     "source" "CelebrationSource" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "splashFor" "SplashScope" NOT NULL DEFAULT 'EVERYONE',
ALTER COLUMN "createdById" DROP NOT NULL;

-- CreateTable
CREATE TABLE "sales_celebration_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "dealWon" BOOLEAN NOT NULL DEFAULT true,
    "dealWonMinimum" DECIMAL(14,2) NOT NULL DEFAULT 500000,
    "dealWonSplash" "SplashScope" NOT NULL DEFAULT 'EVERYONE',
    "targetHit" BOOLEAN NOT NULL DEFAULT true,
    "targetHitSplash" "SplashScope" NOT NULL DEFAULT 'EVERYONE',
    "targetMetrics" "TargetMetric"[] DEFAULT ARRAY[]::"TargetMetric"[],
    "firstOrder" BOOLEAN NOT NULL DEFAULT true,
    "firstOrderSplash" "SplashScope" NOT NULL DEFAULT 'SUBJECT',
    "topPerformer" BOOLEAN NOT NULL DEFAULT true,
    "topPerformerSplash" "SplashScope" NOT NULL DEFAULT 'EVERYONE',
    "topPerformerCount" INTEGER NOT NULL DEFAULT 3,
    "showAmounts" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_celebration_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "celebrations_occasionKey_key" ON "celebrations"("occasionKey");

-- CreateIndex
CREATE INDEX "celebrations_source_createdAt_idx" ON "celebrations"("source", "createdAt");

-- AddForeignKey
ALTER TABLE "celebrations" ADD CONSTRAINT "celebrations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_celebration_settings" ADD CONSTRAINT "sales_celebration_settings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

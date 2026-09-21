-- CreateEnum
CREATE TYPE "ActivityKind" AS ENUM ('LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'PASSWORD_CHANGED', 'TWO_FACTOR_ENABLED', 'IMPERSONATION_STARTED', 'IMPERSONATION_ENDED', 'VIEW', 'SEARCH', 'EXPORT', 'PRINT', 'BULK_READ', 'SCREENSHOT', 'SCREENSHOT_BLOCKED', 'COPY_BLOCKED', 'CUT_BLOCKED', 'PASTE_BLOCKED', 'CONTEXT_MENU_BLOCKED', 'PRINT_BLOCKED', 'DEVTOOLS_OPENED', 'BOT_BLOCKED', 'PERMISSION_DENIED', 'RATE_LIMITED', 'SECURITY_POLICY_CHANGED');

-- CreateEnum
CREATE TYPE "ActivitySeverity" AS ENUM ('INFO', 'NOTICE', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "BotMode" AS ENUM ('BLOCK', 'LOG');

-- CreateTable
CREATE TABLE "activity_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "userName" TEXT,
    "userEmail" TEXT,
    "impersonatedByUserId" TEXT,
    "kind" "ActivityKind" NOT NULL,
    "severity" "ActivitySeverity" NOT NULL DEFAULT 'INFO',
    "summary" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "path" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "screenshot_allowances" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "lastAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "screenshot_allowances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_policy" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "blockCopy" BOOLEAN NOT NULL DEFAULT false,
    "blockCut" BOOLEAN NOT NULL DEFAULT false,
    "blockPaste" BOOLEAN NOT NULL DEFAULT false,
    "blockContextMenu" BOOLEAN NOT NULL DEFAULT false,
    "blockTextSelection" BOOLEAN NOT NULL DEFAULT false,
    "blockPrint" BOOLEAN NOT NULL DEFAULT false,
    "blockDevTools" BOOLEAN NOT NULL DEFAULT false,
    "blurOnBlur" BOOLEAN NOT NULL DEFAULT false,
    "screenshotLimitPerDay" INTEGER NOT NULL DEFAULT 2,
    "screenshotNotifyAdmins" BOOLEAN NOT NULL DEFAULT true,
    "watermarkEnabled" BOOLEAN NOT NULL DEFAULT false,
    "watermarkOpacity" INTEGER NOT NULL DEFAULT 7,
    "exportRowLimit" INTEGER NOT NULL DEFAULT 1000,
    "exportRequiresReason" BOOLEAN NOT NULL DEFAULT false,
    "bulkReadThreshold" INTEGER NOT NULL DEFAULT 400,
    "bulkReadWindowMinutes" INTEGER NOT NULL DEFAULT 10,
    "blockBots" BOOLEAN NOT NULL DEFAULT true,
    "blockAiCrawlers" BOOLEAN NOT NULL DEFAULT true,
    "botMode" "BotMode" NOT NULL DEFAULT 'BLOCK',
    "logPageViews" BOOLEAN NOT NULL DEFAULT false,
    "retentionDays" INTEGER NOT NULL DEFAULT 365,
    "exemptRoles" "Role"[] DEFAULT ARRAY[]::"Role"[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "security_policy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "activity_logs_createdAt_idx" ON "activity_logs"("createdAt");

-- CreateIndex
CREATE INDEX "activity_logs_userId_createdAt_idx" ON "activity_logs"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "activity_logs_kind_createdAt_idx" ON "activity_logs"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "activity_logs_severity_createdAt_idx" ON "activity_logs"("severity", "createdAt");

-- CreateIndex
CREATE INDEX "activity_logs_entityType_entityId_idx" ON "activity_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "screenshot_allowances_day_idx" ON "screenshot_allowances"("day");

-- CreateIndex
CREATE UNIQUE INDEX "screenshot_allowances_userId_day_key" ON "screenshot_allowances"("userId", "day");

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_impersonatedByUserId_fkey" FOREIGN KEY ("impersonatedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "screenshot_allowances" ADD CONSTRAINT "screenshot_allowances_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


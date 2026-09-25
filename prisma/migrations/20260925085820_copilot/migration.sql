-- CreateEnum
CREATE TYPE "AiProvider" AS ENUM ('ANTHROPIC', 'OPENAI', 'GEMINI');

-- CreateEnum
CREATE TYPE "CopilotProposalKind" AS ENUM ('TASK', 'NOTE');

-- CreateEnum
CREATE TYPE "CopilotProposalStatus" AS ENUM ('PENDING', 'DONE', 'CANCELLED', 'FAILED');

-- CreateTable
CREATE TABLE "copilot_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "provider" "AiProvider" NOT NULL DEFAULT 'ANTHROPIC',
    "model" TEXT NOT NULL DEFAULT 'claude-opus-5',
    "anthropicKeyCipher" TEXT,
    "openaiKeyCipher" TEXT,
    "geminiKeyCipher" TEXT,
    "dailyTokenLimit" INTEGER NOT NULL DEFAULT 300000,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "copilot_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "copilot_conversations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "copilot_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "copilot_messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "provider" "AiProvider",
    "model" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "copilot_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "copilot_usage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "requests" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "copilot_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "copilot_proposals" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "CopilotProposalKind" NOT NULL,
    "payload" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "status" "CopilotProposalStatus" NOT NULL DEFAULT 'PENDING',
    "recordId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "copilot_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "copilot_conversations_userId_updatedAt_idx" ON "copilot_conversations"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "copilot_messages_conversationId_createdAt_idx" ON "copilot_messages"("conversationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "copilot_usage_userId_day_key" ON "copilot_usage"("userId", "day");

-- CreateIndex
CREATE INDEX "copilot_proposals_userId_status_idx" ON "copilot_proposals"("userId", "status");

-- AddForeignKey
ALTER TABLE "copilot_settings" ADD CONSTRAINT "copilot_settings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "copilot_conversations" ADD CONSTRAINT "copilot_conversations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "copilot_messages" ADD CONSTRAINT "copilot_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "copilot_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "copilot_usage" ADD CONSTRAINT "copilot_usage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "copilot_proposals" ADD CONSTRAINT "copilot_proposals_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "copilot_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "copilot_proposals" ADD CONSTRAINT "copilot_proposals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

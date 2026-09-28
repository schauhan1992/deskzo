-- CreateEnum
CREATE TYPE "SupportStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'WAITING', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "SupportPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "SupportAttachmentKind" AS ENUM ('FILE', 'RECORDING');

-- CreateEnum
CREATE TYPE "SupportEntryKind" AS ENUM ('REPLY', 'NOTE', 'STATUS', 'PRIORITY', 'ASSIGN');

-- CreateTable
CREATE TABLE "support_requests" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "tenantId" TEXT NOT NULL,
    "requesterUserId" TEXT NOT NULL,
    "requesterName" TEXT NOT NULL,
    "requesterEmail" TEXT NOT NULL,
    "requesterRole" TEXT,
    "mobile" TEXT,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "priority" "SupportPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "SupportStatus" NOT NULL DEFAULT 'OPEN',
    "assigneeId" TEXT,
    "context" JSONB NOT NULL,
    "consoleLog" JSONB,
    "recordingConsentAt" TIMESTAMP(3),
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "firstResponseAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "support_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_attachments" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "kind" "SupportAttachmentKind" NOT NULL,
    "filename" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "durationMs" INTEGER,
    "purgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_entries" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "kind" "SupportEntryKind" NOT NULL,
    "body" TEXT,
    "authorId" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "support_requests_number_key" ON "support_requests"("number");

-- CreateIndex
CREATE INDEX "support_requests_status_priority_createdAt_idx" ON "support_requests"("status", "priority", "createdAt");

-- CreateIndex
CREATE INDEX "support_requests_tenantId_createdAt_idx" ON "support_requests"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "support_requests_assigneeId_status_idx" ON "support_requests"("assigneeId", "status");

-- CreateIndex
CREATE INDEX "support_attachments_requestId_idx" ON "support_attachments"("requestId");

-- CreateIndex
CREATE INDEX "support_entries_requestId_createdAt_idx" ON "support_entries"("requestId", "createdAt");

-- AddForeignKey
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "platform_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_attachments" ADD CONSTRAINT "support_attachments_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "support_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_entries" ADD CONSTRAINT "support_entries_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "support_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_entries" ADD CONSTRAINT "support_entries_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "platform_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Written by hand: the numbering, and limits the schema cannot say.
-- SR-1001 is the first request: a support number that starts at 1 reads like a test.
ALTER SEQUENCE "support_requests_number_seq" RESTART WITH 1001;
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_subject_length" CHECK (char_length("subject") BETWEEN 1 AND 150);
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_body_length" CHECK (char_length("body") BETWEEN 1 AND 5000);
ALTER TABLE "support_attachments" ADD CONSTRAINT "support_attachments_size" CHECK ("size" >= 0);
ALTER TABLE "support_entries" ADD CONSTRAINT "support_entries_body_length" CHECK ("body" IS NULL OR char_length("body") BETWEEN 1 AND 5000);

-- The Customer inbox, phase 2 (owner, 24 Oct 2026): customers' WhatsApp files kept once opened, when the
-- away notice was last sent, and whose turn round-robin is on. New table and columns on tables new this release.

-- AlterTable
ALTER TABLE "inbox_channels" ADD COLUMN     "lastAssignedUserId" TEXT;

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "awayNoticeAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "conversation_messages" ADD COLUMN     "mediaId" TEXT,
ADD COLUMN     "mediaMime" TEXT,
ADD COLUMN     "mediaName" TEXT;

-- CreateTable
CREATE TABLE "conversation_files" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "name" TEXT,
    "size" INTEGER NOT NULL,
    "bytes" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "conversation_files_messageId_key" ON "conversation_files"("messageId");

-- AddForeignKey
ALTER TABLE "conversation_files" ADD CONSTRAINT "conversation_files_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "conversation_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;


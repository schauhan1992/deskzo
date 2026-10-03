-- Wishes (owner, 3 Oct 2026): clicking a colleague's birthday or work anniversary on the dashboard sends
-- them a wish, once (src/lib/hr/wishes.ts). One new table, its kind, and a notification type that folds every
-- wish for one occasion into a single notification. Nothing existing changes.

-- CreateEnum
CREATE TYPE "WishKind" AS ENUM ('BIRTHDAY', 'ANNIVERSARY');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'WISHES';

-- CreateTable
CREATE TABLE "wishes" (
    "id" TEXT NOT NULL,
    "occasionKey" TEXT NOT NULL,
    "kind" "WishKind" NOT NULL,
    "recipientId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "seenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wishes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wishes_recipientId_occasionKey_idx" ON "wishes"("recipientId", "occasionKey");

-- CreateIndex
CREATE UNIQUE INDEX "wishes_occasionKey_senderId_key" ON "wishes"("occasionKey", "senderId");

-- AddForeignKey
ALTER TABLE "wishes" ADD CONSTRAINT "wishes_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wishes" ADD CONSTRAINT "wishes_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


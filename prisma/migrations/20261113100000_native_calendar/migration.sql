-- Deskzo's own calendar (owner, 17 Oct 2026 — src/lib/calendar/native.ts). A meeting scheduled by somebody
-- with no working calendar connection is kept by Deskzo alone: no provider, no external id. Its invitation
-- is an iCalendar email whose SEQUENCE counts each change; once its organiser connects Outlook, Google or
-- Zoho, a copy goes into that calendar once (mirror*). And each person's subscribe link, kept as a hash.
-- Expand-only: two columns may now be null, five are new with defaults or nullable, one table is new.

-- AlterTable
ALTER TABLE "calendar_events" ADD COLUMN     "mirrorEtag" TEXT,
ADD COLUMN     "mirrorId" TEXT,
ADD COLUMN     "mirrorProvider" "MailConnectionProvider",
ADD COLUMN     "mirroredAt" TIMESTAMP(3),
ADD COLUMN     "sequence" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "provider" DROP NOT NULL,
ALTER COLUMN "externalId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "calendar_feeds" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "showTitles" BOOLEAN NOT NULL DEFAULT false,
    "windowStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reads" INTEGER NOT NULL DEFAULT 0,
    "lastReadAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calendar_feeds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "calendar_feeds_userId_key" ON "calendar_feeds"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_feeds_tokenHash_key" ON "calendar_feeds"("tokenHash");

-- AddForeignKey
ALTER TABLE "calendar_feeds" ADD CONSTRAINT "calendar_feeds_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

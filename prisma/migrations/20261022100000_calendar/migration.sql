-- Calendars (owner, 2 and 3 Oct 2026): each person's Outlook, Google Calendar or Zoho Calendar kept in step through
-- the connection their mailbox already uses (src/lib/calendar). Two new tables and nothing else changed:
-- calendar_accounts holds where each person's sync got to, calendar_events what it found, with the
-- record a meeting scheduled from here was for.
CREATE TYPE "CalendarEventStatus" AS ENUM ('CONFIRMED', 'TENTATIVE', 'CANCELLED');

-- CreateTable
CREATE TABLE "calendar_accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "MailConnectionProvider" NOT NULL,
    "calendarId" TEXT,
    "syncCursor" TEXT,
    "windowFrom" TIMESTAMP(3),
    "windowTo" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "nextSyncAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "brokenAt" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calendar_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_events" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "MailConnectionProvider" NOT NULL,
    "externalId" TEXT NOT NULL,
    "etag" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "location" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "allDay" BOOLEAN NOT NULL DEFAULT false,
    "joinUrl" TEXT,
    "status" "CalendarEventStatus" NOT NULL DEFAULT 'CONFIRMED',
    "busy" BOOLEAN NOT NULL DEFAULT true,
    "isOrganizer" BOOLEAN NOT NULL DEFAULT false,
    "organizerEmail" TEXT,
    "attendees" JSONB NOT NULL DEFAULT '[]',
    "fromDeskzo" BOOLEAN NOT NULL DEFAULT false,
    "companyId" TEXT,
    "contactId" TEXT,
    "leadId" TEXT,
    "ticketId" TEXT,
    "visitId" TEXT,
    "heldLoggedAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calendar_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "calendar_accounts_userId_key" ON "calendar_accounts"("userId");

-- CreateIndex
CREATE INDEX "calendar_accounts_nextSyncAt_idx" ON "calendar_accounts"("nextSyncAt");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_events_visitId_key" ON "calendar_events"("visitId");

-- CreateIndex
CREATE INDEX "calendar_events_userId_startsAt_idx" ON "calendar_events"("userId", "startsAt");

-- CreateIndex
CREATE INDEX "calendar_events_companyId_idx" ON "calendar_events"("companyId");

-- CreateIndex
CREATE INDEX "calendar_events_contactId_idx" ON "calendar_events"("contactId");

-- CreateIndex
CREATE INDEX "calendar_events_leadId_idx" ON "calendar_events"("leadId");

-- CreateIndex
CREATE INDEX "calendar_events_ticketId_idx" ON "calendar_events"("ticketId");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_events_userId_externalId_key" ON "calendar_events"("userId", "externalId");

-- AddForeignKey
ALTER TABLE "calendar_accounts" ADD CONSTRAINT "calendar_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "visits"("id") ON DELETE SET NULL ON UPDATE CASCADE;


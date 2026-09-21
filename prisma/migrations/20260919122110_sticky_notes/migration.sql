-- CreateEnum
CREATE TYPE "StickyNoteColor" AS ENUM ('YELLOW', 'GREEN', 'BLUE', 'PINK', 'PURPLE', 'ORANGE', 'GREY');

-- CreateEnum
CREATE TYPE "StickyNoteVisibility" AS ENUM ('PRIVATE', 'TEAM', 'EVERYONE');

-- CreateTable
CREATE TABLE "sticky_notes" (
    "id" TEXT NOT NULL,
    "noteSeq" SERIAL NOT NULL,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "color" "StickyNoteColor" NOT NULL DEFAULT 'YELLOW',
    "visibility" "StickyNoteVisibility" NOT NULL DEFAULT 'PRIVATE',
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "ownerUserId" TEXT NOT NULL,
    "companyId" TEXT,
    "leadId" TEXT,
    "ticketId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sticky_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sticky_notes_noteSeq_key" ON "sticky_notes"("noteSeq");

-- CreateIndex
CREATE INDEX "sticky_notes_ownerUserId_archivedAt_idx" ON "sticky_notes"("ownerUserId", "archivedAt");

-- CreateIndex
CREATE INDEX "sticky_notes_visibility_archivedAt_idx" ON "sticky_notes"("visibility", "archivedAt");

-- CreateIndex
CREATE INDEX "sticky_notes_companyId_idx" ON "sticky_notes"("companyId");

-- CreateIndex
CREATE INDEX "sticky_notes_leadId_idx" ON "sticky_notes"("leadId");

-- CreateIndex
CREATE INDEX "sticky_notes_ticketId_idx" ON "sticky_notes"("ticketId");

-- AddForeignKey
ALTER TABLE "sticky_notes" ADD CONSTRAINT "sticky_notes_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sticky_notes" ADD CONSTRAINT "sticky_notes_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sticky_notes" ADD CONSTRAINT "sticky_notes_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sticky_notes" ADD CONSTRAINT "sticky_notes_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A contact who has left their company (owner, 8 Oct 2026): kept with their history, out of everything new.
-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "leftAt" TIMESTAMP(3);

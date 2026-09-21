-- CreateEnum
CREATE TYPE "VisitorPurpose" AS ENUM ('MEETING', 'INTERVIEW', 'DELIVERY', 'VENDOR', 'OTHER');

-- CreateEnum
CREATE TYPE "VisitorStatus" AS ENUM ('IN', 'OUT', 'ABANDONED');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'VISITOR_ARRIVED';

-- CreateTable
CREATE TABLE "visitor_kiosks" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visitor_kiosks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visitor_entries" (
    "id" TEXT NOT NULL,
    "kioskId" TEXT,
    "purpose" "VisitorPurpose" NOT NULL DEFAULT 'MEETING',
    "hostUserId" TEXT,
    "departmentId" TEXT,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "company" TEXT,
    "email" TEXT,
    "note" TEXT,
    "photoDataUrl" TEXT,
    "checkedInAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkedOutAt" TIMESTAMP(3),
    "status" "VisitorStatus" NOT NULL DEFAULT 'IN',
    "closedById" TEXT,
    "badgeNo" INTEGER,

    CONSTRAINT "visitor_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visitor_companions" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "photoDataUrl" TEXT,

    CONSTRAINT "visitor_companions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "visitor_kiosks_token_key" ON "visitor_kiosks"("token");

-- CreateIndex
CREATE INDEX "visitor_entries_checkedInAt_idx" ON "visitor_entries"("checkedInAt");

-- CreateIndex
CREATE INDEX "visitor_entries_hostUserId_idx" ON "visitor_entries"("hostUserId");

-- CreateIndex
CREATE INDEX "visitor_entries_status_idx" ON "visitor_entries"("status");

-- CreateIndex
CREATE INDEX "visitor_companions_entryId_idx" ON "visitor_companions"("entryId");

-- AddForeignKey
ALTER TABLE "visitor_kiosks" ADD CONSTRAINT "visitor_kiosks_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visitor_entries" ADD CONSTRAINT "visitor_entries_kioskId_fkey" FOREIGN KEY ("kioskId") REFERENCES "visitor_kiosks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visitor_entries" ADD CONSTRAINT "visitor_entries_hostUserId_fkey" FOREIGN KEY ("hostUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visitor_entries" ADD CONSTRAINT "visitor_entries_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visitor_entries" ADD CONSTRAINT "visitor_entries_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visitor_companions" ADD CONSTRAINT "visitor_companions_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "visitor_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

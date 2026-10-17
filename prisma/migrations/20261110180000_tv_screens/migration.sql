-- TV screens (owner, 17 Oct 2026): a TV paired by a code, showing one board (a branch's wins, or everybody's)
-- with no user and no seat; and the short-lived pairings that hand a TV its screen. Expand-only.

-- CreateEnum
CREATE TYPE "TvBoard" AS ENUM ('WINS');

-- CreateTable
CREATE TABLE "tv_screens" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "board" "TvBoard" NOT NULL DEFAULT 'WINS',
    "branchId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "lastSeenIp" TEXT,
    "pairedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tv_screens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tv_pairings" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "deviceKeyHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "screenId" TEXT,
    "secret" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tv_pairings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tv_screens_tokenHash_key" ON "tv_screens"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "tv_pairings_code_key" ON "tv_pairings"("code");

-- CreateIndex
CREATE UNIQUE INDEX "tv_pairings_deviceKeyHash_key" ON "tv_pairings"("deviceKeyHash");

-- AddForeignKey
ALTER TABLE "tv_screens" ADD CONSTRAINT "tv_screens_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tv_screens" ADD CONSTRAINT "tv_screens_pairedById_fkey" FOREIGN KEY ("pairedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


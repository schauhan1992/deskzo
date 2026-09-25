-- CreateTable
CREATE TABLE "reference_syncs" (
    "key" TEXT NOT NULL,
    "apiKeyCipher" TEXT,
    "status" TEXT NOT NULL DEFAULT 'IDLE',
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "fetched" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER,
    "message" TEXT,
    "startedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reference_syncs_pkey" PRIMARY KEY ("key")
);

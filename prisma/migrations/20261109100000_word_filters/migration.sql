-- Words kept out of chat and tickets (owner, 15 Oct 2026): one row per area, CHAT or TICKETS.

-- CreateTable
CREATE TABLE "word_filters" (
    "area" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "usePreset" BOOLEAN NOT NULL DEFAULT true,
    "words" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowed" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "word_filters_pkey" PRIMARY KEY ("area")
);

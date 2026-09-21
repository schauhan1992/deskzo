-- The running serial for journal entries, one row per financial year.
--
-- Numbers were derived as max(entryNumber)+1, taken lexicographically, so "JV/2026-27/9999" ranked
-- above "JV/2026-27/10000" and the number stopped advancing at ten thousand — after which every
-- posting in that year failed on the unique index. Two concurrent writers also read the same
-- maximum and collided. A counter row fixes both.
CREATE TABLE "journal_counters" (
    "financialYear" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "journal_counters_pkey" PRIMARY KEY ("financialYear")
);

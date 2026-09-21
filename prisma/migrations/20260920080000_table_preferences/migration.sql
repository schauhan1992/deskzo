-- CreateTable
CREATE TABLE "table_preferences" (
    "userId" TEXT NOT NULL,
    "tableKey" TEXT NOT NULL,
    "columns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "table_preferences_pkey" PRIMARY KEY ("userId","tableKey")
);

-- AddForeignKey
ALTER TABLE "table_preferences" ADD CONSTRAINT "table_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


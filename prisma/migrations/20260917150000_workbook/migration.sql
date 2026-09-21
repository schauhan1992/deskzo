-- CreateTable
CREATE TABLE "workbooks" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "filters" JSONB NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "shared" BOOLEAN NOT NULL DEFAULT true,
    "lastOpenedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workbooks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workbooks_ownerUserId_idx" ON "workbooks"("ownerUserId");

-- CreateIndex
CREATE INDEX "workbooks_shared_idx" ON "workbooks"("shared");

-- AddForeignKey
ALTER TABLE "workbooks" ADD CONSTRAINT "workbooks_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


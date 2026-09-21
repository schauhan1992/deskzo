-- CreateTable
CREATE TABLE "workbook_assignees" (
    "workbookId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assignedByUserId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "workbook_assignees_pkey" PRIMARY KEY ("workbookId","userId")
);

-- CreateIndex
CREATE INDEX "workbook_assignees_userId_idx" ON "workbook_assignees"("userId");

-- AddForeignKey
ALTER TABLE "workbook_assignees" ADD CONSTRAINT "workbook_assignees_workbookId_fkey" FOREIGN KEY ("workbookId") REFERENCES "workbooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_assignees" ADD CONSTRAINT "workbook_assignees_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_assignees" ADD CONSTRAINT "workbook_assignees_assignedByUserId_fkey" FOREIGN KEY ("assignedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


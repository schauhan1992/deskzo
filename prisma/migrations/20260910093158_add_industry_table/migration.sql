-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "industryId" TEXT;

-- CreateTable
CREATE TABLE "industries" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "industries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "industries_name_key" ON "industries"("name");

-- AddForeignKey
ALTER TABLE "companies" ADD CONSTRAINT "companies_industryId_fkey" FOREIGN KEY ("industryId") REFERENCES "industries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "EmailCheckStatus" AS ENUM ('UNCHECKED', 'VALID', 'RISKY', 'INVALID');

-- CreateEnum
CREATE TYPE "EmailCheckMethod" AS ENUM ('AUTOMATIC', 'CONFIRMED', 'REPORTED');

-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "emailCheckDetail" TEXT,
ADD COLUMN     "emailCheckMethod" "EmailCheckMethod",
ADD COLUMN     "emailCheckedAt" TIMESTAMP(3),
ADD COLUMN     "emailCheckedByUserId" TEXT,
ADD COLUMN     "emailCheckedValue" TEXT,
ADD COLUMN     "emailStatus" "EmailCheckStatus" NOT NULL DEFAULT 'UNCHECKED';

-- CreateIndex
CREATE INDEX "contacts_emailStatus_idx" ON "contacts"("emailStatus");

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_emailCheckedByUserId_fkey" FOREIGN KEY ("emailCheckedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


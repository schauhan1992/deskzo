-- CreateEnum
CREATE TYPE "CustomerNoticeKind" AS ENUM ('RENEWAL', 'FULFILMENT');

-- AlterTable
ALTER TABLE "marketing_messages" ADD COLUMN     "companyProductId" TEXT,
ADD COLUMN     "noticeKind" "CustomerNoticeKind",
ADD COLUMN     "sentByUserId" TEXT;

-- AddForeignKey
ALTER TABLE "marketing_messages" ADD CONSTRAINT "marketing_messages_sentByUserId_fkey" FOREIGN KEY ("sentByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_messages" ADD CONSTRAINT "marketing_messages_companyProductId_fkey" FOREIGN KEY ("companyProductId") REFERENCES "company_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

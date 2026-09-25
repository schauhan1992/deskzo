-- CreateEnum
CREATE TYPE "RenewalStage" AS ENUM ('NOT_STARTED', 'TASK_RAISED', 'CONTACTED', 'QUOTED', 'NEGOTIATING', 'ON_HOLD', 'LOST', 'RENEWED');

-- AlterTable
ALTER TABLE "company_products" ADD COLUMN     "renewalStage" "RenewalStage",
ADD COLUMN     "renewalStageAt" TIMESTAMP(3),
ADD COLUMN     "renewalStageById" TEXT,
ADD COLUMN     "renewalStageNote" TEXT;

-- AddForeignKey
ALTER TABLE "company_products" ADD CONSTRAINT "company_products_renewalStageById_fkey" FOREIGN KEY ("renewalStageById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

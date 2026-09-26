-- AlterTable
ALTER TABLE "platform_users" ADD COLUMN     "passwordSetupExpiresAt" TIMESTAMP(3),
ADD COLUMN     "passwordSetupHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "platform_users_passwordSetupHash_key" ON "platform_users"("passwordSetupHash");


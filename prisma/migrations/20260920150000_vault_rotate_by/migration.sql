-- AlterTable
ALTER TABLE "vault_credentials" ADD COLUMN     "rotateBy" TIMESTAMP(3),
ADD COLUMN     "rotateReason" TEXT;

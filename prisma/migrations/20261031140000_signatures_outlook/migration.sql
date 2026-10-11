-- AlterTable
ALTER TABLE "signature_settings" ADD COLUMN     "outlookAddinId" TEXT,
ADD COLUMN     "outlookOn" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "outlookReplaceOwn" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "signature_outlook" (
    "userId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signature_outlook_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "signature_outlook" ADD CONSTRAINT "signature_outlook_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

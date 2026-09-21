-- AlterTable
ALTER TABLE "users" ADD COLUMN     "photoUpdatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "user_photos" (
    "userId" TEXT NOT NULL,
    "dataUrl" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_photos_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "user_photos" ADD CONSTRAINT "user_photos_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- CreateEnum
CREATE TYPE "BackupKind" AS ENUM ('FULL', 'INCREMENTAL');

-- AlterTable
ALTER TABLE "backups" ADD COLUMN     "kind" "BackupKind" NOT NULL DEFAULT 'FULL',
ADD COLUMN     "storedBytes" BIGINT;

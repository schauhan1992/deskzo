-- A switch to Deskzo partway through the financial year (owner, 24 Oct 2026): the MIGRATED document origin, and
-- the migration, its files, what it made and the old system's month-end balances. New tables and an enum value only.

-- CreateEnum
CREATE TYPE "MigrationStatus" AS ENUM ('OPEN', 'FINISHED', 'UNDONE');

-- AlterEnum
ALTER TYPE "DocumentOrigin" ADD VALUE 'MIGRATED';

-- CreateTable
CREATE TABLE "books_migrations" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "yearStart" DATE NOT NULL,
    "switchDate" DATE NOT NULL,
    "status" "MigrationStatus" NOT NULL DEFAULT 'OPEN',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedById" TEXT,
    "finishedAt" TIMESTAMP(3),
    "undoneById" TEXT,
    "undoneAt" TIMESTAMP(3),
    "counts" JSONB,

    CONSTRAINT "books_migrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "books_migration_files" (
    "id" TEXT NOT NULL,
    "migrationId" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "rows" JSONB NOT NULL,
    "units" INTEGER NOT NULL,
    "done" INTEGER NOT NULL DEFAULT 0,
    "failures" JSONB,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "books_migration_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "books_migration_records" (
    "id" TEXT NOT NULL,
    "migrationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "books_migration_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "books_migration_balances" (
    "id" TEXT NOT NULL,
    "migrationId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "balance" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "books_migration_balances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "books_migrations_status_idx" ON "books_migrations"("status");

-- CreateIndex
CREATE INDEX "books_migration_files_migrationId_step_idx" ON "books_migration_files"("migrationId", "step");

-- CreateIndex
CREATE INDEX "books_migration_records_migrationId_kind_idx" ON "books_migration_records"("migrationId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "books_migration_records_kind_recordId_key" ON "books_migration_records"("kind", "recordId");

-- CreateIndex
CREATE UNIQUE INDEX "books_migration_records_migrationId_kind_key_key" ON "books_migration_records"("migrationId", "kind", "key");

-- CreateIndex
CREATE UNIQUE INDEX "books_migration_balances_migrationId_month_accountId_key" ON "books_migration_balances"("migrationId", "month", "accountId");

-- AddForeignKey
ALTER TABLE "books_migration_files" ADD CONSTRAINT "books_migration_files_migrationId_fkey" FOREIGN KEY ("migrationId") REFERENCES "books_migrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "books_migration_records" ADD CONSTRAINT "books_migration_records_migrationId_fkey" FOREIGN KEY ("migrationId") REFERENCES "books_migrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "books_migration_balances" ADD CONSTRAINT "books_migration_balances_migrationId_fkey" FOREIGN KEY ("migrationId") REFERENCES "books_migrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


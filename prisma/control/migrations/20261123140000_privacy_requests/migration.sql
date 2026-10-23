-- Privacy requests from the public site (owner, 23 Oct 2026): access, correction, erasure, withdrawing consent,
-- nominating someone, a grievance — handled in the console, due 30 days after they come in.

-- CreateEnum
CREATE TYPE "PrivacyRequestKind" AS ENUM ('ACCESS', 'CORRECTION', 'ERASURE', 'WITHDRAW_CONSENT', 'NOMINATE', 'GRIEVANCE', 'OTHER');

-- CreateEnum
CREATE TYPE "PrivacyRequestStatus" AS ENUM ('NEW', 'IN_PROGRESS', 'DONE', 'REFUSED');

-- CreateTable
CREATE TABLE "privacy_requests" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "kind" "PrivacyRequestKind" NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "company" TEXT,
    "message" TEXT NOT NULL,
    "status" "PrivacyRequestStatus" NOT NULL DEFAULT 'NEW',
    "notes" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "handledBy" TEXT,

    CONSTRAINT "privacy_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "privacy_requests_seq_key" ON "privacy_requests"("seq");

-- CreateIndex
CREATE INDEX "privacy_requests_status_createdAt_idx" ON "privacy_requests"("status", "createdAt");

-- Access levels (docs/permission-redesign.md, phase 1): how far a role or a person reaches over a
-- record type and action. Expand-only — two new tables and an enum; nothing existing changes, and
-- no row is the normal state (src/lib/authz/access.ts derives today's answer when there is none).
-- CreateEnum
CREATE TYPE "AccessLevel" AS ENUM ('NONE', 'OWN', 'TEAM', 'BRANCH', 'ALL', 'FOLLOW');

-- CreateTable
CREATE TABLE "role_access_levels" (
    "role" TEXT NOT NULL,
    "record" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "level" "AccessLevel" NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "role_access_levels_pkey" PRIMARY KEY ("role","record","action")
);

-- CreateTable
CREATE TABLE "user_access_levels" (
    "userId" TEXT NOT NULL,
    "record" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "level" "AccessLevel" NOT NULL,
    "reason" TEXT,
    "grantedById" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_access_levels_pkey" PRIMARY KEY ("userId","record","action")
);

-- CreateIndex
CREATE INDEX "user_access_levels_expiresAt_idx" ON "user_access_levels"("expiresAt");

-- AddForeignKey
ALTER TABLE "role_access_levels" ADD CONSTRAINT "role_access_levels_role_fkey" FOREIGN KEY ("role") REFERENCES "roles"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_access_levels" ADD CONSTRAINT "user_access_levels_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_access_levels" ADD CONSTRAINT "user_access_levels_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

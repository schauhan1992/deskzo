-- CreateEnum
CREATE TYPE "PermissionSubjectType" AS ENUM ('ROLE', 'USER');

-- CreateEnum
CREATE TYPE "PermissionChangeKind" AS ENUM ('GRANT', 'REVOKE', 'RESET_TO_DEFAULT', 'PRESET_APPLIED', 'ROLE_ASSIGNED', 'MANAGER_CHANGED', 'DEPARTMENT_CHANGED', 'USER_CREATED', 'USER_ACTIVATED', 'USER_DEACTIVATED', 'TWO_FACTOR_RESET', 'SUPER_ADMIN_GRANTED', 'SUPER_ADMIN_REVOKED');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "isSuperAdmin" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "user_permissions" (
    "userId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "allowed" BOOLEAN NOT NULL,
    "reason" TEXT,
    "grantedById" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_permissions_pkey" PRIMARY KEY ("userId","permission")
);

-- CreateTable
CREATE TABLE "permission_changes" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "impersonatedByUserId" TEXT,
    "subjectType" "PermissionSubjectType" NOT NULL,
    "subjectRole" "Role",
    "subjectUserId" TEXT,
    "permission" TEXT,
    "fromAllowed" BOOLEAN,
    "toAllowed" BOOLEAN,
    "changeKind" "PermissionChangeKind" NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permission_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_permissions_permission_idx" ON "user_permissions"("permission");

-- CreateIndex
CREATE INDEX "user_permissions_expiresAt_idx" ON "user_permissions"("expiresAt");

-- CreateIndex
CREATE INDEX "permission_changes_subjectUserId_createdAt_idx" ON "permission_changes"("subjectUserId", "createdAt");

-- CreateIndex
CREATE INDEX "permission_changes_subjectRole_createdAt_idx" ON "permission_changes"("subjectRole", "createdAt");

-- CreateIndex
CREATE INDEX "permission_changes_permission_createdAt_idx" ON "permission_changes"("permission", "createdAt");

-- CreateIndex
CREATE INDEX "permission_changes_createdAt_idx" ON "permission_changes"("createdAt");

-- CreateIndex
CREATE INDEX "companies_ownerUserId_idx" ON "companies"("ownerUserId");

-- CreateIndex
CREATE INDEX "leads_ownerUserId_idx" ON "leads"("ownerUserId");

-- AddForeignKey
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "permission_changes" ADD CONSTRAINT "permission_changes_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "permission_changes" ADD CONSTRAINT "permission_changes_subjectUserId_fkey" FOREIGN KEY ("subjectUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------------
-- The super-admin invariant, and bootstrapping the first one.
-- ---------------------------------------------------------------------------------------------

-- A super admin is always also an ADMIN. Every one of the ~77 `role === "ADMIN"` comparisons in
-- src/ therefore keeps admitting them, which is what makes this column additive rather than a
-- rewrite. Enforced in the database because it is the assumption all of that code rests on.
ALTER TABLE "users" ADD CONSTRAINT "users_super_admin_is_admin"
  CHECK (NOT "isSuperAdmin" OR "role" = 'ADMIN');

-- Abort rather than guess if any live role is not one the application knows about. This is the
-- ROLES-omits-PURCHASE bug in miniature: a value present in the database and absent from the code
-- is invisible, and a migration is the worst place to discover one.
DO $$
DECLARE unmapped text;
BEGIN
  SELECT string_agg(DISTINCT "role"::text, ', ') INTO unmapped
  FROM "users"
  WHERE "role"::text NOT IN ('ADMIN','PROFILE','CALLING','SALES','SUPPORT','MANAGEMENT','ACCOUNTS','PURCHASE');
  IF unmapped IS NOT NULL THEN
    RAISE EXCEPTION 'Users hold roles the application does not map: %', unmapped;
  END IF;
END $$;

-- The oldest active admin becomes the first super admin, so the system is never in a state with
-- nobody able to administer it. `scripts/grant-super-admin.ts` is the break-glass path if this
-- picks the wrong account or none exists.
UPDATE "users" SET "isSuperAdmin" = true
WHERE "id" = (
  SELECT "id" FROM "users"
  WHERE "role" = 'ADMIN' AND "active" = true
  ORDER BY "createdAt" ASC
  LIMIT 1
);

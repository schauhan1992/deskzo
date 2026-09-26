-- CreateEnum
CREATE TYPE "UserKind" AS ENUM ('MEMBER', 'SUPPORT');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "kind" "UserKind" NOT NULL DEFAULT 'MEMBER';


-- The platform's support staff never hold the super admin's powers, however they are let in.
ALTER TABLE "users" ADD CONSTRAINT "users_support_is_never_super_admin" CHECK ("kind" = 'MEMBER' OR "isSuperAdmin" = false);

-- The role a read-only support grant signs staff in with. Its permissions are computed — every
-- "view" permission and nothing else (src/lib/authz/resolve.ts) — so nothing is seeded for it, and it
-- is left out of every list of roles (src/lib/db.ts).
INSERT INTO "roles" ("key", "name", "description", "isSystem", "sortOrder", "updatedAt") VALUES
  ('SUPPORT_READONLY', 'Support (read-only)', 'The platform''s support staff, let in by a read-only grant: may look, not change.', true, 1000, now())
ON CONFLICT ("key") DO NOTHING;

-- Roles become data.
--
-- They were a Postgres enum, so adding one meant editing the schema, writing a migration and
-- deploying. In practice that means nobody adds one: people get the nearest existing role plus a
-- handful of personal exceptions, and the exception list — which exists for the genuinely individual
-- case — quietly becomes the place roles are defined.
--
-- ## Why the column stays a string
--
-- `users.role` and `role_permissions.role` become plain text referencing `roles.key`, rather than
-- integer ids referencing `roles.id`. That keeps every existing comparison working exactly as it
-- did: the thirty `role = 'ADMIN'` tests in the application, the `users_super_admin_is_admin` CHECK
-- constraint added in 20260920070000, and all sixteen built-in presets. An id-based relation would
-- have required loading the role row on every query that only wants to know "is this an admin".
--
-- The cost is that a key is immutable — it is a foreign key in two tables. That is fine, because
-- renaming is done on `name`, which nothing points at.

CREATE TABLE "roles" (
  "key"         TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  "isSystem"    BOOLEAN NOT NULL DEFAULT false,
  "sortOrder"   INTEGER NOT NULL DEFAULT 100,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "roles_pkey" PRIMARY KEY ("key")
);

-- The eight the application shipped with, in the order the access screen has always shown them.
-- Marked as system roles: renameable and re-permissionable like any other, but not deletable.
INSERT INTO "roles" ("key", "name", "description", "isSystem", "sortOrder", "updatedAt") VALUES
  ('ADMIN',      'Admin',       'Administers the system. The permission resolver and the super-admin constraint both name this role, so it cannot be deleted or renamed away from.', true, 10, now()),
  ('MANAGEMENT', 'Management',  'Leadership visibility across the business.', true, 20, now()),
  ('SALES',      'Sales',       'Sells to customers and owns accounts.',      true, 30, now()),
  ('CALLING',    'Calling',     'Works call lists and books meetings.',        true, 40, now()),
  ('PROFILE',    'Profiling',   'Builds and cleans the customer record.',      true, 50, now()),
  ('SUPPORT',    'Support',     'Answers tickets and looks after customers after the sale.', true, 60, now()),
  ('ACCOUNTS',   'Accounts',    'Invoicing, payments, reconciliation and the ledger.', true, 70, now()),
  ('PURCHASE',   'Purchase',    'Buys from vendors and reconciles what they bill.',  true, 80, now());

-- ── Four columns, enum to text ─────────────────────────────────────────────────────────────────
--
-- The CHECK constraint has to go first. Postgres stores its expression with the literal already
-- typed — `role = 'ADMIN'::"Role"` — so rewriting the column underneath it fails with
-- `operator does not exist: text = "Role"`, which names neither the constraint nor the reason.
-- It is recreated below against text, where it means exactly what it meant before.
ALTER TABLE "users" DROP CONSTRAINT "users_super_admin_is_admin";

-- `USING "role"::text` preserves every existing value exactly; nobody's role changes.
ALTER TABLE "users"              ALTER COLUMN "role"        TYPE TEXT USING "role"::text;
ALTER TABLE "role_permissions"   ALTER COLUMN "role"        TYPE TEXT USING "role"::text;
ALTER TABLE "candidates"         ALTER COLUMN "role"        TYPE TEXT USING "role"::text;
ALTER TABLE "permission_changes" ALTER COLUMN "subjectRole" TYPE TEXT USING "subjectRole"::text;
-- An array of the enum, which the dependency query above missed on the first pass because the
-- column type is "Role"[] rather than "Role". Nothing referencing the type may survive the DROP.
ALTER TABLE "security_policy"  ALTER COLUMN "exemptRoles" DROP DEFAULT;
ALTER TABLE "security_policy"  ALTER COLUMN "exemptRoles" TYPE TEXT[] USING "exemptRoles"::text[];
ALTER TABLE "security_policy"  ALTER COLUMN "exemptRoles" SET DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "candidates" ALTER COLUMN "role" SET DEFAULT 'SALES';

ALTER TABLE "users"
  ADD CONSTRAINT "users_super_admin_is_admin"
  CHECK (NOT "isSuperAdmin" OR "role" = 'ADMIN');

-- Anything pointing at a role that is not one of the eight above would be orphaned by the foreign
-- keys below. Say so here rather than failing on a constraint that names only a column.
DO $$
DECLARE strays text;
BEGIN
  SELECT string_agg(DISTINCT r, ', ') INTO strays FROM (
    SELECT "role" AS r FROM "users"
    UNION SELECT "role" FROM "role_permissions"
    UNION SELECT "role" FROM "candidates"
  ) all_refs WHERE r NOT IN (SELECT "key" FROM "roles");
  IF strays IS NOT NULL THEN
    RAISE EXCEPTION 'Rows reference roles that do not exist: %. Add them to the seed above before applying.', strays;
  END IF;
END $$;

-- ── Three references, three different answers about deletion ───────────────────────────────────
--
-- RESTRICT on users and candidates: a role somebody still holds, or is about to be hired into,
-- cannot be deleted — move them first. CASCADE on role_permissions: those rows describe the role
-- and mean nothing without it, so they go with it.
--
-- `permission_changes.subjectRole` gets no foreign key at all. It is the audit trail, and it has to
-- go on naming a role after that role is gone; a reference would either take the history with it or
-- make the role undeletable for ever.
ALTER TABLE "users"
  ADD CONSTRAINT "users_role_fkey" FOREIGN KEY ("role") REFERENCES "roles"("key")
  ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "candidates"
  ADD CONSTRAINT "candidates_role_fkey" FOREIGN KEY ("role") REFERENCES "roles"("key")
  ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "role_permissions"
  ADD CONSTRAINT "role_permissions_role_fkey" FOREIGN KEY ("role") REFERENCES "roles"("key")
  ON UPDATE CASCADE ON DELETE CASCADE;

DROP TYPE "Role";

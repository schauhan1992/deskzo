-- ---------------------------------------------------------------------------------------------
-- A super admin cannot be deleted, and the last one cannot be demoted away.
--
-- Enforced in the database rather than the application, deliberately. The app has no delete-user
-- feature at all, so every way a user row can actually disappear today — Prisma Studio, psql, a
-- migration, a script somebody writes next year — goes nowhere near the guards in
-- src/lib/authz/guards.ts. A rule that only holds inside the application is not a rule about the
-- data; it is a rule about one client of the data.
-- ---------------------------------------------------------------------------------------------

-- 1. Deleting a super admin is refused outright.
--
-- Not "refused unless they are the last one". A super admin is the tier that cannot be locked out,
-- and making the delete conditional would mean the protection quietly disappears the moment a
-- second one is added — exactly when somebody is most likely to be tidying up. To remove one,
-- revoke the flag first (which trigger 2 guards), then delete the ordinary account that remains.
-- Two steps, neither of which can strand the installation with nobody in charge.
CREATE OR REPLACE FUNCTION refuse_super_admin_delete() RETURNS trigger AS $$
BEGIN
  IF OLD."isSuperAdmin" THEN
    RAISE EXCEPTION
      'Refusing to delete super admin % (%). Revoke super admin access first, then delete the account.',
      OLD."name", OLD."email"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_refuse_super_admin_delete
  BEFORE DELETE ON "users"
  FOR EACH ROW EXECUTE FUNCTION refuse_super_admin_delete();

-- 2. The last active super admin cannot be demoted, deactivated, or moved off the ADMIN role.
--
-- Mirrors assertSuperAdminRemains() in the application, which covers the three routes the UI
-- offers. This covers the same three from anywhere else. Row-level and conditional on the OLD row
-- having been an active super admin, so it never fires while setting the first one up, and a
-- swap inside one transaction — promote the replacement, then demote the incumbent — still works.
CREATE OR REPLACE FUNCTION require_remaining_super_admin() RETURNS trigger AS $$
DECLARE
  others integer;
BEGIN
  IF OLD."isSuperAdmin" AND OLD."active"
     AND NOT (NEW."isSuperAdmin" AND NEW."active" AND NEW."role" = 'ADMIN') THEN
    SELECT count(*) INTO others
    FROM "users"
    WHERE "isSuperAdmin" AND "active" AND "role" = 'ADMIN' AND "id" <> OLD."id";

    IF others = 0 THEN
      RAISE EXCEPTION
        'Refusing: % (%) is the only active super admin, and nobody could restore the access this removes.',
        OLD."name", OLD."email"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_require_remaining_super_admin
  BEFORE UPDATE ON "users"
  FOR EACH ROW EXECUTE FUNCTION require_remaining_super_admin();

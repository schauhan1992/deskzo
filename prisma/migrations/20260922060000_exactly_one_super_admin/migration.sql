-- Exactly one super admin, enforced by the database.
--
-- The super admin is the account every permission check short-circuits for
-- (`src/lib/authz/resolve.ts`): it holds everything unconditionally, no permission row is consulted
-- for it, and it cannot be impersonated. That is a reasonable thing for *one* account to be and an
-- unreasonable thing for an unbounded set of them to be — the more accounts that bypass the
-- permission system, the less the permission system describes who can do what.
--
-- Two halves, and neither is sufficient alone:
--
--   · The trigger `users_require_remaining_super_admin`, already in place, refuses to remove the
--     last one. That is the floor.
--   · The partial unique index below refuses to create a second. That is the ceiling.
--
-- Floor and ceiling at one: exactly one, always, with no window in between where a migration, a
-- script or a future action could leave none or three.
--
-- A partial unique index on a constant-valued expression is the standard way to say "at most one
-- row satisfying this predicate". Every row where `isSuperAdmin` is true indexes the same value, so
-- the second one collides. Rows where it is false are not indexed at all and are unconstrained,
-- which is the whole population of ordinary users. Prisma has no syntax for a filtered index, so
-- this lives here rather than in schema.prisma — the same reason
-- `company_locations_one_primary_per_company` does.

-- Fails loudly and says who, rather than failing on the index build with a duplicate-key error that
-- names a row id and nothing a person can act on.
-- Zero is fine here and one is fine; only "more than one" blocks the index.
--
-- The first version of this guard also refused zero, on the reasoning that a database with no super
-- admin cannot reach its own access screens. True, and the wrong place to say it: a migration runs
-- against an empty database before any user exists, so refusing zero meant `migrate deploy` failed
-- on every fresh environment — including the replay that `check:migrations` performs, which is how
-- it was caught. Having nobody is `scripts/bootstrap-admin.ts`'s problem, and it already refuses to
-- run against a database that has accounts.
DO $$
DECLARE holders text;
DECLARE n int;
BEGIN
  SELECT count(*), string_agg("email", ', ' ORDER BY "email") INTO n, holders
  FROM "users" WHERE "isSuperAdmin";

  IF n > 1 THEN
    RAISE EXCEPTION 'More than one account holds super admin (%). Decide which one keeps it and revoke the others before applying.', holders;
  END IF;
END $$;

CREATE UNIQUE INDEX "users_one_super_admin"
  ON "users"(("isSuperAdmin"))
  WHERE "isSuperAdmin";

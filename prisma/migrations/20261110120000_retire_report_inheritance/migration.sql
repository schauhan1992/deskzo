-- Retire capability inheritance from reports (docs/permission-redesign.md, section 7.1 and decision 3,
-- "yes, after the report", 8 Oct 2026).
--
-- Until now a manager also held every delegable permission any active, non-admin person below them
-- held through their role (rule 5 of src/lib/authz/resolve.ts): a privilege nobody granted, which
-- didn't show on the manager's role or page. From this release the reporting line decides whose
-- records count as "Team" and nothing more.
--
-- Nobody loses anything on the day. Each permission a person holds today *only* by inheritance is
-- written here as a grant of their own, with the reason saying where it came from, so it shows on
-- their page as an exception an admin can keep or remove. The code that stops inheriting ships after
-- this has run (migrations run before the code they belong to), and the access snapshot taken before
-- and after (`npm run access:snapshot -- --compare`) is the proof that nothing changed.
--
-- The rows are what rule 5 answered, exactly:
--   · for a person who is active, not the super admin, not an admin, not the Automation account, not
--     platform support, whose role exists and is switched on;
--   · for a delegable permission they don't already have an answer for — no unexpired grant or deny of
--     their own, no row for their role, not held by their role by default;
--   · held by somebody anywhere below them in the reporting line (walked through inactive accounts,
--     32 levels at most, members only) who is active and not an admin, through that person's role:
--     its row where it has one, else the registry's default.
-- The registry's facts (which keys are delegable, which roles hold each by default) are copied below
-- as they are in this release.
--
-- Additive: inserts only. A person's expired grant for the same permission is replaced by the kept
-- one (an expired grant answers nothing today, so rule 5 answered instead). Each kept grant is also
-- written to the permission history, as made by the workspace's Automation account — or, where it has
-- none yet, its super admin — with the detail saying no person made it.

-- Delegable keys, and the roles holding each by default ('*' = everybody, NULL = nobody).
CREATE TEMP TABLE "_retire_defaults" ("permission" TEXT NOT NULL, "role" TEXT);
INSERT INTO "_retire_defaults" ("permission", "role") VALUES
    ('products.edit', 'MANAGEMENT'),
    ('products.edit', 'SALES'),
    ('products.delete', 'MANAGEMENT'),
    ('payments.record', 'ACCOUNTS'),
    ('payments.record', 'MANAGEMENT'),
    ('payments.delete', 'ACCOUNTS'),
    ('payments.delete', 'MANAGEMENT'),
    ('payments.manage', 'ACCOUNTS'),
    ('payments.manage', 'MANAGEMENT'),
    ('contacts.viewRestricted', 'MANAGEMENT'),
    ('contacts.viewRestricted', 'SUPPORT'),
    ('tickets.create', 'SUPPORT'),
    ('tickets.create', 'SALES'),
    ('tickets.create', 'MANAGEMENT'),
    ('notes.broadcast', 'MANAGEMENT'),
    ('tickets.delete', 'MANAGEMENT'),
    ('tasks.delete', 'MANAGEMENT'),
    ('performance.view', 'MANAGEMENT'),
    ('expenses.approve', 'MANAGEMENT'),
    ('expenses.approve', 'ACCOUNTS'),
    ('expenses.reimburse', 'ACCOUNTS'),
    ('expenses.reimburse', 'MANAGEMENT'),
    ('expenses.viewAll', 'MANAGEMENT'),
    ('expenses.viewAll', 'ACCOUNTS'),
    ('visits.viewAll', 'MANAGEMENT'),
    ('documents.issue', 'SALES'),
    ('documents.issue', 'ACCOUNTS'),
    ('documents.issue', 'MANAGEMENT'),
    ('documents.send', 'SALES'),
    ('documents.send', 'ACCOUNTS'),
    ('documents.send', 'MANAGEMENT'),
    ('documents.void', 'ACCOUNTS'),
    ('documents.void', 'MANAGEMENT'),
    ('orders.approve', 'ACCOUNTS'),
    ('orders.approve', 'MANAGEMENT'),
    ('orders.process', 'PURCHASE'),
    ('orders.process', 'MANAGEMENT'),
    ('purchase.raiseOrders', 'PURCHASE'),
    ('purchase.raiseOrders', 'ACCOUNTS'),
    ('purchase.raiseOrders', 'MANAGEMENT'),
    ('orders.approveLoss', 'MANAGEMENT'),
    ('rebates.view', 'MANAGEMENT'),
    ('rebates.view', 'ACCOUNTS'),
    ('rebates.view', 'PURCHASE'),
    ('rebates.manage', 'MANAGEMENT'),
    ('rebates.manage', 'ACCOUNTS'),
    ('hr.manage', 'MANAGEMENT'),
    ('hiring.manage', 'MANAGEMENT'),
    ('visitors.view', 'MANAGEMENT'),
    ('visitors.view', 'SUPPORT'),
    ('visitors.manage', 'MANAGEMENT'),
    ('engagement.manage', 'MANAGEMENT'),
    ('vault.use', 'MANAGEMENT'),
    ('vault.use', 'SALES'),
    ('vault.use', 'SUPPORT'),
    ('vault.use', 'ACCOUNTS'),
    ('vault.use', 'PURCHASE'),
    ('vault.manageTags', 'MANAGEMENT'),
    ('projects.manage', 'MANAGEMENT'),
    ('projects.manage', 'SUPPORT'),
    ('projects.viewAll', 'MANAGEMENT'),
    ('people.handover', 'MANAGEMENT'),
    ('hr.approveLeave', 'MANAGEMENT'),
    ('assets.manage', 'PURCHASE'),
    ('assets.viewAll', 'MANAGEMENT'),
    ('assets.viewAll', 'SUPPORT'),
    ('assets.viewAll', 'PURCHASE'),
    ('feedback.request', 'SALES'),
    ('feedback.request', 'SUPPORT'),
    ('feedback.request', 'MANAGEMENT'),
    ('feedback.viewAll', 'MANAGEMENT'),
    ('marketing.manage', 'MANAGEMENT'),
    ('marketing.send', 'MANAGEMENT'),
    ('marketing.approve', 'MANAGEMENT'),
    ('marketing.viewAll', 'MANAGEMENT'),
    ('marketing.viewAll', 'SALES'),
    ('access.approveDevices', NULL),
    ('access.viewSignIns', NULL),
    ('forecast.manage', 'MANAGEMENT'),
    ('wins.manage', 'MANAGEMENT'),
    ('forms.create', 'MANAGEMENT'),
    ('forms.create', 'SALES'),
    ('forms.manageAll', 'MANAGEMENT'),
    ('targets.manage', 'MANAGEMENT'),
    ('targets.viewAll', 'MANAGEMENT'),
    ('incentives.manage', 'MANAGEMENT'),
    ('incentives.approve', 'ACCOUNTS'),
    ('activity.viewAll', 'MANAGEMENT'),
    ('activities.viewAll', 'MANAGEMENT'),
    ('activity.export', 'MANAGEMENT'),
    ('purchase.reconcile', 'PURCHASE'),
    ('purchase.reconcile', 'ACCOUNTS'),
    ('purchase.reconcile', 'MANAGEMENT'),
    ('catalog.manage', NULL),
    ('close.work', 'ACCOUNTS'),
    ('leads.assign', 'MANAGEMENT'),
    ('leads.assign', 'CALLING'),
    ('contacts.view', 'PROFILE'),
    ('contacts.view', 'CALLING'),
    ('contacts.view', 'SALES'),
    ('contacts.view', 'SUPPORT'),
    ('contacts.view', 'MANAGEMENT'),
    ('contacts.view', 'ACCOUNTS'),
    ('contacts.view', 'PURCHASE'),
    ('emails.view', 'PROFILE'),
    ('emails.view', 'CALLING'),
    ('emails.view', 'SALES'),
    ('emails.view', 'SUPPORT'),
    ('emails.view', 'MANAGEMENT'),
    ('emails.view', 'ACCOUNTS'),
    ('emails.view', 'PURCHASE'),
    ('leads.view', 'PROFILE'),
    ('leads.view', 'CALLING'),
    ('leads.view', 'SALES'),
    ('leads.view', 'SUPPORT'),
    ('leads.view', 'MANAGEMENT'),
    ('leads.view', 'ACCOUNTS'),
    ('leads.view', 'PURCHASE'),
    ('orders.view', 'PROFILE'),
    ('orders.view', 'CALLING'),
    ('orders.view', 'SALES'),
    ('orders.view', 'SUPPORT'),
    ('orders.view', 'MANAGEMENT'),
    ('orders.view', 'ACCOUNTS'),
    ('orders.view', 'PURCHASE'),
    ('payments.view', 'SALES'),
    ('payments.view', 'SUPPORT'),
    ('payments.view', 'MANAGEMENT'),
    ('payments.view', 'ACCOUNTS'),
    ('payments.view', 'PURCHASE'),
    ('collections.followUp', NULL),
    ('credit.override', 'MANAGEMENT'),
    ('credit.override', 'ACCOUNTS'),
    ('documents.view', 'SALES'),
    ('documents.view', 'SUPPORT'),
    ('documents.view', 'MANAGEMENT'),
    ('documents.view', 'ACCOUNTS'),
    ('documents.view', 'PURCHASE'),
    ('projects.view', 'PROFILE'),
    ('projects.view', 'CALLING'),
    ('projects.view', 'SALES'),
    ('projects.view', 'SUPPORT'),
    ('projects.view', 'MANAGEMENT'),
    ('projects.view', 'ACCOUNTS'),
    ('projects.view', 'PURCHASE'),
    ('meetings.schedule', 'PROFILE'),
    ('meetings.schedule', 'CALLING'),
    ('meetings.schedule', 'SALES'),
    ('meetings.schedule', 'SUPPORT'),
    ('meetings.schedule', 'MANAGEMENT'),
    ('meetings.schedule', 'ACCOUNTS'),
    ('meetings.schedule', 'PURCHASE'),
    ('calls.view', 'PROFILE'),
    ('calls.view', 'CALLING'),
    ('calls.view', 'SALES'),
    ('calls.view', 'SUPPORT'),
    ('calls.view', 'MANAGEMENT'),
    ('calls.view', 'ACCOUNTS'),
    ('calls.view', 'PURCHASE'),
    ('visits.view', 'PROFILE'),
    ('visits.view', 'CALLING'),
    ('visits.view', 'SALES'),
    ('visits.view', 'SUPPORT'),
    ('visits.view', 'MANAGEMENT'),
    ('visits.view', 'ACCOUNTS'),
    ('visits.view', 'PURCHASE'),
    ('tickets.view', 'PROFILE'),
    ('tickets.view', 'CALLING'),
    ('tickets.view', 'SALES'),
    ('tickets.view', 'SUPPORT'),
    ('tickets.view', 'MANAGEMENT'),
    ('tickets.view', 'ACCOUNTS'),
    ('tickets.view', 'PURCHASE'),
    ('accounts.reassign', 'MANAGEMENT'),
    ('accounts.handOffOwn', 'SALES'),
    ('accounts.handOffOwn', 'MANAGEMENT'),
    ('workspace.manageAny', NULL),
    ('companies.manageCategories', 'MANAGEMENT'),
    ('copilot.use', 'PROFILE'),
    ('copilot.use', 'CALLING'),
    ('copilot.use', 'SALES'),
    ('copilot.use', 'SUPPORT'),
    ('copilot.use', 'MANAGEMENT'),
    ('copilot.use', 'ACCOUNTS'),
    ('copilot.use', 'PURCHASE'),
    ('help.manage', 'MANAGEMENT'),
    ('fields.manage', 'MANAGEMENT'),
    ('fields.seeRestricted', 'MANAGEMENT'),
    ('pipeline.manage', 'MANAGEMENT'),
    ('booking.manage', 'MANAGEMENT'),
    ('companies.merge', 'MANAGEMENT'),
    ('companies.viewAll', 'MANAGEMENT'),
    ('companies.viewAll', 'ACCOUNTS'),
    ('companies.viewAll', 'PURCHASE'),
    ('companies.viewAll', 'SUPPORT'),
    ('companies.viewAll', 'PROFILE'),
    ('companies.viewAll', 'CALLING');

CREATE TEMP TABLE "_retire_kept" AS
WITH RECURSIVE
  "walk" ("managerId", "reportId", "depth") AS (
    SELECT u."managerId", u."id", 1
    FROM "users" u
    WHERE u."managerId" IS NOT NULL AND u."kind" = 'MEMBER' AND u."id" <> u."managerId"
    UNION
    SELECT w."managerId", u."id", w."depth" + 1
    FROM "walk" w
    JOIN "users" u ON u."managerId" = w."reportId" AND u."kind" = 'MEMBER'
    WHERE w."depth" < 32 AND u."id" <> w."managerId"
  ),
  "reports" AS (
    SELECT DISTINCT w."managerId", r."id" AS "reportId", r."name" AS "reportName", r."role" AS "reportRole"
    FROM "walk" w
    JOIN "users" r ON r."id" = w."reportId"
    WHERE r."active" AND r."role" <> 'ADMIN'
  ),
  "delegable" AS (SELECT DISTINCT "permission" FROM "_retire_defaults"),
  "held" AS (
    -- What each report's role grants: its row where it has one, else the registry's default.
    SELECT rp."managerId", rp."reportName", rp."reportRole", d."permission"
    FROM "reports" rp
    CROSS JOIN "delegable" d
    WHERE COALESCE(
      (SELECT x."allowed" FROM "role_permissions" x WHERE x."role" = rp."reportRole" AND x."permission" = d."permission"),
      EXISTS (SELECT 1 FROM "_retire_defaults" df WHERE df."permission" = d."permission" AND (df."role" = '*' OR df."role" = rp."reportRole"))
    )
  ),
  "subjects" AS (
    SELECT m."id", m."role"
    FROM "users" m
    JOIN "roles" ro ON ro."key" = m."role" AND ro."active"
    WHERE m."active" AND NOT m."isSuperAdmin" AND m."kind" <> 'AUTOMATION'
      AND m."role" <> 'ADMIN' AND m."role" <> 'SUPPORT_READONLY'
  )
SELECT DISTINCT ON (s."id", h."permission")
  s."id" AS "userId", h."permission", h."reportName", h."reportRole"
FROM "subjects" s
JOIN "held" h ON h."managerId" = s."id"
WHERE NOT EXISTS (
    SELECT 1 FROM "user_permissions" up
    WHERE up."userId" = s."id" AND up."permission" = h."permission" AND (up."expiresAt" IS NULL OR up."expiresAt" > CURRENT_TIMESTAMP)
  )
  AND NOT EXISTS (SELECT 1 FROM "role_permissions" x WHERE x."role" = s."role" AND x."permission" = h."permission")
  AND NOT EXISTS (SELECT 1 FROM "_retire_defaults" df WHERE df."permission" = h."permission" AND (df."role" = '*' OR df."role" = s."role"))
ORDER BY s."id", h."permission", h."reportName";

INSERT INTO "user_permissions" ("userId", "permission", "allowed", "reason", "grantedById", "expiresAt", "createdAt", "updatedAt")
SELECT k."userId", k."permission", true,
       'Kept when managers stopped inheriting from their reports (it came through ' || k."reportName" || ', ' || k."reportRole" || ').',
       NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "_retire_kept" k
ON CONFLICT ("userId", "permission") DO UPDATE
  SET "allowed" = true, "reason" = EXCLUDED."reason", "grantedById" = NULL, "expiresAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
  WHERE "user_permissions"."expiresAt" IS NOT NULL AND "user_permissions"."expiresAt" <= CURRENT_TIMESTAMP;

INSERT INTO "permission_changes" ("id", "actorUserId", "subjectType", "subjectUserId", "permission", "fromAllowed", "toAllowed", "changeKind", "detail", "createdAt")
SELECT gen_random_uuid()::text, a."id", 'USER', k."userId", k."permission", NULL, true, 'GRANT',
       'Made explicit when managers stopped inheriting permissions from their reports: they already held it through ' || k."reportName" || ' (' || k."reportRole" || '). Recorded by the migration — no person made this change.',
       CURRENT_TIMESTAMP
FROM "_retire_kept" k
CROSS JOIN LATERAL (
  SELECT u."id" FROM "users" u
  WHERE u."kind" = 'AUTOMATION' OR u."isSuperAdmin"
  ORDER BY (u."kind" = 'AUTOMATION') DESC
  LIMIT 1
) a;

DROP TABLE "_retire_kept";
DROP TABLE "_retire_defaults";

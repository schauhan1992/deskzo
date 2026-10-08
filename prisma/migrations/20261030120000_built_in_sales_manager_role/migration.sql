-- Sales manager as a built-in role (owner, 9 Oct 2026). Executives and managers shared Sales, so a
-- role setting could never give managers more; the difference lived in personal grants nobody could
-- see. Inserted only where no role has the key yet — a workspace's own "Sales manager" is left as it is.
--
-- It starts as the "Sales manager" preset (src/lib/authz/presets.ts), written as role rows, which holds
-- everything a sales executive has; and with the same menu Sales has in this workspace — Sales's
-- ticked and unticked sections are copied, so a manager sees what their team sees. Nobody is moved
-- into it here: who manages is each workspace's to say, on Staff & roles.

WITH new_role AS (
  INSERT INTO "roles" ("key", "name", "description", "isSystem", "sortOrder", "updatedAt") VALUES
    ('SALES_MANAGER', 'Sales manager', 'Sells, and runs a sales team: assigns leads, reassigns accounts, sets targets and sees the team''s work.', true, 35, now())
  ON CONFLICT ("key") DO NOTHING
  RETURNING "key"
),
starting ("role", "permission", "allowed") AS (
  VALUES
    ('SALES_MANAGER', 'accounts.handOffOwn', true),
    ('SALES_MANAGER', 'accounts.reassign', true),
    ('SALES_MANAGER', 'activities.viewAll', true),
    ('SALES_MANAGER', 'calls.view', true),
    ('SALES_MANAGER', 'collections.followUp', true),
    ('SALES_MANAGER', 'companies.manageCategories', true),
    ('SALES_MANAGER', 'companies.merge', true),
    ('SALES_MANAGER', 'contacts.view', true),
    ('SALES_MANAGER', 'copilot.use', true),
    ('SALES_MANAGER', 'documents.issue', true),
    ('SALES_MANAGER', 'documents.send', true),
    ('SALES_MANAGER', 'documents.view', true),
    ('SALES_MANAGER', 'documents.void', true),
    ('SALES_MANAGER', 'emails.view', true),
    ('SALES_MANAGER', 'feedback.request', true),
    ('SALES_MANAGER', 'feedback.viewAll', true),
    ('SALES_MANAGER', 'fields.seeRestricted', true),
    ('SALES_MANAGER', 'forecast.manage', true),
    ('SALES_MANAGER', 'forms.create', true),
    ('SALES_MANAGER', 'leads.assign', true),
    ('SALES_MANAGER', 'leads.view', true),
    ('SALES_MANAGER', 'marketing.send', true),
    ('SALES_MANAGER', 'marketing.viewAll', true),
    ('SALES_MANAGER', 'meetings.schedule', true),
    ('SALES_MANAGER', 'notes.broadcast', true),
    ('SALES_MANAGER', 'orders.view', true),
    ('SALES_MANAGER', 'payments.view', true),
    ('SALES_MANAGER', 'people.handover', true),
    ('SALES_MANAGER', 'performance.view', true),
    ('SALES_MANAGER', 'pipeline.manage', true),
    ('SALES_MANAGER', 'products.delete', true),
    ('SALES_MANAGER', 'products.edit', true),
    ('SALES_MANAGER', 'projects.view', true),
    ('SALES_MANAGER', 'targets.manage', true),
    ('SALES_MANAGER', 'targets.viewAll', true),
    ('SALES_MANAGER', 'tickets.create', true),
    ('SALES_MANAGER', 'tickets.view', true),
    ('SALES_MANAGER', 'vault.use', true),
    ('SALES_MANAGER', 'visits.view', true),
    ('SALES_MANAGER', 'visits.viewAll', true),
    ('SALES_MANAGER', 'wins.manage', true),
    ('SALES_MANAGER', 'workspace.manageAny', true)
),
granted AS (
  INSERT INTO "role_permissions" ("role", "permission", "allowed", "updatedAt")
  SELECT s."role", s."permission", s."allowed", now()
  FROM starting s JOIN new_role n ON n."key" = s."role"
  RETURNING 1
)
INSERT INTO "role_permissions" ("role", "permission", "allowed", "updatedAt")
SELECT n."key", rp."permission", rp."allowed", now()
FROM new_role n JOIN "role_permissions" rp ON rp."role" = 'SALES' AND rp."permission" LIKE 'section.%';

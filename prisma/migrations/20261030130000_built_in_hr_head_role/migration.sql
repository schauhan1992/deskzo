-- HR head as a built-in role (owner, 9 Oct 2026). HR executives and the head of HR shared the HR role,
-- so a role setting could never give the head more; the difference lived in personal grants nobody
-- could see. Inserted only where no role has the key yet — a workspace's own "HR head" is left as it is.
--
-- It starts as the "HR head" preset (src/lib/authz/presets.ts), written as role rows: everything the
-- HR manager preset has, plus company-wide notices, every IT asset, the company's guides, and reading
-- Staff & roles (which, with "Create and edit users", is what lets them add staff accounts). And with
-- HR's starting menu — sections outside people work unticked; everybody's own HR self-service, speak-up,
-- expenses, assets and "My work" kept — with the credential vault left ticked, since the preset uses it.
-- Admins can tick anything back. Nobody is moved into it here: who heads HR is each workspace's to say,
-- on Staff & roles.

WITH new_role AS (
  INSERT INTO "roles" ("key", "name", "description", "isSystem", "sortOrder", "updatedAt") VALUES
    ('HR_HEAD', 'HR head', 'Heads HR: people records, hiring, payroll, leave, user accounts and company-wide notices.', true, 95, now())
  ON CONFLICT ("key") DO NOTHING
  RETURNING "key"
),
starting ("role", "permission", "allowed") AS (
  VALUES
    ('HR_HEAD', 'assets.viewAll', true),
    ('HR_HEAD', 'copilot.use', true),
    ('HR_HEAD', 'data.exportPeople', true),
    ('HR_HEAD', 'data.importPeople', true),
    ('HR_HEAD', 'engagement.manage', true),
    ('HR_HEAD', 'engagement.readFeedback', true),
    ('HR_HEAD', 'expenses.approve', true),
    ('HR_HEAD', 'expenses.viewAll', true),
    ('HR_HEAD', 'help.manage', true),
    ('HR_HEAD', 'hiring.manage', true),
    ('HR_HEAD', 'hr.approveLeave', true),
    ('HR_HEAD', 'hr.manage', true),
    ('HR_HEAD', 'hr.viewAll', true),
    ('HR_HEAD', 'meetings.schedule', true),
    ('HR_HEAD', 'notes.broadcast', true),
    ('HR_HEAD', 'payroll.manage', true),
    ('HR_HEAD', 'people.handover', true),
    ('HR_HEAD', 'performance.view', true),
    ('HR_HEAD', 'permissions.view', true),
    ('HR_HEAD', 'users.manage', true),
    ('HR_HEAD', 'vault.use', true),
    ('HR_HEAD', 'visitors.manage', true),
    ('HR_HEAD', 'visitors.view', true),
    ('HR_HEAD', 'section.companies', false),
    ('HR_HEAD', 'section.items', false),
    ('HR_HEAD', 'section.orders', false),
    ('HR_HEAD', 'section.salesDocuments', false),
    ('HR_HEAD', 'section.purchaseDocuments', false),
    ('HR_HEAD', 'section.renewals', false),
    ('HR_HEAD', 'section.payments', false),
    ('HR_HEAD', 'section.receivables', false),
    ('HR_HEAD', 'section.payables', false),
    ('HR_HEAD', 'section.accounting', false),
    ('HR_HEAD', 'section.revenueClose', false),
    ('HR_HEAD', 'section.workspace', false),
    ('HR_HEAD', 'section.domains', false),
    ('HR_HEAD', 'section.calls', false),
    ('HR_HEAD', 'section.targets', false),
    ('HR_HEAD', 'section.incentives', false),
    ('HR_HEAD', 'section.contactsLibrary', false),
    ('HR_HEAD', 'section.vendors', false),
    ('HR_HEAD', 'section.resellers', false),
    ('HR_HEAD', 'section.commissionParties', false),
    ('HR_HEAD', 'section.visits', false),
    ('HR_HEAD', 'section.marketing', false),
    ('HR_HEAD', 'section.wins', false),
    ('HR_HEAD', 'section.forecast', false),
    ('HR_HEAD', 'section.forms', false),
    ('HR_HEAD', 'section.customerPortal', false),
    ('HR_HEAD', 'section.feedback', false),
    ('HR_HEAD', 'section.projects', false),
    ('HR_HEAD', 'section.helpdesk', false),
    ('HR_HEAD', 'section.reports', false)
)
INSERT INTO "role_permissions" ("role", "permission", "allowed", "updatedAt")
SELECT s."role", s."permission", s."allowed", now()
FROM starting s JOIN new_role n ON n."key" = s."role";

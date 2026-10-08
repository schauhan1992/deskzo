-- Three more built-in roles (owner, 8 Oct 2026): HR, Recruiter and Renewal specialist — and hiring
-- as a permission of its own, so a recruiter can run hiring without opening every employee record.
--
-- A role is inserted only where no role has its key yet. A workspace that already made a custom
-- "HR" (or "Recruiter"…) keeps it exactly as it is: nothing below touches a role it didn't insert.
-- That is also why the starting permissions are role rows, written here as if an admin had applied
-- the role's preset, rather than defaults in the code — a default keyed on "HR" would reach a custom
-- role of that name too. Sections outside each role's starting menu are written unticked, the way
-- unticking them on Staff & roles does; an admin can tick any of them back.

WITH new_roles AS (
  INSERT INTO "roles" ("key", "name", "description", "isSystem", "sortOrder", "updatedAt") VALUES
    ('HR', 'HR', 'People records, attendance and leave, hiring and onboarding.', true, 90, now()),
    ('RECRUITER', 'Recruiter', 'Finds and hires people: candidates, interviews, offers. Not employee records.', true, 100, now()),
    ('RENEWAL_SPECIALIST', 'Renewal specialist', 'Keeps every customer''s subscriptions renewed: renewal quotes, follow-ups and payments due.', true, 110, now())
  ON CONFLICT ("key") DO NOTHING
  RETURNING "key"
),
starting ("role", "permission", "allowed") AS (
  VALUES
    ('HR', 'hr.manage', true),
    ('HR', 'hr.viewAll', true),
    ('HR', 'hr.approveLeave', true),
    ('HR', 'hiring.manage', true),
    ('HR', 'people.handover', true),
    ('HR', 'engagement.manage', true),
    ('HR', 'visitors.view', true),
    ('HR', 'data.exportPeople', true),
    ('HR', 'meetings.schedule', true),
    ('HR', 'copilot.use', true),
    ('HR', 'section.companies', false),
    ('HR', 'section.items', false),
    ('HR', 'section.orders', false),
    ('HR', 'section.salesDocuments', false),
    ('HR', 'section.purchaseDocuments', false),
    ('HR', 'section.renewals', false),
    ('HR', 'section.payments', false),
    ('HR', 'section.receivables', false),
    ('HR', 'section.payables', false),
    ('HR', 'section.accounting', false),
    ('HR', 'section.revenueClose', false),
    ('HR', 'section.workspace', false),
    ('HR', 'section.domains', false),
    ('HR', 'section.calls', false),
    ('HR', 'section.targets', false),
    ('HR', 'section.incentives', false),
    ('HR', 'section.contactsLibrary', false),
    ('HR', 'section.vendors', false),
    ('HR', 'section.resellers', false),
    ('HR', 'section.commissionParties', false),
    ('HR', 'section.visits', false),
    ('HR', 'section.marketing', false),
    ('HR', 'section.wins', false),
    ('HR', 'section.forecast', false),
    ('HR', 'section.forms', false),
    ('HR', 'section.customerPortal', false),
    ('HR', 'section.feedback', false),
    ('HR', 'section.projects', false),
    ('HR', 'section.vault', false),
    ('HR', 'section.helpdesk', false),
    ('HR', 'section.reports', false),
    ('RECRUITER', 'hiring.manage', true),
    ('RECRUITER', 'meetings.schedule', true),
    ('RECRUITER', 'copilot.use', true),
    ('RECRUITER', 'section.companies', false),
    ('RECRUITER', 'section.items', false),
    ('RECRUITER', 'section.orders', false),
    ('RECRUITER', 'section.salesDocuments', false),
    ('RECRUITER', 'section.purchaseDocuments', false),
    ('RECRUITER', 'section.renewals', false),
    ('RECRUITER', 'section.payments', false),
    ('RECRUITER', 'section.receivables', false),
    ('RECRUITER', 'section.payables', false),
    ('RECRUITER', 'section.accounting', false),
    ('RECRUITER', 'section.revenueClose', false),
    ('RECRUITER', 'section.workspace', false),
    ('RECRUITER', 'section.domains', false),
    ('RECRUITER', 'section.calls', false),
    ('RECRUITER', 'section.targets', false),
    ('RECRUITER', 'section.incentives', false),
    ('RECRUITER', 'section.visitors', false),
    ('RECRUITER', 'section.payroll', false),
    ('RECRUITER', 'section.contactsLibrary', false),
    ('RECRUITER', 'section.vendors', false),
    ('RECRUITER', 'section.resellers', false),
    ('RECRUITER', 'section.commissionParties', false),
    ('RECRUITER', 'section.visits', false),
    ('RECRUITER', 'section.marketing', false),
    ('RECRUITER', 'section.wins', false),
    ('RECRUITER', 'section.forecast', false),
    ('RECRUITER', 'section.forms', false),
    ('RECRUITER', 'section.customerPortal', false),
    ('RECRUITER', 'section.feedback', false),
    ('RECRUITER', 'section.projects', false),
    ('RECRUITER', 'section.vault', false),
    ('RECRUITER', 'section.helpdesk', false),
    ('RECRUITER', 'section.reports', false),
    ('RENEWAL_SPECIALIST', 'companies.viewAll', true),
    ('RENEWAL_SPECIALIST', 'contacts.view', true),
    ('RENEWAL_SPECIALIST', 'leads.view', true),
    ('RENEWAL_SPECIALIST', 'orders.view', true),
    ('RENEWAL_SPECIALIST', 'documents.view', true),
    ('RENEWAL_SPECIALIST', 'documents.issue', true),
    ('RENEWAL_SPECIALIST', 'documents.send', true),
    ('RENEWAL_SPECIALIST', 'payments.view', true),
    ('RENEWAL_SPECIALIST', 'calls.view', true),
    ('RENEWAL_SPECIALIST', 'emails.view', true),
    ('RENEWAL_SPECIALIST', 'tickets.view', true),
    ('RENEWAL_SPECIALIST', 'projects.view', true),
    ('RENEWAL_SPECIALIST', 'visits.view', true),
    ('RENEWAL_SPECIALIST', 'tickets.create', true),
    ('RENEWAL_SPECIALIST', 'products.edit', true),
    ('RENEWAL_SPECIALIST', 'collections.followUp', true),
    ('RENEWAL_SPECIALIST', 'feedback.request', true),
    ('RENEWAL_SPECIALIST', 'meetings.schedule', true),
    ('RENEWAL_SPECIALIST', 'copilot.use', true),
    ('RENEWAL_SPECIALIST', 'section.items', false),
    ('RENEWAL_SPECIALIST', 'section.purchaseDocuments', false),
    ('RENEWAL_SPECIALIST', 'section.payables', false),
    ('RENEWAL_SPECIALIST', 'section.accounting', false),
    ('RENEWAL_SPECIALIST', 'section.revenueClose', false),
    ('RENEWAL_SPECIALIST', 'section.workspace', false),
    ('RENEWAL_SPECIALIST', 'section.domains', false),
    ('RENEWAL_SPECIALIST', 'section.targets', false),
    ('RENEWAL_SPECIALIST', 'section.incentives', false),
    ('RENEWAL_SPECIALIST', 'section.visitors', false),
    ('RENEWAL_SPECIALIST', 'section.payroll', false),
    ('RENEWAL_SPECIALIST', 'section.vendors', false),
    ('RENEWAL_SPECIALIST', 'section.resellers', false),
    ('RENEWAL_SPECIALIST', 'section.commissionParties', false),
    ('RENEWAL_SPECIALIST', 'section.visits', false),
    ('RENEWAL_SPECIALIST', 'section.marketing', false),
    ('RENEWAL_SPECIALIST', 'section.wins', false),
    ('RENEWAL_SPECIALIST', 'section.forecast', false),
    ('RENEWAL_SPECIALIST', 'section.forms', false),
    ('RENEWAL_SPECIALIST', 'section.customerPortal', false),
    ('RENEWAL_SPECIALIST', 'section.feedback', false),
    ('RENEWAL_SPECIALIST', 'section.projects', false),
    ('RENEWAL_SPECIALIST', 'section.vault', false),
    ('RENEWAL_SPECIALIST', 'section.reports', false)
)
INSERT INTO "role_permissions" ("role", "permission", "allowed", "updatedAt")
SELECT s."role", s."permission", s."allowed", now()
FROM starting s JOIN new_roles n ON n."key" = s."role";

-- Hiring used to come with "Manage people records" (hr.manage). Whoever has that answered
-- explicitly — a role's tick or untick, a person's own grant or denial — gets the same answer for
-- "Run hiring", so nobody gains or loses hiring by the split. (Everybody else follows the defaults,
-- which give both to the same role.)
INSERT INTO "role_permissions" ("role", "permission", "allowed", "updatedAt")
SELECT "role", 'hiring.manage', "allowed", now() FROM "role_permissions" WHERE "permission" = 'hr.manage'
ON CONFLICT ("role", "permission") DO NOTHING;

INSERT INTO "user_permissions" ("userId", "permission", "allowed", "reason", "grantedById", "expiresAt", "createdAt", "updatedAt")
SELECT "userId", 'hiring.manage', "allowed", COALESCE("reason", 'As for "Manage people records", when hiring became a permission of its own'), "grantedById", "expiresAt", now(), now()
FROM "user_permissions" WHERE "permission" = 'hr.manage'
ON CONFLICT ("userId", "permission") DO NOTHING;

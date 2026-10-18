/**
 * Which module each file in src/actions belongs to — so that a workspace whose plan does not include
 * a module cannot reach that module's actions, whatever its pages happen to show.
 *
 * Every exported function of a file mapped to modules must call `requireModuleUser` with one of
 * them (src/lib/modules-access.ts), directly or through a local helper; `check:module-guards`
 * enforces it, and refuses an action file that is not listed here at all. The other answers:
 *
 *   · "core"      — the app itself: signing in, people and roles, settings, companies and leads,
 *                   search, the dashboard. In every plan, so nothing to check.
 *   · "public"    — served to somebody with no account here (a form, the portal, the visitor
 *                   tablet). There is no user to require; each checks `moduleAvailableForTenant`.
 *   · "platform"  — the platform's own (signup, the staff console, the public website and its CMS,
 *                   the partner portal). No workspace plan applies.
 *
 * A file listing several modules serves each of them (a trade document is a sales or a purchase
 * one): its actions are open while any of them is in the plan.
 */

export type ActionScope = "core" | "public" | "platform" | readonly string[];

export const ACTION_MODULES: Record<string, ActionScope> = {
  "access-control.ts": "core",
  "access-gate.ts": "core",
  // Field access, daily unmask limits and the unmasking log (src/lib/authz/fields.ts, unmask.ts) —
  // part of roles and permissions, which are core.
  "field-access.ts": "core",
  // One person's own exceptions — permissions, record levels, reset to role defaults.
  "person-access.ts": "core",
  "unmask-log.ts": "core",
  // The role editor's record grid and My access (roles and permissions are core).
  "access-levels.ts": "core",
  "access-lock.ts": "core",
  "access.ts": "core",
  // Revenue & Close: prepaids and accruals (src/lib/close/schedules.ts).
  "accounting-schedules.ts": ["revenue_close"],
  "activity-awards.ts": ["wins"],
  "activity-tracking.ts": "core",
  "activity.ts": "core",
  "addon-proposal.ts": ["renewals"],
  "addon.ts": ["renewals"],
  "analytics.ts": ["reports"],
  // The public API's keys (src/lib/api), Settings › Developers & API — each endpoint checks its own module.
  "api-keys.ts": "core",
  // Pairing your phone with the Deskzo app (src/lib/app) — the app's calling asks Calls itself.
  "app-devices.ts": "core",
  "asset.ts": ["accounting"],
  "attendance.ts": ["hr"],
  "auth.ts": "core",
  "backup.ts": "core",
  "billing.ts": "core",
  // Booking pages (src/lib/booking): made by staff, booked by the public.
  "booking.ts": ["booking"],
  "booking-public.ts": "public",
  "bank.ts": ["accounting"],
  "biometric.ts": ["hr"],
  "books.ts": ["accounting"],
  "brand.ts": ["items"],
  "branding.ts": "core",
  "call.ts": ["calls"],
  // Calls › Team report — each person's calling in a period.
  "call-report.ts": ["calls"],
  "calling-activity.ts": ["calls"],
  // "Ring my phone" in a call dialog — the Deskzo app on the caller's phone dials it.
  "phone-calls.ts": ["calls"],
  "candidate.ts": ["hr"],
  // Deskzo Cards: issuing cards, templates, My card (src/lib/cards); the card page itself is public.
  "card.ts": ["cards"],
  "card-public.ts": "public",
  // Deskzo Signatures: templates, rules, the connected suite and syncing (src/lib/signatures).
  "signature.ts": ["signatures"],
  "celebration.ts": ["hr"],
  // Revenue & Close: the month-end checklist, closing a month, flux and the close settings (src/lib/close).
  "close.ts": ["revenue_close"],
  // Collections: a salesperson's dues and payment follow-ups — Receivables' (src/lib/collections).
  "collections.ts": ["receivables"],
  "commission-party.ts": ["commission_parties"],
  // A vendor's bank accounts are its company record's, wherever it is opened from.
  "company-bank.ts": "core",
  "company-location.ts": "core",
  "company-merge.ts": "core",
  "company.ts": "core",
  "consignment.ts": ["it_assets"],
  "contact.ts": "core",
  "copilot.ts": "core",
  "credit.ts": ["receivables"],
  "customer-category.ts": "core",
  // The workspace's own fields on its records (src/lib/custom-fields) — settings, in every plan.
  "custom-fields.ts": "core",
  // Lead stages and pipelines (leads), and order steps (orders) — each half checks its own.
  "pipeline.ts": ["leads", "orders"],
  // A pipeline's automations (src/lib/pipeline/automations.ts).
  "pipeline-automations.ts": ["leads"],
  "automate.ts": ["automate"],
  "wording.ts": "core",
  "workplace.ts": "core",
  "sign-in-rules.ts": "core",
  "time-zone.ts": "core",
  "dashboard.ts": "core",
  "data-export.ts": "core",
  "data-import.ts": "core",
  "data-reset.ts": "core",
  "department.ts": "core",
  // Contact designations: a list the contacts on every company pick from.
  "designation.ts": "core",
  "dlp.ts": "core",
  "document-approval.ts": ["sales_documents", "purchase_documents"],
  "document-mail.ts": ["sales_documents", "purchase_documents"],
  "workplace-connection.ts": ["sales_documents", "purchase_documents", "calendar"],
  "calendar.ts": ["calendar"],
  "industry-templates.ts": "core",
  "document-number.ts": ["sales_documents", "purchase_documents"],
  "domain.ts": ["domains"],
  // Settings › Domain: the workspace's own addresses (custom domains) — the owner's, like billing; not the Domains module above.
  "domains.ts": "core",
  // Checking a contact's address belongs to having contacts, which every plan has; the Contact Checks
  // page that lists the failures is the Workspace module's.
  "email-verification.ts": "core",
  "exchange-rate.ts": "core",
  "employee-docs.ts": ["hr"],
  "eway.ts": ["sales_documents"],
  "expense.ts": ["expenses"],
  "feedback-public.ts": "public",
  "feedback.ts": ["feedback"],
  "finance.ts": ["accounting"],
  "forecast.ts": ["forecast"],
  "forms.ts": ["forms"],
  "geo.ts": "core",
  "handover.ts": "core",
  "help.ts": "core",
  "hr.ts": ["hr"],
  // The GST portal's HSN/SAC directory — a reference lookup, like geo.ts, for items and document lines.
  "hsn.ts": "core",
  "impersonation.ts": "core",
  "incentive.ts": ["incentives"],
  "industry.ts": "core",
  "intake.ts": "public",
  "internal-feedback.ts": ["engagement"],
  "it-asset.ts": ["it_assets"],
  "item-category.ts": ["items"],
  "item.ts": ["items"],
  // The lead pipeline is a module of its own since 14 Oct 2026 — sold with Pipeline, CRM and One.
  "lead-assignment.ts": ["leads"],
  "lead-capture.ts": ["leads"],
  "lead.ts": ["leads"],
  // Unmasking a lead's fields on its page, against the daily limit (src/lib/authz/unmask.ts).
  "lead-unmask.ts": ["leads"],
  "leave.ts": ["hr"],
  // Opening leave balances for a company moving to Deskzo mid-year (owner, 17 Oct 2026).
  "leave-openings.ts": ["hr"],
  "ledger-reports.ts": ["accounting"],
  "ledger.ts": ["accounting"],
  // Linked sign-in: a person's own accounts in other workspaces, and the Security card's rule — every plan (owner decision 10).
  "linked-sign-in.ts": "core",
  "linked-sign-in-admin.ts": "core",
  "mail-log.ts": "core",
  "maintenance.ts": "core",
  "marketing-public.ts": "public",
  "marketing.ts": ["marketing"],
  "messaging-provider.ts": ["marketing"],
  "module.ts": "core",
  "note.ts": ["notes"],
  "chat.ts": ["chat"],
  "chat-admin.ts": ["chat"],
  "notification.ts": ["notifications"],
  "order-notice.ts": ["orders", "renewals"],
  "order-progress.ts": ["orders"],
  // The punch form's lookups — one call when the customer is chosen, one for the product (owner, 2 Oct 2026).
  "order-punch.ts": ["orders"],
  "order.ts": ["orders"],
  "order-billing.ts": ["orders"],
  // "Create vendor PO" from an order's Purchasing box; it asks for Purchase documents itself (owner, 15 Oct 2026).
  "order-vendor-po.ts": ["orders"],
  // The word filter: each area asks its own module — Chat, or the Helpdesk for tickets (owner, 15 Oct 2026).
  "word-filter.ts": ["chat", "helpdesk"],
  // Backend rebates on orders, their programmes and the report (owner, 1 Oct 2026).
  "rebate.ts": ["orders"],
  // Branches and GST registrations are the company itself, not a module: every document names one.
  "branch.ts": "core",
  // Getting started: the onboarding wizard's steps, skips and completion (src/lib/help).
  "onboarding.ts": "core",
  "organisation-bank.ts": "core",
  "organisation.ts": "core",
  "page-layout.ts": "core",
  "password-reset.ts": "public",
  "payable.ts": ["payables"],
  // What distributors and OEMs give back — set against bills and orders' rebates.
  "vendor-codes.ts": ["vendors"],
  "vendor-credit.ts": ["payables"],
  "payment.ts": ["payments"],
  "payroll.ts": ["payroll"],
  // Bringing pay across from another HRMS, for payroll only (src/lib/portability/importers/payroll.ts).
  "payroll-import.ts": ["payroll"],
  "performance.ts": "core",
  "permission.ts": "core",
  "portal-public.ts": "public",
  "portal.ts": ["customer_portal"],
  "prizes.ts": ["wins"],
  // TV screens: pairing a TV, renaming it, taking it off (owner, 17 Oct 2026).
  "tv.ts": ["wins"],
  // What a TV itself calls while it shows its code — no sign-in (src/lib/tv/screens.ts).
  "tv-public.ts": "public",
  "profile.ts": "core",
  "project-credential.ts": ["projects"],
  "project-document.ts": ["projects"],
  "project.ts": ["projects"],
  "receivable.ts": ["receivables"],
  "reconcile.ts": ["purchase_documents"],
  // Switching a subscription order's recurring billing on or off (src/lib/recurring-billing/run.ts).
  "recurring-billing.ts": ["orders"],
  "reference-data.ts": "core",
  "regularisation.ts": ["hr"],
  "renewal-order.ts": ["renewals"],
  "renewal-proposal.ts": ["renewals"],
  "renewal-stage.ts": ["renewals"],
  "renewal.ts": ["renewals"],
  "reseller.ts": ["resellers"],
  // Revenue & Close: revenue recognition — schedules, the run, the opening wizard (src/lib/revenue).
  "revenue.ts": ["revenue_close"],
  // Revenue & Close: what the revenue screens read beside it, and the waterfall's CSV.
  "revenue-screens.ts": ["revenue_close"],
  "role.ts": "core",
  "search.ts": "core",
  "security-policy.ts": "core",
  "security.ts": "core",
  "settlement.ts": ["payroll"],
  "short-leave.ts": ["hr"],
  "support-access.ts": "core",
  // Contact Support: asking the platform for help is part of every plan.
  "support.ts": "core",
  "support-load.ts": ["helpdesk"],
  "survey.ts": ["engagement"],
  "table-preference.ts": "core",
  "target.ts": ["targets"],
  "task.ts": ["tasks"],
  // A task's checklist, comments, files, time, the form's choices and challenges (owner, 16 Oct 2026).
  "task-extras.ts": ["tasks"],
  "tax-reports.ts": ["accounting"],
  "ticket.ts": ["helpdesk"],
  // Tickets by email: the address and its settings, the Support inbox, replies (src/lib/support-mail).
  "support-mail.ts": ["helpdesk"],
  "trade-document.ts": ["sales_documents", "purchase_documents"],
  "transporter.ts": ["sales_documents", "it_assets"],
  "user-photo.ts": "core",
  "user.ts": "core",
  "vault.ts": ["vault"],
  "verification.ts": ["workspace"],
  "view-mode.ts": "core",
  "visit.ts": ["visits"],
  "visitor-public.ts": "public",
  "visitor.ts": ["visitors"],
  "wins.ts": ["wins"],
  // A colleague's wish on a birthday or work anniversary: the occasions are HR's (src/lib/hr/wishes.ts).
  "wishes.ts": ["hr"],
  "workspace.ts": ["workspace"],
  "platform/console-admin.ts": "platform",
  "platform/console-ai.ts": "platform",
  "platform/console-automate.ts": "platform",
  "platform/console-alerts.ts": "platform",
  "platform/console-announcements.ts": "platform",
  "platform/console-billing.ts": "platform",
  "platform/console-offline.ts": "platform",
  "platform/console-time-zone.ts": "platform",
  "platform/console-commissions.ts": "platform",
  "platform/console-directory.ts": "platform",
  "platform/console-domains.ts": "platform",
  "platform/console-help.ts": "platform",
  "platform/console-mail.ts": "platform",
  "platform/console-signups.ts": "platform",
  "platform/console-linked.ts": "platform",
  "platform/console-names.ts": "platform",
  "platform/console-partners.ts": "platform",
  "platform/console-shell.ts": "platform",
  "platform/console-support.ts": "platform",
  "platform/console-website.ts": "platform",
  "platform/console-workspace.ts": "platform",
  "platform/console.ts": "platform",
  "platform/partner-site.ts": "platform",
  "platform/signup.ts": "platform",
  "platform/site.ts": "platform",
  "platform/staff-auth.ts": "platform",
  // The website CMS (cms.<domain>): its own accounts, and only the control plane's site tables.
  "cms/auth.ts": "platform",
  "cms/categories.ts": "platform",
  "cms/guides.ts": "platform",
  "cms/leads.ts": "platform",
  "cms/media.ts": "platform",
  "cms/pages.ts": "platform",
  "cms/posts.ts": "platform",
  "cms/redirects.ts": "platform",
  "cms/seo.ts": "platform",
  "cms/settings.ts": "platform",
  "cms/tags.ts": "platform",
  "cms/users.ts": "platform",
  // The partner portal (partners.<domain>): its own accounts, and only the control plane's partner tables.
  "partners/auth.ts": "platform",
  "partners/commissions.ts": "platform",
  "partners/deals.ts": "platform",
  "partners/invitations.ts": "platform",
  "partners/profile.ts": "platform",
  "partners/resellers.ts": "platform",
  "partners/team.ts": "platform",
};

/**
 * Public actions that work whatever the plan, each for a stated reason. Every other export of a
 * "public" file checks `moduleAvailableForTenant` first.
 */
export const ALWAYS_OPEN: Record<string, string> = {
  "marketing-public.ts:getPreferences": "somebody can always see what they are sent — the law requires it",
  "marketing-public.ts:updatePreferences": "and always change it",
  "marketing-public.ts:unsubscribeAll": "and always stop it",
  "password-reset.ts:requestPasswordReset": "signing in belongs to every plan",
  "password-reset.ts:resetPassword": "signing in belongs to every plan",
  "password-reset.ts:setPasswordAndSignIn": "signing in belongs to every plan",
};

import type { Role } from "@/lib/roles";
import { PERMISSIONS, type PermissionKey } from "@/lib/permissions";

/**
 * Ready-made access profiles, so setting somebody up is one click rather than forty.
 *
 * ## Why these are code and not rows
 *
 * A preset is a *recommendation* — "this is what an accounts executive normally needs" — and it has
 * to be versioned with the application, because every release that adds a capability has to decide
 * which job functions ought to get it. Stored as data, presets silently rot: a new permission ships,
 * no preset mentions it, and the preset that claimed to describe a job function quietly stops doing
 * so. `check:rbac` asserts every key is named by at least one preset, which turns that rot into a
 * failing build.
 *
 * Applying a preset writes ordinary `RolePermission` rows. Nothing about a role is "bound" to a
 * preset afterwards — an admin who then tweaks two cells has a role that has drifted from its
 * preset, and the screen shows that drift rather than pretending it hasn't happened. Presets are a
 * starting point, not a cage.
 */

export type RolePreset = {
  key: string;
  label: string;
  description: string;
  /** Which Role this preset is offered for. A preset for a role nobody holds is noise. */
  role: Role;
  /** Everything this profile grants. Anything not listed is explicitly switched off. */
  permissions: readonly PermissionKey[];
};

/**
 * Note what is deliberately absent from every non-admin preset: `permissions.manage`,
 * `users.assignRole`, `settings.manage`, `security.manage` and `impersonation.use`. Those are the
 * keys that let their holder rewrite the rules, and they are granted one at a time by a person, not
 * handed out by a profile.
 */
/**
 * What of an account every profile may see — all of it, as before these existed.
 *
 * Applying a preset switches off anything it does not list, so a preset without these would take
 * the Contacts, Orders, Payments… tabs away from whoever it was applied to. They are in every
 * profile; narrowing one is a decision for the role afterwards, in Users & access.
 */
const ACCOUNT_VIEWS = [
  "contacts.view",
  "leads.view",
  "orders.view",
  "payments.view",
  "documents.view",
  "projects.view",
  "calls.view",
  "visits.view",
  "tickets.view",
  "emails.view",
] as const satisfies readonly PermissionKey[];

/**
 * What every profile carries besides the account views — tools anybody's job can use. The AI copilot
 * only ever sees and does what the person using it already can, so it widens nothing.
 */
const EVERY_PROFILE = ["copilot.use"] as const satisfies readonly PermissionKey[];

export const ROLE_PRESETS: RolePreset[] = [
  // ─── Sales ──────────────────────────────────────────────────────────────────────────────────
  {
    key: "sales-executive",
    label: "Sales executive",
    description: "Works leads and orders for their own accounts. Cannot approve their own paperwork or see anybody else's numbers.",
    role: "SALES",
    permissions: [...ACCOUNT_VIEWS, ...EVERY_PROFILE, 
      "vault.use","products.edit", "tickets.create", "feedback.request", "marketing.viewAll", "targets.viewAll",
      "documents.issue",
      "documents.send",
      // Their own event invitations and requirement assessments.
      "forms.create",
      // Their own accounts and leads, to a colleague — never somebody else's.
      "accounts.handOffOwn"],
  },
  {
    key: "sales-manager",
    label: "Sales manager",
    description: "A sales executive plus the team view: their reports' visits, expenses and targets, the ability to set targets, and handing a departing rep's accounts to somebody else.",
    role: "SALES",
    permissions: [...ACCOUNT_VIEWS, ...EVERY_PROFILE, 
      "products.edit",
      "products.delete",
      // A manager hands leads to their team; a rep does not hand leads to a manager.
      "leads.assign",
      "accounts.reassign",
      "accounts.handOffOwn",
      "tickets.create",
      "documents.issue",
      "documents.send",
      // A manager may pull back a document a rep raised in error; an executive may not.
      "documents.void",
      "feedback.request",
      "feedback.viewAll",
      "marketing.viewAll",
      "marketing.send",
      "forms.create",
      // How much a deal at each stage counts in the forecast — the sales manager knows the pipeline best.
      "forecast.manage",
      // Which wins the floor celebrates, and how loudly.
      "wins.manage",
      "companies.manageCategories",
      // Tidying the book — folding a duplicate account into the real one.
      "companies.merge",
      "targets.manage",
      "targets.viewAll",
      "visits.viewAll",
      "workspace.manageAny",
      "performance.view",
      "notes.broadcast",
      "people.handover",
    ],
  },
  // ─── Calling / profiling ────────────────────────────────────────────────────────────────────
  {
    key: "calling-agent",
    label: "Calling agent",
    description: "Works a calling list and logs outcomes. Deliberately narrow — this is the profile with the widest access to contact details and the least need for anything else.",
    role: "CALLING",
    // leads.assign: a qualified call is handed to the salesperson who will work it.
    permissions: [...ACCOUNT_VIEWS, ...EVERY_PROFILE, "tickets.create", "companies.viewAll", "leads.assign"],
  },
  {
    key: "data-profiler",
    label: "Data profiler",
    description: "Builds and cleans the company and contact records that everything else runs on.",
    role: "PROFILE",
    permissions: [...ACCOUNT_VIEWS, ...EVERY_PROFILE, "tickets.create", "companies.viewAll"],
  },
  // ─── Support ────────────────────────────────────────────────────────────────────────────────
  {
    key: "support-agent",
    label: "Support agent",
    description: "Handles tickets and the IT asset estate for customers under contract.",
    role: "SUPPORT",
    permissions: [...ACCOUNT_VIEWS, ...EVERY_PROFILE, 
      "visitors.view",
      "vault.use","tickets.create", "assets.manage", "assets.viewAll", "feedback.request", "contacts.viewRestricted", "companies.viewAll"],
  },
  {
    key: "project-manager",
    label: "Project manager",
    description:
      "Runs delivery projects end to end. Note what is absent: opening a customer's stored credentials is its own key, granted one person at a time rather than by a job title.",
    role: "SUPPORT",
    permissions: [...ACCOUNT_VIEWS, ...EVERY_PROFILE, "companies.viewAll", "projects.manage", "tickets.create", "tasks.delete"],
  },
  {
    key: "delivery-head",
    label: "Delivery head",
    description:
      "Every project rather than only their own, plus the credential store. This is the profile that can read a customer's passwords — give it to as few people as the work allows.",
    role: "MANAGEMENT",
    permissions: [...ACCOUNT_VIEWS, ...EVERY_PROFILE, 
      "companies.viewAll",
      "projects.manage",
      "projects.viewAll",
      "projects.credentials",
      "performance.view",
    ],
  },
  {
    key: "support-lead",
    label: "Support lead",
    description: "A support agent plus ticket deletion, the full feedback picture, and team performance.",
    role: "SUPPORT",
    permissions: [...ACCOUNT_VIEWS, ...EVERY_PROFILE, 
      "visitors.view",
      "companies.viewAll",
      "tickets.create",
      "tickets.delete",
      "tasks.delete",
      "assets.manage",
      "assets.viewAll",
      "feedback.request",
      "feedback.viewAll",
      "contacts.viewRestricted",
      "performance.view",
    ],
  },
  // ─── Accounts ───────────────────────────────────────────────────────────────────────────────
  {
    key: "accounts-executive",
    label: "Accounts executive",
    description: "Records money in and out and approves orders against payment terms. No access to salaries.",
    role: "ACCOUNTS",
    permissions: [...ACCOUNT_VIEWS, ...EVERY_PROFILE, 
      "vault.use",
      "companies.viewAll",
      "payments.record",
      "payments.manage",
      "orders.approve",
      "documents.issue",
      "documents.send",
      "ledger.viewReports",
      "expenses.reimburse",
      "expenses.viewAll",
      "revenue.viewReports",
      "close.work",
    ],
  },
  {
    key: "accounts-manager",
    label: "Accounts manager",
    description: "The full finance function short of payroll — including deletions, expense approval and the tax reports.",
    role: "ACCOUNTS",
    permissions: [...ACCOUNT_VIEWS, ...EVERY_PROFILE, 
      "companies.viewAll",
      "payments.record",
      "payments.delete",
      "payments.manage",
      "orders.approve",
      "credit.override",
      "ledger.viewReports",
      "documents.issue",
      "documents.send",
      "documents.void",
      "expenses.approve",
      "expenses.reimburse",
      "expenses.viewAll",
      "incentives.approve",
      "performance.view",
      // The three that made this preset's own description a lie: it claims the full finance
      // function short of payroll, while the journal, the chart of accounts and the year-end
      // close were all admin-only and undelegatable.
      "ledger.post",
      "ledger.manageAccounts",
      "books.close",
      "data.exportFinance",
      "data.importFinance",
      "purchase.reconcile",
      "revenue.viewReports",
      "revenue.manage",
      "close.work",
      "close.manage",
    ],
  },
  // ─── Purchase ───────────────────────────────────────────────────────────────────────────────
  {
    key: "purchase-executive",
    label: "Purchase executive",
    description: "Sources approved orders, sets vendor and cost, and marks them fulfilled.",
    role: "PURCHASE",
    // This role held nothing at all before, because it was missing from the role list the
    // permission screen renders from — see src/lib/roles.ts.
    permissions: [...ACCOUNT_VIEWS, ...EVERY_PROFILE, 
      "vault.use","orders.process", "products.edit", "tickets.create", "companies.viewAll", "data.exportCatalog", "data.importCatalog",
      // Whoever places the order with the distributor is who should be checking its monthly bill.
      "purchase.reconcile"],
  },
  // ─── Management ─────────────────────────────────────────────────────────────────────────────
  {
    key: "operations-manager",
    label: "Operations manager",
    description: "Sees across the company and approves most things, but holds nothing that changes who can do what.",
    role: "MANAGEMENT",
    permissions: [...ACCOUNT_VIEWS, ...EVERY_PROFILE, 
      "companies.viewAll",
      "accounts.reassign",
      "credit.override",
      "products.edit",
      "products.delete",
      "catalog.manage",
      "payments.record",
      "payments.manage",
      "orders.approve",
      "orders.process",
      "documents.issue",
      "documents.send",
      "documents.void",
      "purchase.reconcile",
      "portal.manage",
      "tickets.create",
      "tickets.delete",
      "tasks.delete",
      "contacts.viewRestricted",
      "expenses.approve",
      "expenses.viewAll",
      "visits.viewAll",
      "workspace.manageAny",
      "performance.view",
      "assets.manage",
      "assets.viewAll",
      "feedback.request",
      "feedback.viewAll",
      "marketing.viewAll",
      "targets.manage",
      "targets.viewAll",
      "incentives.manage",
      "activity.viewAll",
      "permissions.view",
      "data.exportCrm",
      "data.exportCatalog",
      "notes.broadcast",
    ],
  },
  {
    key: "hr-manager",
    label: "HR manager",
    description: "People records, attendance, leave, payroll, and handing over a leaver's work. Note that payroll is not inheritable — a manager of this person does not get it.",
    role: "MANAGEMENT",
    permissions: [...ACCOUNT_VIEWS, ...EVERY_PROFILE, 
      "visitors.manage",
      "visitors.view",
      "engagement.readFeedback",
      "engagement.manage",
      "vault.use",
      "companies.viewAll",
      "hr.manage",
      "hr.viewAll",
      "hr.approveLeave",
      "people.handover",
      "payroll.manage",
      "expenses.approve",
      "expenses.viewAll",
      "performance.view",
      "users.manage",
      "data.exportPeople",
      "data.importPeople",
    ],
  },
  {
    key: "marketing-manager",
    label: "Marketing manager",
    description: "Runs campaigns and journeys end to end, including approving a send.",
    role: "MANAGEMENT",
    permissions: [...ACCOUNT_VIEWS, ...EVERY_PROFILE, 
      "companies.viewAll",
      "marketing.manage",
      "marketing.send",
      "marketing.approve",
      "marketing.viewAll",
      "forms.create",
      "forms.manageAll",
      "feedback.request",
      "feedback.viewAll",
      "contacts.viewRestricted",
      "targets.viewAll",
      "data.exportCrm",
      "data.importCrm",
    ],
  },
  {
    key: "vault-custodian",
    label: "Vault custodian",
    description:
      "Can open any stored credential, including ones nobody shared. Every such reveal is recorded as an override and reported to the record's owner — accountable access, not silent access. One or two people, no more.",
    role: "MANAGEMENT",
    permissions: [...ACCOUNT_VIEWS, ...EVERY_PROFILE, "vault.use", "vault.viewAll", "vault.manageTags"],
  },
  {
    key: "auditor",
    label: "Auditor (read-only)",
    description: "Sees everything and changes nothing — the activity log, the permission review screens, and company-wide figures. Grants no ability to act.",
    role: "MANAGEMENT",
    permissions: [...ACCOUNT_VIEWS, ...EVERY_PROFILE, "activity.viewAll", "activity.export", "permissions.view", "expenses.viewAll", "visits.viewAll", "performance.view", "hr.viewAll", "assets.viewAll", "feedback.viewAll", "marketing.viewAll", "targets.viewAll", "companies.viewAll", "data.exportCrm", "data.exportFinance"],
  },
];

export function presetsForRole(role: Role): RolePreset[] {
  return ROLE_PRESETS.filter((p) => p.role === role);
}

export function getPreset(key: string): RolePreset | undefined {
  return ROLE_PRESETS.find((p) => p.key === key);
}

/**
 * How far a role has drifted from a preset.
 *
 * Shown next to the preset button so applying one is an informed choice rather than a gamble —
 * "this will switch on 3 and switch off 1" is the sentence somebody needs before clicking, and its
 * absence is why bulk-apply buttons go unused.
 */
export function presetDiff(
  preset: RolePreset,
  current: Record<string, boolean>,
): { willGrant: PermissionKey[]; willRevoke: PermissionKey[]; unchanged: number } {
  const wanted = new Set<string>(preset.permissions);
  const willGrant: PermissionKey[] = [];
  const willRevoke: PermissionKey[] = [];
  let unchanged = 0;

  for (const def of PERMISSIONS) {
    const shouldHave = wanted.has(def.key);
    const has = current[def.key] === true;
    if (shouldHave && !has) willGrant.push(def.key as PermissionKey);
    else if (!shouldHave && has) willRevoke.push(def.key as PermissionKey);
    else unchanged += 1;
  }
  return { willGrant, willRevoke, unchanged };
}

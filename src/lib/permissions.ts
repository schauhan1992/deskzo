import type { Role } from "@prisma/client";

/**
 * Every capability the application knows how to restrict.
 *
 * This registry is the single source of truth: the permission screen renders from it, the
 * resolver refuses any key that is not in it, and `PermissionKey` below is derived from it so a
 * typo becomes a compile error rather than a silently denied check. That last property is not
 * theoretical — `payments.manage` was enforced in three files for months without ever being
 * declared here, which quietly made Fixed Assets, Banking and Tax Reports admin-only with no cell
 * in the matrix an admin could have ticked to notice.
 */
export type PermissionDefinition = {
  key: string;
  label: string;
  description: string;
  /**
   * Roles granted this unless an admin has overridden it. ADMIN is not listed on any entry: an
   * admin holds everything by default and is now configurable, so their access comes from the
   * resolver rather than from this array. See src/lib/authz/resolve.ts.
   */
  defaultRoles: readonly Role[];
  /** Section in the permission screen. Keys with no group fall under "Other". */
  group?: string;
  /**
   * Whether a manager may inherit this from somebody who reports to them.
   *
   * Defaults to true, which is the existing behaviour. Set false for anything where managing the
   * person is not the same as being entitled to the capability — payroll being the clearest case:
   * you may manage the person who runs payroll without being entitled to see everyone's salary.
   */
  delegable?: boolean;
  /**
   * Only a super admin may grant this to anyone, including to an admin. Used for the keys that
   * would let their holder rewrite the access rules themselves.
   */
  superAdminOnly?: boolean;
  /**
   * The holder may not exercise this on a record they created or own. Separation of duties as a
   * property of the permission rather than a rule each action has to remember.
   */
  selfExcluded?: boolean;
  /** Drives the warning colour in the UI and whether granting it notifies the admins. */
  tier?: "standard" | "sensitive" | "critical";
};

export const PERMISSION_REGISTRY = [
  {
    key: "products.edit",
    label: "Edit products & subscriptions",
    description:
      "Change the quantity, notes, or renewal dates on a product/subscription already attached to a company or a lead's requirements.",
    defaultRoles: ["MANAGEMENT", "SALES"],
  },
  {
    key: "products.delete",
    label: "Delete products & subscriptions",
    description: "Remove a product/subscription line from a company or a lead's requirements.",
    defaultRoles: ["MANAGEMENT"],
  },
  {
    key: "payments.record",
    label: "Record payments",
    description: "Log a payment received against an order, and edit an existing payment's details.",
    defaultRoles: ["ACCOUNTS", "MANAGEMENT"],
  },
  {
    key: "payments.delete",
    label: "Delete payments",
    description: "Remove a previously recorded payment.",
    defaultRoles: ["ACCOUNTS", "MANAGEMENT"],
  },
  {
    /**
     * This key was already being checked in three places before it existed here — see
     * src/actions/asset.ts, src/actions/bank.ts and src/actions/tax-reports.ts. Because
     * `rolePermits` returns false for a key with no registry entry, the effect was that Fixed
     * Assets, Banking and Tax Reports were silently admin-only for every other role, with no cell
     * in the permission matrix an admin could have ticked to fix it. A permission that is enforced
     * but not declared is invisible, and invisible is indistinguishable from broken.
     */
    key: "payments.manage",
    label: "Manage finance records",
    description:
      "Fixed assets and depreciation, bank accounts and reconciliation, and the GST tax reports. Broader than recording a payment — this is the finance function rather than the cashbook.",
    defaultRoles: ["ACCOUNTS", "MANAGEMENT"],
  },
  {
    key: "contacts.viewRestricted",
    label: "View reseller-managed contact details",
    description:
      "See the email and phone of a reseller's end customer, which are hidden from everyone else so nobody contacts them behind the reseller's back. Grant only to people who genuinely need to reach them, e.g. for a support escalation.",
    defaultRoles: ["MANAGEMENT", "SUPPORT"],
  },
  {
    key: "tickets.create",
    label: "Create tickets",
    description: "Log a new support ticket against a company.",
    defaultRoles: ["SUPPORT", "SALES", "MANAGEMENT"],
  },
  {
    key: "notes.broadcast",
    label: "Post a note to everyone",
    description:
      "Share a sticky note with the whole company rather than with your own reporting line. A note on everybody's board is an announcement, and an announcement nobody approved is the thing this stops.",
    defaultRoles: ["MANAGEMENT"],
    group: "Sales & customers",
  },
  {
    key: "tickets.delete",
    label: "Delete tickets",
    description: "Permanently remove a support ticket and its comment thread.",
    defaultRoles: ["MANAGEMENT"],
  },
  {
    key: "tasks.delete",
    label: "Delete any task",
    description:
      "Delete a task that isn't yours — anyone can already delete a task they created or are assigned to.",
    defaultRoles: ["MANAGEMENT"],
  },
  {
    key: "performance.view",
    label: "View team performance",
    description: "See active time, records created/edited, and ticket resolution speed for every user.",
    defaultRoles: ["MANAGEMENT"],
  },
  {
    key: "expenses.approve",
    label: "Approve or reject expense claims",
    description:
      "Decide any submitted claim, not just your own team's. Everyone can already approve claims from people who report to them — this is the override for covering an absent manager, or for a claimant who has no manager set.",
    defaultRoles: ["MANAGEMENT", "ACCOUNTS"],
    selfExcluded: true,
  },
  {
    key: "expenses.reimburse",
    label: "Mark expenses reimbursed",
    description:
      "Record that an approved claim has actually been paid out, with a payment reference. Separate from approving it — a manager saying yes and accounts paying it are different events.",
    defaultRoles: ["ACCOUNTS", "MANAGEMENT"],
  },
  {
    key: "expenses.viewAll",
    label: "View all company expenses",
    description:
      "See every expense in the Expenses module, not just your own and your team's. Needed for company-wide spend reporting.",
    defaultRoles: ["MANAGEMENT", "ACCOUNTS"],
  },
  {
    key: "visits.viewAll",
    label: "View all field visits",
    description: "See every visit logged across the company, rather than just your own and your team's.",
    defaultRoles: ["MANAGEMENT"],
  },
  {
    key: "documents.issue",
    label: "Raise and issue sales documents",
    description:
      "Create, edit and issue quotations, proformas, tax invoices, credit notes and delivery challans, and register an invoice with the e-invoice portal. Issuing posts to the ledger and files with the government, so it is not the same thing as drafting one.",
    defaultRoles: ["SALES", "ACCOUNTS", "MANAGEMENT"],
    group: "Sales & customers",
  },
  {
    key: "documents.void",
    label: "Delete or cancel a sales document",
    description:
      "Delete a draft, cancel an issued document, or cancel an IRN with the portal. Separate from issuing because it is the half that destroys a record somebody else is relying on — and after 24 hours the portal will not take a cancellation at all.",
    defaultRoles: ["ACCOUNTS", "MANAGEMENT"],
    group: "Sales & customers",
  },
  {
    key: "orders.approve",
    label: "Approve or reject orders",
    description: "Review a punched order's payment terms and give (or refuse) the go-ahead to the purchase team.",
    defaultRoles: ["ACCOUNTS", "MANAGEMENT"],
    selfExcluded: true,
  },
  {
    key: "orders.process",
    label: "Process orders (purchasing)",
    description: "Set the vendor, purchase price, and our PO on an approved order, and mark it fulfilled.",
    defaultRoles: ["PURCHASE", "MANAGEMENT"],
  },
  {
    key: "hr.manage",
    label: "Manage people records",
    description:
      "Create and edit employee records, the holiday calendar, and leave types. This is the HR administrator's permission — it does not by itself reveal anyone's pay.",
    defaultRoles: ["MANAGEMENT"],
  },
  {
    key: "visitors.view",
    label: "See the visitor book",
    description:
      "Who has signed in at reception, who is still in the building, and sign them out. Reception, security and HR.",
    defaultRoles: ["MANAGEMENT", "SUPPORT"],
  },
  {
    key: "visitors.manage",
    label: "Set up reception tablets",
    description:
      "Create the kiosk links a reception tablet runs on, and rotate them. A kiosk link needs no login and lists every employee by name and department to whoever opens it — which is what makes this separate from simply reading the book.",
    defaultRoles: ["MANAGEMENT"],
    tier: "sensitive",
  },
  {
    key: "engagement.readFeedback",
    label: "Read anonymous feedback",
    description:
      "See everything sent through the internal anonymous channel. The channel records nothing about who wrote an item, so this grants sight of the text and no way whatsoever to identify its author. HR, directors and admins.",
    defaultRoles: ["MANAGEMENT"],
    tier: "sensitive",
    // Managing somebody does not entitle you to read what people say about them.
    delegable: false,
  },
  {
    key: "engagement.manage",
    label: "Create forms, polls and votes",
    description:
      "Build and publish internal forms, set who they go to, and read the results. Results stay hidden until five people have answered, whoever holds this.",
    defaultRoles: ["MANAGEMENT"],
  },
  {
    key: "vault.use",
    label: "Use the credential vault",
    description:
      "Store your own logins and open the ones shared with you. Everyone who needs a password from the vault needs this; it grants nothing on records nobody has shared.",
    defaultRoles: ["MANAGEMENT", "SALES", "SUPPORT", "ACCOUNTS", "PURCHASE"],
  },
  {
    key: "vault.viewAll",
    label: "See every vault record",
    description:
      "Open any stored credential, including ones nobody shared. The owner is notified every time this override is used, and it is recorded on the record — so it is visibility, not invisibility. Grant it to as few people as the work allows.",
    defaultRoles: [],
    tier: "critical",
    // Managing somebody is not the same as being entitled to their passwords.
    delegable: false,
  },
  {
    key: "vault.manageTags",
    label: "Manage vault categories",
    description: "Edit the category and access-type lists the vault files credentials under.",
    defaultRoles: ["MANAGEMENT"],
  },
  {
    key: "projects.manage",
    label: "Run projects",
    description:
      "Create and edit projects, milestones, risks, billing stages and the stakeholder list. Seeing a project still requires being on it.",
    defaultRoles: ["MANAGEMENT", "SUPPORT"],
  },
  {
    key: "projects.viewAll",
    label: "See every project",
    description:
      "Projects are visible to their stakeholders only. This overrides that. Grant it sparingly — it exists so the module stays administrable when the last stakeholder on a project leaves, not as a convenience.",
    defaultRoles: ["MANAGEMENT"],
    tier: "sensitive",
  },
  {
    key: "projects.credentials",
    label: "Open stored credentials",
    description:
      "Reveal the passwords and keys stored against a project. Every reveal needs the viewer's own password, is recorded against the credential, and notifies the project manager. Being a stakeholder is not enough on its own.",
    defaultRoles: [],
    // Nobody holds this by default, including Management. It is the one key in this module that
    // hands over somebody else's customer's systems.
    tier: "critical",
    delegable: false,
  },
  {
    key: "people.handover",
    label: "Hand over someone's work",
    description:
      "Move a person's accounts, leads, tickets, open quotes and equipment to colleagues — for a resignation, a long absence or a change of territory. It reassigns live work only: it never touches who created, approved or was paid for anything, and never touches anyone's own HR records.",
    defaultRoles: ["MANAGEMENT"],
    // Sensitive rather than standard: one screen can re-point an entire book of business, and the
    // people affected find out by the work appearing in their queue.
    tier: "sensitive",
  },
  {
    key: "hr.viewAll",
    label: "See everyone's attendance & leave",
    description:
      "View attendance and leave for the whole company rather than just your own and your team's. Managers already see their own reports without this.",
    defaultRoles: ["MANAGEMENT"],
    // Its own description is the argument: a manager already sees their reports. Inheriting this
    // *from* a report would widen that to the whole company, which is the opposite of the intent.
    delegable: false,
  },
  {
    key: "hr.approveLeave",
    label: "Approve leave for anyone",
    description:
      "Decide any leave request, not only those from people who report to you — for whoever covers while a manager is away.",
    defaultRoles: ["MANAGEMENT"],
  },
  {
    key: "payroll.manage",
    label: "Run payroll",
    description:
      "See and set salary structures, run the monthly payroll, and lock it. This is the one permission that exposes what everybody earns — grant it to as few people as the work allows.",
    defaultRoles: [],
    /**
     * Never inherited from a report.
     *
     * The description above says to grant this to as few people as the work allows, and without
     * this flag the resolver handed it to anybody who happened to manage the person who had it —
     * so putting the payroll clerk under a new manager disclosed every salary in the company to
     * that manager, silently, as a side effect of an org-chart edit.
     */
    delegable: false,
  },
  {
    key: "assets.manage",
    label: "Manage IT assets",
    description:
      "Add and edit assets, assign them to people, record movements, and run consignments — for our own estate and for clients we manage. Includes seeing licence keys.",
    defaultRoles: ["SUPPORT", "PURCHASE"],
  },
  {
    key: "assets.viewAll",
    label: "See every IT asset",
    description:
      "The whole register, including assets held by other people and estates we manage for clients. Without it, somebody sees what they are holding and nothing else.",
    defaultRoles: ["MANAGEMENT", "SUPPORT", "PURCHASE"],
  },
  {
    key: "feedback.request",
    label: "Ask customers for feedback",
    description:
      "Generate a feedback link for a customer and withdraw one. Anybody can always see what was said about their own work without this.",
    defaultRoles: ["SALES", "SUPPORT", "MANAGEMENT"],
  },
  {
    key: "feedback.viewAll",
    label: "See all customer feedback",
    description:
      "Every response, including scores naming other people. Without it somebody sees feedback about themselves, feedback they asked for, and feedback on the accounts they run.",
    defaultRoles: ["MANAGEMENT"],
  },
  {
    key: "marketing.manage",
    label: "Build campaigns",
    description:
      "Create audiences, templates and journeys, and manage the suppression list. Building something is not the same as sending it — that is a separate permission.",
    defaultRoles: ["MANAGEMENT"],
  },
  {
    key: "marketing.send",
    label: "Send campaigns",
    description:
      "Actually put a campaign in the queue, start or stop a journey, and run the scheduler by hand. This is the one action in the app that reaches thousands of customers at once and cannot be recalled.",
    defaultRoles: ["MANAGEMENT"],
  },
  {
    key: "marketing.approve",
    label: "Approve a large send",
    description:
      "Sign off a campaign above the size set in Settings. Nobody can approve their own, so this has to be held by more than one person for large sends to work at all.",
    defaultRoles: ["MANAGEMENT"],
    selfExcluded: true,
  },
  {
    key: "marketing.viewAll",
    label: "See marketing results",
    description:
      "Campaigns, journeys and what was sent to whom, including why somebody was left out. Read-only without the permissions above.",
    defaultRoles: ["MANAGEMENT", "SALES"],
  },
  {
    key: "targets.manage",
    label: "Set targets",
    description:
      "Give people and teams numbers to hit, and withdraw them. Anybody can always see their own targets and their team's without this.",
    defaultRoles: ["MANAGEMENT"],
  },
  {
    key: "targets.viewAll",
    label: "See everyone's targets",
    description:
      "The whole company's targets and how each is doing. Without it, somebody sees their own and their reports' — which is what a manager needs and what everybody else should have.",
    defaultRoles: ["MANAGEMENT"],
  },
  {
    key: "incentives.manage",
    label: "Manage incentive schemes",
    description:
      "Write the schemes that turn targets into money, attach them to targets, and work out what is owed at the end of a period.",
    defaultRoles: ["MANAGEMENT"],
  },
  {
    key: "incentives.approve",
    label: "Approve and pay incentives",
    description:
      "Decide what actually goes out — approve, hold, cancel or pay. Nobody can decide their own, whatever permissions they hold.",
    defaultRoles: ["ACCOUNTS"],
    selfExcluded: true,
  },
  {
    key: "activity.viewAll",
    label: "See everyone's activity log",
    description:
      "Every sign-in, export, refused permission and blocked crawler, for the whole company. Without it, somebody sees only their own activity — which everybody can, and should, so the logging is not a secret.",
    // Deliberately not SALES or SUPPORT: who looked at which customer is the kind of thing that
    // gets used to settle an argument about account ownership rather than to investigate a leak.
    defaultRoles: ["MANAGEMENT"],
  },
  {
    key: "activity.export",
    label: "Export the activity log",
    description:
      "Download activity as a file, for an audit or an investigation. Separated from viewing because the export is itself the thing most worth logging.",
    defaultRoles: ["MANAGEMENT"],
  },
  {
    key: "permissions.view",
    label: "Review who can do what",
    description:
      "Open the access screens and see any person's effective permissions and where each one comes from. Read-only — it grants nothing itself, which is what makes it safe to hand to an auditor.",
    defaultRoles: ["MANAGEMENT"],
    group: "Administration",
    delegable: false,
    tier: "sensitive",
  },
  {
    key: "portal.manage",
    label: "Manage the customer portal",
    description:
      "Switch the customer portal on, decide whether every customer gets one or only chosen ones, choose what a customer can see of their own account, issue and revoke their links, and work through what they have asked for. This decides what people outside the company can read, which is why it is not simply part of managing a customer record.",
    defaultRoles: ["MANAGEMENT"],
    group: "Administration",
    delegable: false,
    tier: "sensitive",
  },
  {
    key: "purchase.reconcile",
    label: "Reconcile vendor statements",
    description:
      "Upload a distributor's monthly statement and compare it against what we actually sold — seat counts, unit costs, and subscriptions billed for that no live order covers. Includes clearing an exception once it has been chased, which is why it is not simply given to everyone who can see a purchase order: the value of the list is that the things cleared from it were genuinely resolved.",
    defaultRoles: ["PURCHASE", "ACCOUNTS", "MANAGEMENT"],
    group: "Finance",
    delegable: true,
    tier: "sensitive",
  },
  {
    key: "backups.manage",
    label: "Take database backups",
    description:
      "See the backup log and take one on demand. A backup is a complete copy of the system — every order, every password hash, every encrypted secret — so this is the ability to create one, not to read it: the files are written to the server and are not downloadable through the app. Restoring is a command-line operation with the application stopped, and no permission grants it.",
    defaultRoles: [],
    group: "Administration",
    // Not inherited from managing whoever administers the system. Taking a copy of everything is
    // its own decision.
    delegable: false,
    tier: "critical",
  },
  {
    key: "permissions.manage",
    label: "Change roles and permissions",
    description:
      "Grant and revoke permissions, for a role or for one person. Bounded by what the grantor holds themselves — nobody can hand out access they do not have — and never covers the super-admin-only keys.",
    defaultRoles: [],
    group: "Administration",
    // Never inherited from a report. Managing the person who administers access is not the same
    // as being entitled to administer it.
    delegable: false,
    tier: "critical",
  },
  {
    key: "users.manage",
    label: "Create and edit users",
    description: "Add accounts, change names, departments and reporting lines, deactivate leavers, and reset two-factor.",
    defaultRoles: [],
    group: "Administration",
    delegable: false,
    tier: "sensitive",
  },
  {
    key: "users.assignRole",
    label: "Change somebody's role",
    description:
      "Move a person between roles. Reserved to a super admin: a role change is the fastest route to escalation, because it grants a whole set of permissions at once rather than one reviewable key.",
    defaultRoles: [],
    group: "Administration",
    delegable: false,
    superAdminOnly: true,
    tier: "critical",
  },
  {
    key: "settings.manage",
    label: "Change organisation settings",
    description: "Company identity, invoicing and e-invoicing credentials, branding, numbering, and which modules are switched on.",
    defaultRoles: [],
    group: "Administration",
    delegable: false,
    tier: "critical",
  },
  {
    key: "security.manage",
    label: "Change the security and DLP policy",
    description: "Sign-in policy, data-loss-prevention settings, crawler blocking and log retention.",
    defaultRoles: [],
    group: "Administration",
    delegable: false,
    superAdminOnly: true,
    tier: "critical",
  },
  {
    key: "impersonation.use",
    label: "View the app as another user",
    description:
      "Borrow somebody's account to see exactly what they see. Every action taken while doing so is attributed to the admin behind it, and a super admin can never be impersonated.",
    defaultRoles: [],
    group: "Administration",
    delegable: false,
    superAdminOnly: true,
    tier: "critical",
  },
  {
    key: "catalog.manage",
    label: "Manage brands, families & industries",
    description:
      "The reference lists behind the item and company pickers — brands, their product families, and the industry list. This is editing a list that thousands of records point at rather than the records themselves: renaming a brand renames it on every item at once.",
    defaultRoles: [],
  },
  {
    key: "ledger.post",
    label: "Write and reverse journal entries",
    description:
      "Hand-write a journal — opening balances, depreciation, a correction the documents cannot express — and reverse an existing one. Nothing here edits or deletes a posting: a mistake is corrected by a dated reversal that stays visible, which is what makes a ledger a ledger.",
    defaultRoles: [],
    delegable: false,
    tier: "sensitive",
  },
  {
    key: "ledger.viewReports",
    label: "See the books",
    description:
      "Open the trial balance, profit & loss, balance sheet, any account's ledger and the journal. This is every figure the company has — what it earns, what it owes, what it pays people in aggregate — so it is a narrower question than being able to record a payment.",
    defaultRoles: ["ACCOUNTS", "MANAGEMENT"],
    // Not inherited from a report: managing one accountant should not open the company's books.
    delegable: false,
  },
  {
    key: "ledger.manageAccounts",
    label: "Change the chart of accounts",
    description:
      "Add, rename, re-parent, archive and delete ledger accounts. Structural rather than day-to-day: an account's type decides whether its balance lands in the P&L or on the balance sheet, so this reshapes every report at once.",
    defaultRoles: [],
    delegable: false,
    tier: "sensitive",
  },
  {
    key: "books.close",
    label: "Lock periods and close the year",
    description:
      "Set the date before which nothing may be posted, and run the year-end entry that moves profit into reserves. Deliberately not the same permission as posting: whoever writes the entries should not also be able to unlock the period they wrote them into, or the lock has no teeth.",
    defaultRoles: [],
    delegable: false,
    tier: "sensitive",
  },
  {
    key: "workspace.manageAny",
    label: "Act on anyone's saved list",
    description:
      "Edit, delete, assign, open a private one, and start or re-share a calling activity on a list somebody else built. Everyone can already do all of this to their own — this is the override for a list whose owner has left, is away, or built it for a team that now needs it back.",
    defaultRoles: [],
  },
  {
    key: "companies.viewAll",
    label: "See every account, not just your own",
    description:
      "Without this, somebody sees only the companies they are account manager for — plus, if they manage people, their reports' accounts. Everything hanging off a company follows the same line: its orders, payments, renewals, leads, tickets, contacts and documents. Grant it to the functions that serve every account rather than own some, such as accounts, purchasing and support.",
    // Everyone except SALES, which reproduces today's behaviour for every other role and narrows
    // only the one the request was about. A sales *manager* holds the SALES role too and stays
    // scoped — their breadth comes from their reporting line, which is the point.
    defaultRoles: ["MANAGEMENT", "ACCOUNTS", "PURCHASE", "SUPPORT", "PROFILE", "CALLING"],
    group: "Sales & customers",
    tier: "sensitive",
  },
  {
    key: "data.exportCrm",
    label: "Export customer data",
    description:
      "Download companies, customers, contacts, tickets, visits, assets, saved lists and the suppression list as a file. Returns only the accounts the person can already see — export never widens visibility, it decides whether what you can see may leave the building.",
    defaultRoles: [],
    group: "Data import & export",
    delegable: false,
    tier: "sensitive",
  },
  {
    key: "data.importCrm",
    label: "Import customer data",
    description:
      "Bring companies, contacts and related records in from a file. Riskier than export: a bad import creates duplicates that are tedious to unpick and silently wrong until somebody notices.",
    defaultRoles: [],
    group: "Data import & export",
    delegable: false,
    tier: "sensitive",
  },
  {
    key: "data.exportFinance",
    label: "Export financial data",
    description:
      "Orders, renewals, payments, expenses, statements of account and the ledger. Orders, renewals and payments are export-only — they are records of processes the system ran, not descriptions that can be handed back to it.",
    defaultRoles: [],
    group: "Data import & export",
    delegable: false,
    tier: "sensitive",
  },
  {
    key: "data.importFinance",
    label: "Import financial data",
    description:
      "The chart of accounts and expense claims. Deliberately narrow: nothing here can create an order, a payment or a journal entry, because those must come through the flows that also write the ledger.",
    defaultRoles: [],
    group: "Data import & export",
    delegable: false,
    tier: "critical",
  },
  {
    key: "data.exportCatalog",
    label: "Export the catalog",
    description:
      "Products, services and subscriptions with their brands and product families. Prices are what a competitor would most like to have, so this is separate from the rest of the customer data.",
    defaultRoles: [],
    group: "Data import & export",
    delegable: false,
    tier: "sensitive",
  },
  {
    key: "data.importCatalog",
    label: "Import the catalog",
    description:
      "Bulk-load items from a spreadsheet — see public/items-import-template.csv. The most routine import here, and the one most likely to be handed to somebody who is not an admin.",
    defaultRoles: [],
    group: "Data import & export",
    delegable: false,
  },
  {
    key: "data.exportPeople",
    label: "Export employee data",
    description:
      "Employee records, attendance, leave, documents and candidates. Salary figures and bank details are omitted from every export regardless of this permission — see the redaction policy.",
    defaultRoles: [],
    group: "Data import & export",
    delegable: false,
    tier: "critical",
  },
  {
    key: "data.importPeople",
    label: "Import employee data",
    description:
      "Bring employee records and candidates in from a file, for a bulk onboarding or a migration from another HR system.",
    defaultRoles: [],
    group: "Data import & export",
    delegable: false,
    tier: "critical",
  },
  {
    key: "data.exportUsers",
    label: "Export user accounts",
    description:
      "Accounts, roles, departments and reporting lines. Never includes password hashes or two-factor secrets, which have no legitimate export.",
    defaultRoles: [],
    group: "Data import & export",
    delegable: false,
    superAdminOnly: true,
    tier: "critical",
  },
  {
    key: "data.importUsers",
    label: "Import user accounts",
    description:
      "Create accounts in bulk from a file. Reserved to a super admin: creating accounts is the shortest route to creating one for yourself with a role you were never granted.",
    defaultRoles: [],
    group: "Data import & export",
    delegable: false,
    superAdminOnly: true,
    tier: "critical",
  },
] as const satisfies readonly PermissionDefinition[];

/**
 * The literal union of every declared key.
 *
 * Derived from the array rather than written out separately, so the two cannot drift. Threading
 * this type through `can()`, `setRolePermission`, `navPermissions` and `NavItem.permission` is what
 * makes an undeclared key impossible to introduce — through an action, the nav registry or the
 * admin UI alike.
 */
export type PermissionKey = (typeof PERMISSION_REGISTRY)[number]["key"];

/**
 * The same list, widened to the declared type.
 *
 * `as const` above is what makes `PermissionKey` a literal union, but it also narrows every entry
 * to its own exact shape — so an entry that omits `tier` genuinely has no `tier` property and
 * reading one is a type error. Iterate over this when you need the fields; use PERMISSION_REGISTRY
 * only where the literal key types matter.
 */
export const PERMISSIONS: readonly PermissionDefinition[] = PERMISSION_REGISTRY;

const BY_KEY: Map<string, PermissionDefinition> = new Map(PERMISSIONS.map((p) => [p.key, p]));

export function getPermissionDefinition(key: string): PermissionDefinition | undefined {
  return BY_KEY.get(key);
}

export function isPermissionKey(key: string): key is PermissionKey {
  return BY_KEY.has(key);
}

export const PERMISSION_KEYS = PERMISSION_REGISTRY.map((p) => p.key) as PermissionKey[];

/** Section order in the permission screen; anything ungrouped is collected under "Other". */
export const PERMISSION_GROUP_ORDER = [
  "Sales & customers",
  "Orders & fulfilment",
  "Finance",
  "Support",
  "Marketing",
  "People & HR",
  "Performance",
  "IT assets",
  "Data import & export",
  "Administration",
  "Other",
] as const;

/**
 * Section by key prefix, so an entry only needs an explicit `group` when the prefix is misleading.
 *
 * A lookup rather than a field on all ~40 entries: the grouping is a property of the namespace, and
 * duplicating it per key is how the two drift apart.
 */
const GROUP_BY_PREFIX: Record<string, string> = {
  products: "Orders & fulfilment",
  orders: "Orders & fulfilment",
  payments: "Finance",
  expenses: "Finance",
  contacts: "Sales & customers",
  feedback: "Sales & customers",
  visits: "Sales & customers",
  tickets: "Support",
  tasks: "Support",
  marketing: "Marketing",
  hr: "People & HR",
  payroll: "People & HR",
  performance: "Performance",
  targets: "Performance",
  incentives: "Performance",
  assets: "IT assets",
  purchase: "Finance",
  // These five had no prefix entry, so eleven keys — including the credential vault's — were
  // filed under a heading called "Other" on the permission screen.
  vault: "Administration",
  visitors: "Support",
  engagement: "People & HR",
  projects: "Orders & fulfilment",
  people: "People & HR",
  activity: "Administration",
  permissions: "Administration",
  users: "Administration",
  settings: "Administration",
  security: "Administration",
  impersonation: "Administration",
  data: "Data import & export",
  catalog: "Orders & fulfilment",
  ledger: "Finance",
  books: "Finance",
  workspace: "Sales & customers",
};

export function permissionGroup(def: PermissionDefinition): string {
  if (def.group) return def.group;
  return GROUP_BY_PREFIX[def.key.split(".")[0]!] ?? "Other";
}

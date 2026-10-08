import type { Role } from "@/lib/roles";
import type { PermissionKey } from "@/lib/permissions";

/**
 * What appears on somebody's dashboard, and whose data it is.
 *
 * Three questions decide whether a widget is shown, and they are genuinely different:
 *
 *   1. **Is the module on?** (`moduleKey`) — does this company use the feature at all.
 *   2. **May this person see it?** (`permission`) — is it any of their business.
 *   3. **Is it their business?** (`roles`) — a calling agent and an accountant can both legitimately
 *      see the renewals figure, and only one of them wants it on their home screen.
 *
 * The old registry answered only the first, which is why a dashboard looked identical for everyone.
 *
 * ## Scope
 *
 * `scope` is the half that matters most and was missing entirely. Every figure was company-wide:
 * a calling agent's home screen showed the total open pipeline value for the business. That is not
 * a personalization problem, it is a disclosure one. A widget now declares whose rows it counts,
 * and the action narrows the query to match — falling back from company to team to own depending on
 * whether the viewer holds the corresponding `*.viewAll` permission.
 *
 * The label is shown on the card ("yours", "you and your team", "company-wide") because a number
 * without a scope is worse than no number: two people comparing screens will otherwise conclude one
 * of them is wrong.
 */

export type WidgetScope = "own" | "team" | "company";

export type DashboardWidgetDefinition = {
  key: string;
  label: string;
  description: string;
  /** The module this widget's data depends on — null for widgets built on core (always-on) data. */
  moduleKey: string | null;
  /** Hidden unless the viewer holds this. Null means everyone with the module. */
  permission?: PermissionKey;
  /**
   * The widest scope this widget will ever show. The action narrows it further per viewer:
   * `company` degrades to `team` and then to `own` if the viewer lacks the view-all permission.
   */
  scope: WidgetScope;
  /** The permission that widens this widget from "your team" to "the whole company". */
  viewAllPermission?: PermissionKey;
  /**
   * The roles this belongs to by default — the "work area" half of personalization. A user who has
   * never customised their dashboard gets exactly these; anybody can then add any widget they are
   * permitted to see.
   */
  roles: readonly Role[];
  /**
   * How much of the row it takes.
   *
   * "stat" is a single figure and occupies one column; "wide" is a list and takes two, because a
   * list of five things squeezed into a third of the width wraps every line. Declared here rather
   * than in the page so the grid can lay out widgets it has been handed in any order — which is
   * the whole point of letting people rearrange them.
   */
  size: "stat" | "wide";
};

const EVERYONE: readonly Role[] = ["ADMIN", "MANAGEMENT", "SALES", "CALLING", "PROFILE", "SUPPORT", "ACCOUNTS", "PURCHASE"];

export const DASHBOARD_WIDGET_REGISTRY: DashboardWidgetDefinition[] = [
  {
    key: "tasks",
    label: "My open tasks",
    description: "Tasks assigned to you that are open or overdue.",
    moduleKey: "tasks",
    scope: "own",
    // The one widget that was already correctly scoped, and the model for the rest.
    roles: EVERYONE,
    size: "stat",
  },
  {
    key: "notes",
    label: "Sticky notes",
    description: "What is on your board — your own notes and the ones shared with you, pinned first.",
    moduleKey: "notes",
    // Not a count. Every other widget here answers "how many", and a note whose number you know but
    // whose text you don't is no use at all — the whole point is to be read in passing.
    scope: "own",
    roles: EVERYONE,
    size: "wide",
  },
  {
    key: "activity",
    label: "Latest activity",
    description: "The most recent things done in the CRM — yours, or everybody's if you can see the whole log.",
    moduleKey: null,
    // Degrades honestly: without `activity.viewAll` this is your own trail and says so. The log
    // is deliberately not secret from the people in it — see the sidebar note on /activity.
    scope: "company",
    viewAllPermission: "activity.viewAll",
    roles: EVERYONE,
    size: "wide",
  },
  {
    key: "quotations",
    label: "Pending quotations",
    description: "Proposals sent and still waiting on an answer, with how much is riding on them.",
    moduleKey: "sales_documents",
    // Narrowed to the accounts this person manages, like every other customer-facing figure.
    scope: "company",
    viewAllPermission: "companies.viewAll",
    roles: ["ADMIN", "MANAGEMENT", "SALES", "ACCOUNTS"],
    size: "stat",
  },
  {
    key: "salesTarget",
    label: "Monthly sales target",
    description: "Your own target for this month, what you have done against it, and whether that is on pace.",
    moduleKey: "targets",
    // Always your own, never the team's. A manager who wants the team's numbers wants the
    // Targets screen, which shows each person separately rather than one merged figure that
    // belongs to nobody.
    scope: "own",
    roles: ["ADMIN", "MANAGEMENT", "SALES", "ACCOUNTS"],
    size: "stat",
  },
  {
    key: "incomeExpense",
    label: "Income and expense",
    description: "Money earned against money spent, month by month across the financial year.",
    moduleKey: "accounting",
    // Read off the ledger, so the figure is the company's — there is no per-salesperson
    // version of a cash balance. Gated rather than scoped for exactly that reason.
    permission: "payments.manage",
    scope: "company",
    roles: ["ADMIN", "MANAGEMENT", "ACCOUNTS"],
    size: "wide",
  },
  {
    key: "topExpenses",
    label: "Top expenses",
    description: "Where the money went — the largest expense accounts this financial year.",
    moduleKey: "accounting",
    // Read off the ledger, so the figure is the company's — there is no per-salesperson
    // version of a cash balance. Gated rather than scoped for exactly that reason.
    permission: "payments.manage",
    scope: "company",
    roles: ["ADMIN", "MANAGEMENT", "ACCOUNTS"],
    size: "stat",
  },
  {
    key: "cashFlow",
    label: "Cash flow",
    description: "What the bank and cash accounts did over the last twelve months.",
    moduleKey: "accounting",
    // Read off the ledger, so the figure is the company's — there is no per-salesperson
    // version of a cash balance. Gated rather than scoped for exactly that reason.
    permission: "payments.manage",
    scope: "company",
    roles: ["ADMIN", "MANAGEMENT", "ACCOUNTS"],
    size: "wide",
  },
  {
    key: "receivables",
    label: "Total receivables",
    description: "What customers owe, split by whether it is late yet.",
    moduleKey: "accounting",
    // Read off the ledger, so the figure is the company's — there is no per-salesperson
    // version of a cash balance. Gated rather than scoped for exactly that reason.
    permission: "payments.manage",
    scope: "company",
    roles: ["ADMIN", "MANAGEMENT", "ACCOUNTS"],
    size: "stat",
  },
  {
    key: "payables",
    label: "Total payables",
    description: "What is owed to vendors, split by whether it is late yet.",
    moduleKey: "accounting",
    // Read off the ledger, so the figure is the company's — there is no per-salesperson
    // version of a cash balance. Gated rather than scoped for exactly that reason.
    permission: "payments.manage",
    scope: "company",
    roles: ["ADMIN", "MANAGEMENT", "ACCOUNTS"],
    size: "stat",
  },
  {
    key: "myProjects",
    label: "My projects",
    description: "The delivery work you're on, most overdue first, with how far through it is.",
    moduleKey: "projects",
    permission: "projects.manage",
    /**
     * Always "own", and deliberately without a viewAllPermission.
     *
     * Every other widget here widens when the viewer holds the matching view-all key. This one must
     * not. A project is visible to its stakeholders, and a home screen that widened for a delivery
     * head would put customers' implementations — and the fact that credentials are stored against
     * them — on a page nobody asked to open. Anybody wanting every project has the Projects screen.
     */
    scope: "own",
    roles: ["ADMIN", "MANAGEMENT", "SUPPORT"],
    size: "wide",
  },
  {
    key: "projectsAtRisk",
    label: "Projects needing attention",
    description: "How many of your live projects are at risk or off track.",
    moduleKey: "projects",
    permission: "projects.manage",
    scope: "own",
    roles: ["ADMIN", "MANAGEMENT", "SUPPORT"],
    size: "stat",
  },
  {
    key: "companies",
    label: "Companies",
    description: "The sourcing pool — prospects, leads, and won deals still awaiting their first order.",
    // The Companies section's: hidden with it when a role's "Companies & Leads" section is unticked.
    moduleKey: "companies",
    scope: "company",
    roles: ["ADMIN", "MANAGEMENT", "PROFILE", "CALLING", "SALES"],
    size: "stat",
  },
  {
    key: "customers",
    label: "Customers",
    description: "Companies that have actually purchased something.",
    moduleKey: "companies",
    scope: "company",
    roles: ["ADMIN", "MANAGEMENT", "SALES", "ACCOUNTS", "SUPPORT"],
    size: "stat",
  },
  {
    key: "leads",
    label: "Open leads",
    description: "Open lead count and open pipeline value.",
    moduleKey: null,
    scope: "team",
    // Without this the pipeline total was on every screen in the building.
    viewAllPermission: "targets.viewAll",
    roles: ["ADMIN", "MANAGEMENT", "SALES", "CALLING"],
    size: "stat",
  },
  {
    key: "recentLeads",
    label: "Recently updated leads",
    description: "The five leads that moved most recently.",
    moduleKey: null,
    scope: "team",
    viewAllPermission: "targets.viewAll",
    roles: ["ADMIN", "MANAGEMENT", "SALES", "CALLING"],
    size: "wide",
  },
  {
    key: "vendors",
    label: "Vendors onboarding",
    description: "Vendor onboarding status counts.",
    moduleKey: "vendors",
    scope: "company",
    roles: ["ADMIN", "MANAGEMENT", "PURCHASE", "ACCOUNTS"],
    size: "stat",
  },
  {
    key: "renewals",
    label: "Renewals expiring soon",
    description: "Subscriptions expiring in the next 30 days.",
    moduleKey: "renewals",
    scope: "team",
    viewAllPermission: "products.edit",
    roles: ["ADMIN", "MANAGEMENT", "SALES", "ACCOUNTS"],
    size: "stat",
  },
  {
    key: "upcomingRenewals",
    label: "Upcoming renewals list",
    description: "The next five subscriptions coming up for renewal.",
    moduleKey: "renewals",
    scope: "team",
    viewAllPermission: "products.edit",
    roles: ["ADMIN", "MANAGEMENT", "SALES"],
    size: "wide",
  },
  {
    key: "payments",
    label: "Outstanding balance",
    description: "Unpaid and partially paid order totals.",
    moduleKey: "payments",
    permission: "payments.record",
    scope: "company",
    roles: ["ADMIN", "MANAGEMENT", "ACCOUNTS"],
    size: "stat",
  },
  {
    key: "tickets",
    label: "Open tickets",
    description: "Open and SLA-overdue support ticket counts.",
    moduleKey: "helpdesk",
    scope: "team",
    viewAllPermission: "tickets.create",
    roles: ["ADMIN", "MANAGEMENT", "SUPPORT"],
    size: "stat",
  },
  {
    key: "expenses",
    label: "Expenses awaiting you",
    description: "Claims waiting on your approval, and your own claims not yet reimbursed.",
    moduleKey: "expenses",
    scope: "own",
    roles: ["ADMIN", "MANAGEMENT", "ACCOUNTS", "SALES", "SUPPORT", "PURCHASE"],
    size: "stat",
  },
  {
    key: "orders",
    label: "Orders needing action",
    description: "Orders waiting for approval, and approved orders waiting to be sourced.",
    moduleKey: "orders",
    permission: "orders.approve",
    scope: "company",
    roles: ["ADMIN", "MANAGEMENT", "ACCOUNTS", "PURCHASE"],
    size: "stat",
  },
];

const BY_KEY = new Map(DASHBOARD_WIDGET_REGISTRY.map((w) => [w.key, w]));

export function getDashboardWidgetDefinition(key: string) {
  return BY_KEY.get(key);
}

/** The default set for somebody who has never customised — their work area, in other words. */
export function defaultWidgetsForRole(role: Role): string[] {
  return DASHBOARD_WIDGET_REGISTRY.filter((w) => (w.roles as readonly Role[]).includes(role)).map((w) => w.key);
}

export const SCOPE_LABEL: Record<WidgetScope, string> = {
  own: "yours",
  team: "you and your team",
  company: "company-wide",
};

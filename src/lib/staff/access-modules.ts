import { PERMISSIONS, permissionGroup, type PermissionDefinition } from "@/lib/permissions";
import type { AccessAction, AccessRecord } from "@/lib/authz/access";

/**
 * The modules the Roles & Permissions and Users screens are arranged by — "CRM", "Finance", "HR" —
 * each with the record types it holds (src/lib/authz/access.ts), its own permissions, and the menu
 * sections its "Module enabled" switch shows or hides. A way of laying out the one model, not a second
 * one: every row on those screens is a permission key or a record level, saved through the actions
 * that always saved them.
 *
 * A permission is filed by name where a module claims it (`keys`), and otherwise by its group in the
 * registry (`groups`); a section switch is filed by `sections`. Anything left over lands in Settings,
 * so a key added tomorrow still shows up somewhere.
 *
 * Dependency-free (the permission registry and types), so client components can lay themselves out
 * from it.
 */

export type ModuleIcon =
  | "crm"
  | "sales"
  | "purchases"
  | "products"
  | "projects"
  | "finance"
  | "support"
  | "marketing"
  | "hr"
  | "performance"
  | "assets"
  | "work"
  | "data"
  | "settings";

export type AccessModule = {
  key: string;
  label: string;
  description: string;
  icon: ModuleIcon;
  /** Record types whose reach is set here, in this order. */
  records: AccessRecord[];
  /** Permissions filed here by name, ahead of their group. */
  keys: string[];
  /** The permission groups (`permissionGroup`) filed here, for anything not claimed by name. */
  groups: string[];
  /** The menu section switches this module's "Module enabled" shows or hides. */
  sections: string[];
};

export const ACCESS_MODULES: readonly AccessModule[] = [
  {
    key: "crm",
    label: "CRM",
    description: "Leads, Contacts, Companies, Calls, Visits",
    icon: "crm",
    records: ["leads", "companies", "contacts", "activities", "visits"],
    keys: [
      "leads.view",
      "leads.assign",
      "contacts.view",
      "contacts.viewRestricted",
      "companies.viewAll",
      "companies.manageCategories",
      "companies.merge",
      "accounts.reassign",
      "accounts.handOffOwn",
      "calls.view",
      "visits.view",
      "visits.viewAll",
      "activities.viewAll",
      "emails.view",
      "meetings.schedule",
      "notes.broadcast",
      "workspace.manageAny",
      "pipeline.manage",
      "booking.manage",
    ],
    groups: ["Sales & customers"],
    sections: ["section.leads", "section.companies", "section.workspace", "section.domains", "section.calls", "section.booking", "section.contactsLibrary", "section.resellers", "section.commissionParties", "section.visits"],
  },
  {
    key: "sales",
    label: "Sales",
    description: "Orders, Quotes & Invoices, Renewals, Wins",
    icon: "sales",
    records: ["orders", "documents"],
    keys: ["orders.view", "orders.approve", "orders.process", "orders.approveLoss", "documents.view", "documents.issue", "documents.send", "documents.void", "forecast.manage", "wins.manage", "wins.tv"],
    groups: [],
    sections: ["section.orders", "section.renewals", "section.salesDocuments", "section.wins", "section.forecast"],
  },
  {
    key: "purchases",
    label: "Purchases",
    description: "Vendors, Purchase Orders, Payables",
    icon: "purchases",
    records: ["vendors"],
    keys: ["purchase.raiseOrders", "purchase.reconcile"],
    groups: [],
    sections: ["section.purchaseDocuments", "section.vendors", "section.payables"],
  },
  {
    key: "products",
    label: "Products",
    description: "Items, Inventory, Pricing",
    icon: "products",
    records: [],
    keys: ["products.edit", "products.delete", "catalog.manage"],
    groups: [],
    sections: ["section.items"],
  },
  {
    key: "projects",
    label: "Projects",
    description: "Projects, Delivery, Credentials",
    icon: "projects",
    records: ["projects"],
    keys: ["projects.view", "projects.manage", "projects.viewAll", "projects.credentials"],
    groups: [],
    sections: ["section.projects"],
  },
  {
    key: "finance",
    label: "Finance",
    description: "Payments, Expenses, Ledger, Close",
    icon: "finance",
    records: ["payments", "expenses"],
    keys: [],
    groups: ["Finance"],
    sections: ["section.payments", "section.receivables", "section.accounting", "section.revenueClose", "section.expenses"],
  },
  {
    key: "support",
    label: "Support",
    description: "Tickets, Customer Portal, Feedback",
    icon: "support",
    records: ["tickets"],
    keys: ["tickets.view", "tickets.create", "tickets.delete", "portal.manage", "feedback.request", "feedback.viewAll"],
    groups: ["Support"],
    sections: ["section.helpdesk", "section.customerPortal", "section.feedback"],
  },
  {
    key: "marketing",
    label: "Marketing",
    description: "Campaigns, Journeys, Forms, Events",
    icon: "marketing",
    records: [],
    keys: [],
    groups: ["Marketing"],
    sections: ["section.marketing", "section.forms"],
  },
  {
    key: "people",
    label: "HR",
    description: "Employees, Leave, Payroll, Hiring",
    icon: "hr",
    records: [],
    keys: ["visitors.view", "visitors.manage"],
    groups: ["People & HR"],
    sections: ["section.hr", "section.visitors", "section.engagement", "section.payroll"],
  },
  {
    key: "performance",
    label: "Performance",
    description: "Targets, Incentives, Reports",
    icon: "performance",
    records: [],
    keys: [],
    groups: ["Performance"],
    sections: ["section.targets", "section.incentives", "section.reports"],
  },
  {
    key: "assets",
    label: "IT assets",
    description: "Laptops, Licences, Holders",
    icon: "assets",
    records: [],
    keys: [],
    groups: ["IT assets"],
    sections: ["section.itAssets"],
  },
  {
    key: "work",
    label: "My work",
    description: "Tasks, Calendar, Notes, Chat, Vault",
    icon: "work",
    records: ["tasks"],
    keys: ["tasks.delete", "vault.use", "vault.viewAll", "vault.manageTags", "signatures.manage", "cards.manage", "copilot.use"],
    groups: [],
    sections: ["section.notifications", "section.tasks", "section.calendar", "section.notes", "section.chat", "section.cards", "section.signatures", "section.vault"],
  },
  {
    key: "data",
    label: "Import & export",
    description: "Bulk data in and out, per area",
    icon: "data",
    records: [],
    keys: [],
    groups: ["Data import & export"],
    sections: [],
  },
  {
    key: "admin",
    label: "Settings",
    description: "Users, Roles, Security, Backups",
    icon: "settings",
    records: [],
    keys: [],
    groups: ["Administration", "Other"],
    sections: [],
  },
];

const BY_KEY = new Map<string, string>(ACCESS_MODULES.flatMap((m) => [...m.keys, ...m.sections].map((k) => [k, m.key] as const)));
const BY_GROUP = new Map<string, string>(ACCESS_MODULES.flatMap((m) => m.groups.map((g) => [g, m.key] as const)));

export function isSectionKey(key: string): boolean {
  return key.startsWith("section.");
}

/** The module a permission sits in: by name, then by its group, then Settings. */
export function moduleOfPermission(def: PermissionDefinition): string {
  return BY_KEY.get(def.key) ?? BY_GROUP.get(permissionGroup(def)) ?? "admin";
}

/** The permissions of one module (its menu sections apart), in the registry's order. */
export function permissionsOfModule(moduleKey: string): PermissionDefinition[] {
  return PERMISSIONS.filter((def) => !isSectionKey(def.key) && moduleOfPermission(def) === moduleKey);
}

/** The menu section switches one module's "Module enabled" covers, in the registry's order. */
export function sectionsOfModule(moduleKey: string): PermissionDefinition[] {
  const m = accessModule(moduleKey);
  if (!m) return [];
  return PERMISSIONS.filter((def) => m.sections.includes(def.key));
}

export function accessModule(key: string): AccessModule | undefined {
  return ACCESS_MODULES.find((m) => m.key === key);
}

export type ModuleStanding = "full" | "limited" | "none";

/**
 * How much of a module somebody (or a role) has: every permission and every record they could see,
 * some, or nothing — the badge beside each module. Menu sections don't count towards it: they decide
 * the menu, not what can be done.
 */
export function moduleStanding(module: AccessModule, holds: (key: string) => boolean, recordView: (record: AccessRecord) => boolean): ModuleStanding {
  const keys = permissionsOfModule(module.key).filter((d) => !d.everyone);
  const checks = [...keys.map((d) => holds(d.key)), ...module.records.map((r) => recordView(r))];
  if (checks.length === 0) return "none";
  const yes = checks.filter(Boolean).length;
  return yes === checks.length ? "full" : yes === 0 ? "none" : "limited";
}

export const STANDING_WORDS: Record<ModuleStanding, string> = { full: "Full access", limited: "Limited access", none: "No access" };

// ─── The rows of a module's Actions table ────────────────────────────────────────────────────────

/**
 * The permission that opens a record type's pages at all, where it has one: "View leads" is that key
 * and the leads' view level together. A record without one (customers, tasks…) is seen by whoever
 * reaches it.
 */
export const RECORD_VIEW_KEY: Partial<Record<AccessRecord, string>> = {
  leads: "leads.view",
  contacts: "contacts.view",
  orders: "orders.view",
  documents: "documents.view",
  payments: "payments.view",
  tickets: "tickets.view",
  projects: "projects.view",
  visits: "visits.view",
};

/**
 * Keys that only ever said how far a record's view reached ("See every account", "See all visits") —
 * the Record scope of its View row says the same, so they aren't rows of their own.
 */
export const REACH_KEYS = new Set(["companies.viewAll", "visits.viewAll", "activities.viewAll", "projects.viewAll", "expenses.viewAll"]);

const VERB: Record<AccessAction, string> = { view: "View", edit: "Edit", delete: "Delete", assign: "Assign" };

/** What an action row calls a record type: "View accounts" rather than "View customers & companies". */
const NOUN: Record<AccessRecord, string> = {
  companies: "accounts",
  vendors: "vendors",
  contacts: "contacts",
  leads: "leads",
  orders: "orders",
  documents: "documents",
  payments: "payments",
  tickets: "tickets",
  projects: "projects",
  visits: "visits",
  activities: "calls & notes",
  tasks: "tasks",
  expenses: "expenses",
};

export type ActionRowSpec =
  /** A record and an action: Allow is whether it reaches any of them; Record scope is how far. */
  | { kind: "record"; id: string; label: string; record: AccessRecord; action: AccessAction; viewKey: string | null }
  /** A permission of its own, with no record behind it: Allow alone. */
  | { kind: "key"; id: string; label: string; key: string };

/**
 * A module's actions, as its table lists them: View, Edit, Delete and Assign for each of its records
 * (with the record's label from the access grid), then every other permission of the module.
 */
export function actionRowsOf(
  moduleKey: string,
  records: { key: AccessRecord; label: string; actions: AccessAction[] }[],
): ActionRowSpec[] {
  const m = accessModule(moduleKey);
  if (!m) return [];
  const rows: ActionRowSpec[] = [];
  for (const record of m.records) {
    const row = records.find((r) => r.key === record);
    if (!row) continue;
    const noun = NOUN[record] ?? row.label.toLowerCase();
    for (const action of row.actions) {
      rows.push({
        kind: "record",
        id: `${record}:${action}`,
        label: `${VERB[action]} ${noun}`,
        record,
        action,
        viewKey: action === "view" ? (RECORD_VIEW_KEY[record] ?? null) : null,
      });
    }
  }
  const covered = new Set(Object.values(RECORD_VIEW_KEY));
  for (const def of permissionsOfModule(moduleKey)) {
    if (covered.has(def.key) || REACH_KEYS.has(def.key)) continue;
    rows.push({ kind: "key", id: def.key, label: def.label, key: def.key });
  }
  return rows;
}

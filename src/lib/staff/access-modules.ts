import { PERMISSIONS, permissionGroup, type PermissionDefinition } from "@/lib/permissions";
import type { AccessRecord } from "@/lib/authz/access";

/**
 * The modules the role and person screens are arranged by — "CRM", "Finance", "People & HR" — each
 * the record types it holds (src/lib/authz/access.ts) and the permissions filed under it
 * (src/lib/permissions.ts `permissionGroup`). A way of laying out the one model, not a second one:
 * every row on those screens is a permission key or a record level, saved through the actions that
 * always saved them.
 *
 * Dependency-free (the permission registry and a type), so client components can lay themselves out
 * from it.
 */

export type AccessModule = {
  key: string;
  label: string;
  description: string;
  /** Record types whose reach is set here, in this order. */
  records: AccessRecord[];
  /** The permission groups (`permissionGroup`) filed here. */
  groups: string[];
};

export const ACCESS_MODULES: readonly AccessModule[] = [
  {
    key: "crm",
    label: "CRM",
    description: "Leads, customers, contacts, vendors, calls and visits",
    records: ["leads", "companies", "contacts", "vendors", "activities", "visits"],
    groups: ["Sales & customers"],
  },
  { key: "orders", label: "Orders & projects", description: "Orders, subscriptions, renewals, projects and the catalogue", records: ["orders", "projects"], groups: ["Orders & fulfilment"] },
  { key: "finance", label: "Finance", description: "Invoices, payments, expenses, the ledger and the close", records: ["documents", "payments", "expenses"], groups: ["Finance"] },
  { key: "support", label: "Support", description: "Tickets, tasks, visitors and the customer portal", records: ["tickets", "tasks"], groups: ["Support"] },
  { key: "marketing", label: "Marketing", description: "Campaigns, journeys, forms and events", records: [], groups: ["Marketing"] },
  { key: "people", label: "People & HR", description: "Employees, attendance, leave, payroll and hiring", records: [], groups: ["People & HR"] },
  { key: "performance", label: "Performance", description: "Targets, incentives and team performance", records: [], groups: ["Performance"] },
  { key: "assets", label: "IT assets", description: "Laptops, licences and who holds them", records: [], groups: ["IT assets"] },
  { key: "data", label: "Import & export", description: "Bulk data in and out, per area", records: [], groups: ["Data import & export"] },
  { key: "admin", label: "Administration", description: "Users, roles, security, settings and backups", records: [], groups: ["Administration", "Other"] },
  { key: "menu", label: "Menu sections", description: "Which parts of the app appear in the menu at all", records: [], groups: ["Sections"] },
];

const BY_GROUP = new Map<string, string>(ACCESS_MODULES.flatMap((m) => m.groups.map((g) => [g, m.key] as const)));

/** The module a permission sits in. */
export function moduleOfPermission(def: PermissionDefinition): string {
  return BY_GROUP.get(permissionGroup(def)) ?? "admin";
}

/** The permissions of one module, in the registry's order. */
export function permissionsOfModule(moduleKey: string): PermissionDefinition[] {
  return PERMISSIONS.filter((def) => moduleOfPermission(def) === moduleKey);
}

export function accessModule(key: string): AccessModule | undefined {
  return ACCESS_MODULES.find((m) => m.key === key);
}

export type ModuleStanding = "full" | "limited" | "none";

/**
 * How much of a module somebody (or a role) has: every permission and every record they could see,
 * some, or nothing — the badge beside each module. Sections don't count towards it: they decide the
 * menu, not what can be done.
 */
export function moduleStanding(module: AccessModule, holds: (key: string) => boolean, recordView: (record: AccessRecord) => boolean): ModuleStanding {
  const keys = permissionsOfModule(module.key).filter((d) => !d.everyone);
  const checks = [...keys.map((d) => holds(d.key)), ...module.records.map((r) => recordView(r))];
  if (module.key === "menu") {
    const sections = permissionsOfModule("menu");
    const on = sections.filter((d) => holds(d.key)).length;
    return on === sections.length ? "full" : on === 0 ? "none" : "limited";
  }
  if (checks.length === 0) return "none";
  const yes = checks.filter(Boolean).length;
  return yes === checks.length ? "full" : yes === 0 ? "none" : "limited";
}

export const STANDING_WORDS: Record<ModuleStanding, string> = { full: "Full access", limited: "Limited access", none: "No access" };

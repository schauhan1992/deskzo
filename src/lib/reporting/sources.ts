import { can } from "@/lib/authz/resolve";
import { getSource } from "@/lib/analytics/sources";
import { effectiveSource } from "@/lib/analytics/custom";
import type { FactSource } from "@/lib/analytics/types";
import { aggregationsFor, defaultAgg } from "./engine";
import { canReadStock, expensesSource, stockSource } from "./extra-sources";
import type { Aggregation } from "./definition";

/**
 * The data sources Reporting & Analytics can build a report from (owner, 23 Oct 2026), and who may use each.
 *
 * Every source is a real table read through the rule its own screen applies — invoices the document rule, orders
 * the order rule, leads the lead rule, stock the stock reports', claims the expense rule (src/lib/analytics/sources.ts,
 * ./extra-sources.ts). This file adds what a report builder needs on top: how each is grouped and named, what each
 * field is (a date, text, rupees, a count), which aggregations a metric takes, which permission a CSV of it needs,
 * and any gate beyond the module being on. A source a person can't open is listed as locked with the reason, and
 * its fields are never sent. Server only.
 */

export type SourceGroup = "Accounts" | "Inventory and sales" | "CRM and people";
export const SOURCE_GROUPS: SourceGroup[] = ["Accounts", "Inventory and sales", "CRM and people"];

type ExportPermission = "data.exportCrm" | "data.exportFinance";

type Entry = {
  key: string;
  group: SourceGroup;
  /** What the builder calls it, where that differs from the explorer's name. */
  label: string;
  /** Rows the person may see, through its record's rule. */
  base: () => FactSource<never> | undefined;
  /** A snapshot of today: no date range applies and nothing can be charted over time. */
  snapshot?: boolean;
  /** Money and the books are a separate decision from customers (src/actions/analytics.ts EXPORT_PERMISSION). */
  exportPermission: ExportPermission;
  /** Beyond the module being on for them. */
  gate?: (userId: string) => Promise<boolean>;
  lockedReason: string;
};

const fromAnalytics = (key: string) => () => getSource(key) as FactSource<never> | undefined;

const ENTRIES: Entry[] = [
  { key: "invoices", group: "Accounts", label: "Invoices", base: fromAnalytics("invoices"), exportPermission: "data.exportFinance", lockedReason: "Needs sales documents" },
  { key: "payments", group: "Accounts", label: "Payments received", base: fromAnalytics("payments"), exportPermission: "data.exportFinance", lockedReason: "Needs payments" },
  { key: "expenses", group: "Accounts", label: "Expense claims", base: () => expensesSource as unknown as FactSource<never>, exportPermission: "data.exportFinance", lockedReason: "Needs expenses" },
  {
    key: "stock",
    group: "Inventory and sales",
    label: "Stock on hand",
    base: () => stockSource as unknown as FactSource<never>,
    snapshot: true,
    exportPermission: "data.exportFinance",
    gate: canReadStock,
    lockedReason: "Needs inventory access",
  },
  { key: "orders", group: "Inventory and sales", label: "Sales orders", base: fromAnalytics("orders"), exportPermission: "data.exportCrm", lockedReason: "Needs orders" },
  {
    key: "leads",
    group: "CRM and people",
    label: "Leads and deals",
    base: fromAnalytics("leads"),
    exportPermission: "data.exportCrm",
    // Behind "View leads", as the lead pages and the dashboard's lead figures are.
    gate: (userId) => can(userId, "leads.view"),
    lockedReason: "Needs lead access",
  },
  { key: "tickets", group: "CRM and people", label: "Tickets", base: fromAnalytics("tickets"), exportPermission: "data.exportCrm", lockedReason: "Needs the helpdesk" },
  { key: "visits", group: "CRM and people", label: "Field visits", base: fromAnalytics("visits"), exportPermission: "data.exportCrm", lockedReason: "Needs field visits" },
];

export const REPORTING_SOURCE_KEYS = ENTRIES.map((e) => e.key);
export const isReportingSource = (key: string) => ENTRIES.some((e) => e.key === key);
export const sourceEntry = (key: string) => ENTRIES.find((e) => e.key === key);

export type ModuleOn = (key: string) => Promise<boolean>;

export type OpenSource = { entry: Entry; source: FactSource<never> };

/**
 * A source as this person may report on it — module on for them, any gate held, the workspace's own fields theirs
 * to see added (src/lib/analytics/custom.ts) — or why not, in words that don't depend on what is behind it.
 */
export async function openSource(key: string, userId: string, moduleOn: ModuleOn): Promise<{ ok: true; open: OpenSource } | { ok: false; error: string; locked: boolean }> {
  const entry = sourceEntry(key);
  const base = entry?.base();
  if (!entry || !base) return { ok: false, error: "That data source isn't one Reporting can read.", locked: false };
  if (base.moduleKey && !(await moduleOn(base.moduleKey))) return { ok: false, error: `${entry.label} isn't open to you — ${entry.lockedReason.toLowerCase()}.`, locked: true };
  if (entry.gate && !(await entry.gate(userId))) return { ok: false, error: `${entry.label} isn't open to you — ${entry.lockedReason.toLowerCase()}.`, locked: true };
  const effective = await effectiveSource(base, userId);
  return { ok: true, open: { entry, source: { ...effective, label: entry.label } } };
}

// ─── What the builder is told about a source ─────────────────────────────────

export type FieldType = "date" | "text" | "currency" | "number" | "days";

export type CatalogDimension = { key: string; label: string; type: FieldType; multi?: boolean; custom?: boolean };
export type CatalogMeasure = { key: string; label: string; type: FieldType; aggs: Aggregation[]; defaultAgg: Aggregation; average?: boolean; description?: string; custom?: boolean };

export type CatalogSource =
  | {
      key: string;
      label: string;
      group: SourceGroup;
      description: string;
      available: true;
      snapshot: boolean;
      exportPermission: ExportPermission;
      dateFields: { key: string; label: string }[];
      dimensions: CatalogDimension[];
      measures: CatalogMeasure[];
    }
  | { key: string; label: string; group: SourceGroup; description: string; available: false; lockedReason: string };

/** A source's fields as the builder lists them: dates, text, rupees, counts — and how each may be totalled. */
export function describeSource(open: OpenSource): Extract<CatalogSource, { available: true }> {
  const { entry, source } = open;
  return {
    key: entry.key,
    label: entry.label,
    group: entry.group,
    description: source.description,
    available: true,
    snapshot: !!entry.snapshot,
    exportPermission: entry.exportPermission,
    dateFields: entry.snapshot ? [] : source.dateFields.map((d) => ({ key: d.key, label: d.label })),
    dimensions: source.dimensions.map((d) => ({ key: d.key, label: d.label, type: "text" as const, ...(d.multi ? { multi: true } : {}), ...(d.custom ? { custom: true } : {}) })),
    measures: source.measures.map((m) => ({
      key: m.key,
      label: m.label,
      type: m.unit === "currency" ? ("currency" as const) : m.unit === "days" ? ("days" as const) : ("number" as const),
      aggs: aggregationsFor(m),
      defaultAgg: defaultAgg(m),
      ...(m.average ? { average: true } : {}),
      ...(m.description ? { description: m.description } : {}),
      ...(m.custom ? { custom: true } : {}),
    })),
  };
}

/** Every reporting source for this person: the open ones with their fields, the rest locked with the reason. */
export async function reportingCatalog(userId: string, moduleOn: ModuleOn): Promise<CatalogSource[]> {
  return Promise.all(
    ENTRIES.map(async (entry): Promise<CatalogSource> => {
      const found = await openSource(entry.key, userId, moduleOn);
      if (found.ok) return describeSource(found.open);
      return { key: entry.key, label: entry.label, group: entry.group, description: entry.base()?.description ?? "", available: false, lockedReason: entry.lockedReason };
    }),
  );
}

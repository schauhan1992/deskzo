import type { PermissionKey } from "@/lib/permissions";

/**
 * What can be taken out of the system, what can be put back in, and who may do either.
 *
 * ## Why direction is a property of the area
 *
 * Some things can be imported and some cannot, and the reason is not squeamishness. An order is the
 * output of a process — it was punched, approved, sourced, fulfilled, invoiced, paid — and each step
 * wrote ledger entries, stock movements and audit rows. Importing a spreadsheet of orders would
 * create the record without any of that, producing an order that exists but that the books have
 * never heard of. The same is true of renewals, which are orders, and payments, which are allocated
 * against them and posted to the ledger.
 *
 * So those three export only. Everything else in this list is a description of the world rather
 * than a record of something the system did, and a description can legitimately arrive from
 * outside.
 *
 * ## Why export is permissioned separately from viewing
 *
 * Export is the single most ordinary way data leaves a business, and it is the one action where
 * "can see it" and "may take it out of the building" genuinely differ. A salesperson can read their
 * own accounts all day; whether they may download them the week before they resign is a different
 * question with a different answer.
 *
 * Export never widens visibility: it returns the rows the person could already see, narrowed by the
 * account scoping in src/lib/authz/company-scope.ts. The permission decides whether they may take
 * those rows out, not which rows exist.
 */

export type PortableArea = {
  key: string;
  label: string;
  /** Plain description for the export screen. */
  description: string;
  exportPermission: PermissionKey;
  /** Null where importing is not possible — see the note above. */
  importPermission: PermissionKey | null;
  /** Why import is refused, shown in the UI so the absence is explained rather than puzzling. */
  importRefusedBecause?: string;
};

export const PORTABLE_AREAS: PortableArea[] = [
  {
    key: "companies",
    label: "Companies",
    description: "The sourcing pool — prospects, leads and won deals, with their locations and tags.",
    exportPermission: "data.exportCrm",
    importPermission: "data.importCrm",
  },
  {
    key: "customers",
    label: "Customers",
    description: "Companies that have bought something. Exporting one brings everything attached to it.",
    exportPermission: "data.exportCrm",
    importPermission: "data.importCrm",
  },
  {
    key: "contacts",
    label: "Contacts",
    description: "People at those companies, with their designations and verification state.",
    exportPermission: "data.exportCrm",
    importPermission: "data.importCrm",
  },
  {
    key: "vendors",
    label: "Vendors",
    description: "Suppliers, their onboarding status and payout details.",
    exportPermission: "data.exportCrm",
    importPermission: "data.importCrm",
  },
  {
    key: "resellers",
    label: "Resellers",
    description: "Reseller partners, their agreements, pricing and end customers.",
    exportPermission: "data.exportCrm",
    importPermission: "data.importCrm",
  },
  {
    key: "commission-parties",
    label: "Commission parties",
    description: "Referral agents and their payout accounts.",
    exportPermission: "data.exportCrm",
    importPermission: "data.importCrm",
  },
  {
    key: "workspace",
    label: "Workspace lists",
    description: "Saved calling and prospecting lists, with their filters and allocations.",
    exportPermission: "data.exportCrm",
    importPermission: "data.importCrm",
  },
  {
    key: "items",
    label: "Items & catalog",
    description: "Products, services and subscriptions, with brands and product families.",
    exportPermission: "data.exportCatalog",
    importPermission: "data.importCatalog",
  },
  {
    key: "suppression",
    label: "Suppression list",
    description: "Addresses and domains nobody may be marketed to, with the reason for each.",
    exportPermission: "data.exportCrm",
    // A suppression list is the one import where getting it wrong is a legal problem rather than a
    // data-quality one: a row that fails to import is somebody who starts receiving mail again.
    importPermission: "data.importCrm",
  },
  {
    key: "tickets",
    label: "Tickets",
    description: "Support tickets and their comment threads.",
    exportPermission: "data.exportCrm",
    importPermission: "data.importCrm",
  },
  {
    key: "visits",
    label: "Field visits",
    description: "Logged customer visits, with check-ins and write-ups.",
    exportPermission: "data.exportCrm",
    importPermission: "data.importCrm",
  },
  {
    key: "assets",
    label: "IT assets",
    description: "The managed estate — devices, warranty and AMC cover, custody and movements.",
    exportPermission: "data.exportCrm",
    importPermission: "data.importCrm",
  },
  {
    key: "expenses",
    label: "Expenses",
    description: "Submitted and reimbursed expense claims.",
    exportPermission: "data.exportFinance",
    importPermission: "data.importFinance",
  },
  {
    key: "statements",
    label: "Statements of account",
    description: "Per-customer statements: what was invoiced, received and remains outstanding.",
    exportPermission: "data.exportFinance",
    importPermission: null,
    importRefusedBecause:
      "A statement is derived from invoices and payments rather than stored, so there is nothing to import into — import those instead and the statement follows.",
  },
  {
    key: "ledger",
    label: "Ledger",
    description: "The chart of accounts and every journal entry.",
    exportPermission: "data.exportFinance",
    importPermission: "data.importFinance",
  },
  {
    key: "orders",
    label: "Orders",
    description: "Punched orders through approval, sourcing and fulfilment.",
    exportPermission: "data.exportFinance",
    importPermission: null,
    importRefusedBecause:
      "An order is the record of a process the system ran — approval, sourcing, fulfilment — and each step wrote ledger entries, stock movements and audit rows. An imported order would exist without any of that, and the books would never have heard of it.",
  },
  {
    key: "renewals",
    label: "Renewals",
    description: "Subscriptions coming up for renewal, with seats added mid-term.",
    exportPermission: "data.exportFinance",
    importPermission: null,
    importRefusedBecause:
      "A renewal is an order, and carries the same history. Import the subscription as an order through the normal flow instead.",
  },
  {
    key: "payments",
    label: "Payments",
    description: "Money received, and how it was allocated across orders.",
    exportPermission: "data.exportFinance",
    importPermission: null,
    importRefusedBecause:
      "A payment is allocated against orders and posted to the ledger. Importing one would create a receipt the accounts do not balance against.",
  },
  {
    key: "people",
    label: "People",
    description: "Employee records, attendance, leave and documents. Salary is excluded unless separately granted.",
    exportPermission: "data.exportPeople",
    importPermission: "data.importPeople",
  },
  {
    key: "hiring",
    label: "Hiring",
    description: "Candidates and their progress through the pipeline.",
    exportPermission: "data.exportPeople",
    importPermission: "data.importPeople",
  },
  {
    key: "users",
    label: "Users",
    description: "Accounts, roles, departments and reporting lines. Never includes passwords or two-factor secrets.",
    exportPermission: "data.exportUsers",
    importPermission: "data.importUsers",
  },
];

const BY_KEY = new Map(PORTABLE_AREAS.map((a) => [a.key, a]));

export function getArea(key: string): PortableArea | undefined {
  return BY_KEY.get(key);
}

export const AREA_KEYS = PORTABLE_AREAS.map((a) => a.key);

/** Areas that can be imported, for the import screen's list. */
export const IMPORTABLE_AREAS = PORTABLE_AREAS.filter((a) => a.importPermission !== null);

/** Every distinct permission the two screens reference, for the check script. */
export const AREA_PERMISSIONS: PermissionKey[] = Array.from(
  new Set(
    PORTABLE_AREAS.flatMap((a) => [a.exportPermission, ...(a.importPermission ? [a.importPermission] : [])]),
  ),
);

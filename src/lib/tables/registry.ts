import type { TradeDocumentType } from "@prisma/client";

/**
 * Which columns each records table has, and which of them somebody may turn off.
 *
 * One registry rather than a list inside each component, for the same reason the permission and
 * dashboard-widget registries exist: the column picker, the stored preference and the table itself
 * must agree, and three places that each know the answer separately is three places that drift.
 *
 * ## The invariant that matters
 *
 * A table's header and its body must hide the *same* columns. Hide a `<th>` and forget its `<td>`
 * and every row below shifts one cell left — silently, with no error, and looking exactly like a
 * data bug rather than a rendering one. `npm run check:tables` asserts that the set of column keys
 * guarded in the header equals the set guarded in the body, for every registered table. That check
 * is the reason this is safe to roll out across twenty screens.
 *
 * ## What `required` means
 *
 * A column nobody may hide. Reserve it for the one that identifies the row — an order without its
 * order number is a list of anonymous rows — and for the actions cell, which is the way out of any
 * mess the rest of the choices create. Everything else should be hideable; people's screens and
 * jobs differ more than we can predict.
 */

export type ColumnDefinition = {
  key: string;
  label: string;
  /** Shown to somebody who has never customised this table. */
  default: boolean;
  /** Cannot be switched off. Keep this list short. */
  required?: boolean;
  /** Why it exists, for the picker's tooltip. Worth writing where the label is terse. */
  hint?: string;
};

export type TableDefinition = {
  key: string;
  /** Shown as the picker's heading. */
  label: string;
  columns: ColumnDefinition[];
};

export const TABLE_REGISTRY: TableDefinition[] = [
  {
    key: "orders",
    label: "Orders",
    columns: [
      { key: "order", label: "Order", default: true, required: true, hint: "The order number. Without it a row cannot be identified or linked to." },
      { key: "status", label: "Status", default: true },
      { key: "type", label: "Type", default: true, hint: "New business, renewal, or an addition to an existing subscription." },
      { key: "customer", label: "Customer", default: true },
      { key: "product", label: "Product", default: true },
      { key: "qty", label: "Qty", default: true },
      { key: "total", label: "Total", default: true, hint: "Inclusive of GST." },
      { key: "vendor", label: "Vendor", default: true },
      { key: "addedBy", label: "Added by", default: true },
      { key: "actions", label: "Actions", default: true, required: true, hint: "Row actions, including the fulfilment notice." },
    ],
  },
  {
    key: "companies",
    label: "Companies",
    columns: [
      { key: "select", label: "Selection", default: true, required: true, hint: "The tick box for bulk actions." },
      { key: "id", label: "ID", default: true, hint: "The short reference — COM-000123. Shared across customers, vendors and commission parties, so two of them can never carry the same number." },
      { key: "company", label: "Company", default: true, required: true },
      { key: "status", label: "Stage", default: true, hint: "Where this company sits in the pipeline." },
      { key: "relationship", label: "Relationship", default: true },
      { key: "source", label: "Source", default: true },
      { key: "contacts", label: "Contacts", default: true },
      { key: "leads", label: "Leads", default: true },
      { key: "assigned", label: "Assigned to", default: true },
      { key: "portal", label: "Portal", default: false, hint: "Off by default here — most of this list has never bought anything, so the answer is 'off' for nearly every row." },
      { key: "addedBy", label: "Added by", default: false, hint: "Off by default — useful for data-quality work, noise the rest of the time." },
      { key: "addedOn", label: "Added on", default: true },
    ],
  },
  {
    key: "customers",
    label: "Customers",
    columns: [
      { key: "select", label: "Selection", default: true, required: true, hint: "The tick box for bulk actions." },
      { key: "id", label: "ID", default: true, hint: "The short reference — COM-000123. Shared across customers, vendors and commission parties, so two of them can never carry the same number." },
      { key: "company", label: "Company", default: true, required: true },
      { key: "status", label: "Orders", default: true, hint: "How many orders are on file for this customer." },
      { key: "relationship", label: "Relationship", default: true },
      { key: "source", label: "Source", default: true },
      { key: "contacts", label: "Contacts", default: true },
      { key: "assigned", label: "Assigned to", default: true },
      { key: "portal", label: "Portal", default: true, hint: "Whether this customer can sign in to their own portal, and whether anybody has actually been sent a link." },
      { key: "addedBy", label: "Added by", default: false, hint: "Off by default — useful for data-quality work, noise the rest of the time." },
      { key: "addedOn", label: "Added on", default: true },
    ],
  },
  {
    key: "vendors",
    label: "Vendors",
    columns: [
      { key: "select", label: "Selection", default: true, required: true, hint: "The tick box for bulk actions." },
      { key: "id", label: "ID", default: true, hint: "The short reference — COM-000123. Shared across customers, vendors and commission parties, so two of them can never carry the same number." },
      { key: "company", label: "Company", default: true, required: true },
      { key: "status", label: "Onboarding status", default: true, hint: "How far through onboarding this vendor is." },
      { key: "relationship", label: "Relationship", default: true },
      { key: "source", label: "Source", default: true },
      { key: "contacts", label: "Contacts", default: true },
      { key: "assigned", label: "Assigned to", default: true },
      { key: "addedBy", label: "Added by", default: false, hint: "Off by default — useful for data-quality work, noise the rest of the time." },
      { key: "addedOn", label: "Added on", default: true },
    ],
  },
  {
    key: "commission-parties",
    label: "Commission parties",
    columns: [
      { key: "select", label: "Selection", default: true, required: true, hint: "The tick box for bulk actions." },
      { key: "id", label: "ID", default: true, hint: "The short reference — COM-000123. Shared across customers, vendors and commission parties, so two of them can never carry the same number." },
      { key: "company", label: "Company", default: true, required: true },
      { key: "status", label: "Onboarding status", default: true, hint: "How far through onboarding this party is." },
      { key: "relationship", label: "Relationship", default: true },
      { key: "source", label: "Source", default: true },
      { key: "contacts", label: "Contacts", default: true },
      { key: "assigned", label: "Assigned to", default: true },
      { key: "addedBy", label: "Added by", default: false, hint: "Off by default — useful for data-quality work, noise the rest of the time." },
      { key: "addedOn", label: "Added on", default: true },
    ],
  },
  {
    key: "leads",
    label: "Leads",
    columns: [
      { key: "select", label: "Selection", default: true, required: true, hint: "The tick box for bulk actions." },
      { key: "id", label: "ID", default: true, hint: "The short reference — LEAD-000123." },
      { key: "title", label: "Title", default: true, required: true },
      { key: "company", label: "Company", default: true },
      { key: "status", label: "Status", default: true },
      { key: "score", label: "Score", default: true, hint: "Out of 100 — hot, warm or cold. Open a lead to see what it is made of." },
      { key: "source", label: "Source", default: true, hint: "Where the enquiry came from — website, referral, a call…" },
      { key: "owner", label: "Owner", default: true },
      { key: "value", label: "Value", default: true, hint: "The estimated value of the deal." },
      { key: "expectedClose", label: "Expected close", default: true },
      { key: "updated", label: "Updated", default: true },
    ],
  },
  {
    key: "renewals",
    label: "Renewals",
    columns: [
      { key: "select", label: "Selection", default: true, required: true, hint: "The tick box for bulk actions." },
      { key: "orderId", label: "Order ID", default: true, required: true },
      { key: "company", label: "Company", default: true },
      { key: "subscription", label: "Subscription", default: true },
      { key: "qty", label: "Qty", default: true, hint: "Includes seats added mid-term, noted separately where there are any." },
      { key: "po", label: "PO / Invoice #", default: true },
      { key: "startDate", label: "Start date", default: false, hint: "Off by default — the expiry is what this list is about." },
      { key: "expiryDate", label: "Expiry date", default: true },
      { key: "accountManager", label: "Account manager", default: true },
      { key: "status", label: "Status", default: true, hint: "How long is left — a clock, not progress." },
      {
        key: "stage",
        label: "Stage",
        default: true,
        hint: "How far the renewal has got. Worked out from what's happened — a call logged, a proposal raised, the order punched — and pinnable by hand for Negotiating, On hold and Lost, which nothing can infer.",
      },
      { key: "actions", label: "Actions", default: true, required: true, hint: "Call, send a reminder, draft a proposal, or punch the renewal." },
    ],
  },

  /**
   * The seven document lists.
   *
   * One entry per type rather than a single shared one, because two of the columns are not the
   * same question on every screen. `einvoice` exists only on the two types the IRP takes, so a
   * shared entry would offer five screens a toggle for a column that is never drawn — and would
   * make `cols.count` disagree with the cells, which is the one thing the empty row's colSpan
   * cannot survive. And the last column is the salesperson on a sales document and whoever raised
   * it on a purchase one; a single picker label cannot say both.
   *
   * Written out rather than generated in a loop: `tradeDocumentTypeValues` deliberately omits
   * DELIVERY_CHALLAN, and using the Prisma enum as a value here would pull it into the client
   * bundle through the picker. The four near-identical company entries above set the precedent.
   */
  {
    key: "documents:PROPOSAL",
    label: "Proposals",
    columns: [
      { key: "select", label: "Selection", default: true, required: true, hint: "The tick box for bulk actions." },
      { key: "date", label: "Date", default: true, hint: "The issue date." },
      {
        key: "number",
        label: "Number",
        default: true,
        required: true,
        hint: "The document number. Without it a row cannot be identified or opened.",
      },
      { key: "reference", label: "Reference #", default: true, hint: "Their PO or quote reference, where one was given." },
      { key: "party", label: "Party", default: true },
      { key: "branch", label: "Branch", default: false, hint: "Which branch raised it — on a purchase, which one bought. Offered only when there is more than one." },
      {
        key: "status",
        label: "Status",
        default: true,
        hint: "Carries the sign-off badge too, on a type that needs approving.",
      },
      {
        key: "origin",
        label: "Source",
        default: true,
        hint: "Which part of the app raised it — typed in by hand, converted from another document, or produced by the add-on calculator or the renewals list.",
      },
      { key: "amount", label: "Amount", default: true, hint: "Inclusive of GST, in the document's own currency." },
      { key: "owner", label: "Salesperson", default: true, hint: "Whose name is on the document." },
    ],
  },
  {
    key: "documents:PROFORMA",
    label: "Proforma invoices",
    columns: [
      { key: "select", label: "Selection", default: true, required: true, hint: "The tick box for bulk actions." },
      { key: "date", label: "Date", default: true, hint: "The issue date." },
      {
        key: "number",
        label: "Number",
        default: true,
        required: true,
        hint: "The document number. Without it a row cannot be identified or opened.",
      },
      { key: "reference", label: "Reference #", default: true, hint: "Their PO or quote reference, where one was given." },
      { key: "party", label: "Party", default: true },
      { key: "branch", label: "Branch", default: false, hint: "Which branch raised it — on a purchase, which one bought. Offered only when there is more than one." },
      {
        key: "status",
        label: "Status",
        default: true,
        hint: "Carries the sign-off badge too, on a type that needs approving.",
      },
      {
        key: "origin",
        label: "Source",
        default: true,
        hint: "Which part of the app raised it — typed in by hand, converted from another document, or produced by the add-on calculator or the renewals list.",
      },
      { key: "amount", label: "Amount", default: true, hint: "Inclusive of GST, in the document's own currency." },
      { key: "owner", label: "Salesperson", default: true, hint: "Whose name is on the document." },
    ],
  },
  {
    key: "documents:INVOICE",
    label: "Tax invoices",
    columns: [
      { key: "select", label: "Selection", default: true, required: true, hint: "The tick box for bulk actions." },
      { key: "date", label: "Date", default: true, hint: "The issue date." },
      {
        key: "number",
        label: "Number",
        default: true,
        required: true,
        hint: "The document number. Without it a row cannot be identified or opened.",
      },
      { key: "reference", label: "Reference #", default: true, hint: "Their PO or quote reference, where one was given." },
      { key: "party", label: "Party", default: true },
      { key: "branch", label: "Branch", default: false, hint: "Which branch raised it — on a purchase, which one bought. Offered only when there is more than one." },
      {
        key: "status",
        label: "Status",
        default: true,
        hint: "Carries the sign-off badge too, on a type that needs approving.",
      },
      {
        key: "origin",
        label: "Source",
        default: true,
        hint: "Which part of the app raised it — typed in by hand, converted from another document, or produced by the add-on calculator or the renewals list.",
      },
      { key: "amount", label: "Amount", default: true, hint: "Inclusive of GST, in the document's own currency." },
      {
        key: "einvoice",
        label: "e-Invoice",
        default: true,
        hint: "IRN state. Only the two types the IRP takes declare this column at all.",
      },
      { key: "owner", label: "Salesperson", default: true, hint: "Whose name is on the document." },
    ],
  },
  {
    key: "documents:CREDIT_NOTE",
    label: "Credit notes",
    columns: [
      { key: "select", label: "Selection", default: true, required: true, hint: "The tick box for bulk actions." },
      { key: "date", label: "Date", default: true, hint: "The issue date." },
      {
        key: "number",
        label: "Number",
        default: true,
        required: true,
        hint: "The document number. Without it a row cannot be identified or opened.",
      },
      { key: "reference", label: "Reference #", default: true, hint: "Their PO or quote reference, where one was given." },
      { key: "party", label: "Party", default: true },
      { key: "branch", label: "Branch", default: false, hint: "Which branch raised it — on a purchase, which one bought. Offered only when there is more than one." },
      {
        key: "status",
        label: "Status",
        default: true,
        hint: "Carries the sign-off badge too, on a type that needs approving.",
      },
      {
        key: "origin",
        label: "Source",
        default: true,
        hint: "Which part of the app raised it — typed in by hand, converted from another document, or produced by the add-on calculator or the renewals list.",
      },
      { key: "amount", label: "Amount", default: true, hint: "Inclusive of GST, in the document's own currency." },
      {
        key: "einvoice",
        label: "e-Invoice",
        default: true,
        hint: "IRN state. Only the two types the IRP takes declare this column at all.",
      },
      { key: "owner", label: "Salesperson", default: true, hint: "Whose name is on the document." },
    ],
  },
  {
    key: "documents:PURCHASE_ORDER",
    label: "Purchase orders",
    columns: [
      { key: "select", label: "Selection", default: true, required: true, hint: "The tick box for bulk actions." },
      { key: "date", label: "Date", default: true, hint: "The issue date." },
      {
        key: "number",
        label: "Number",
        default: true,
        required: true,
        hint: "The document number. Without it a row cannot be identified or opened.",
      },
      { key: "reference", label: "Reference #", default: true, hint: "Their PO or quote reference, where one was given." },
      { key: "party", label: "Party", default: true },
      { key: "branch", label: "Branch", default: false, hint: "Which branch raised it — on a purchase, which one bought. Offered only when there is more than one." },
      {
        key: "status",
        label: "Status",
        default: true,
        hint: "Carries the sign-off badge too, on a type that needs approving.",
      },
      {
        key: "origin",
        label: "Source",
        default: true,
        hint: "Which part of the app raised it — typed in by hand, converted from another document, or produced by the add-on calculator or the renewals list.",
      },
      { key: "amount", label: "Amount", default: true, hint: "Inclusive of GST, in the document's own currency." },
      { key: "owner", label: "Raised by", default: true, hint: "Who raised it." },
    ],
  },
  {
    key: "documents:BILL",
    label: "Vendor bills",
    columns: [
      { key: "select", label: "Selection", default: true, required: true, hint: "The tick box for bulk actions." },
      { key: "date", label: "Date", default: true, hint: "The issue date." },
      {
        key: "number",
        label: "Number",
        default: true,
        required: true,
        hint: "The document number. Without it a row cannot be identified or opened.",
      },
      { key: "reference", label: "Reference #", default: true, hint: "Their PO or quote reference, where one was given." },
      { key: "party", label: "Party", default: true },
      { key: "branch", label: "Branch", default: false, hint: "Which branch raised it — on a purchase, which one bought. Offered only when there is more than one." },
      {
        key: "status",
        label: "Status",
        default: true,
        hint: "Carries the sign-off badge too, on a type that needs approving.",
      },
      {
        key: "origin",
        label: "Source",
        default: true,
        hint: "Which part of the app raised it — typed in by hand, converted from another document, or produced by the add-on calculator or the renewals list.",
      },
      { key: "amount", label: "Amount", default: true, hint: "Inclusive of GST, in the document's own currency." },
      { key: "owner", label: "Raised by", default: true, hint: "Who raised it." },
    ],
  },
  {
    key: "documents:DELIVERY_CHALLAN",
    label: "Delivery challans",
    columns: [
      { key: "select", label: "Selection", default: true, required: true, hint: "The tick box for bulk actions." },
      { key: "date", label: "Date", default: true, hint: "The issue date." },
      {
        key: "number",
        label: "Number",
        default: true,
        required: true,
        hint: "The document number. Without it a row cannot be identified or opened.",
      },
      { key: "reference", label: "Reference #", default: true, hint: "Their PO or quote reference, where one was given." },
      { key: "party", label: "Party", default: true },
      { key: "branch", label: "Branch", default: false, hint: "Which branch raised it — on a purchase, which one bought. Offered only when there is more than one." },
      {
        key: "status",
        label: "Status",
        default: true,
        hint: "Carries the sign-off badge too, on a type that needs approving.",
      },
      {
        key: "origin",
        label: "Source",
        default: true,
        hint: "Which part of the app raised it — typed in by hand, converted from another document, or produced by the add-on calculator or the renewals list.",
      },
      { key: "amount", label: "Amount", default: true, hint: "Inclusive of GST, in the document's own currency." },
      { key: "owner", label: "Salesperson", default: true, hint: "Whose name is on the document." },
    ],
  },
];

const BY_KEY = new Map(TABLE_REGISTRY.map((t) => [t.key, t]));

export function getTableDefinition(key: string): TableDefinition | undefined {
  return BY_KEY.get(key);
}

export const TABLE_KEYS = TABLE_REGISTRY.map((t) => t.key);

/**
 * The table key for one document list.
 *
 * Keyed on the Prisma enum value rather than the URL, so renaming a screen or moving its route
 * cannot strand everybody's stored column preference.
 */
export function documentTableKey(docType: TradeDocumentType) {
  return `documents:${docType}`;
}

/** The columns somebody sees, given what they have stored. Registry order, always. */
export function resolveColumns(tableKey: string, stored: string[] | null): string[] {
  const def = BY_KEY.get(tableKey);
  if (!def) return [];

  // Never customised: the defaults. Distinct from "customised to nothing", which is a real choice
  // and must survive — hence null rather than an empty array meaning "untouched".
  if (stored === null) return def.columns.filter((c) => c.default).map((c) => c.key);

  const chosen = new Set(stored);
  return def.columns
    // A required column is always present regardless of what is stored, so a preference saved
    // before a column became required cannot strand somebody with an unusable table.
    .filter((c) => c.required || chosen.has(c.key))
    .map((c) => c.key);
}

/** What gets stored when somebody picks. Required columns are implied, so they are not written. */
export function normaliseSelection(tableKey: string, selected: string[]): string[] {
  const def = BY_KEY.get(tableKey);
  if (!def) return [];
  const chosen = new Set(selected);
  return def.columns.filter((c) => !c.required && chosen.has(c.key)).map((c) => c.key);
}

/** Whether a stored preference still matches the defaults — drives the "Reset" affordance. */
export function isDefaultSelection(tableKey: string, stored: string[] | null): boolean {
  if (stored === null) return true;
  const def = BY_KEY.get(tableKey);
  if (!def) return true;
  const a = resolveColumns(tableKey, stored).join(",");
  const b = resolveColumns(tableKey, null).join(",");
  return a === b;
}

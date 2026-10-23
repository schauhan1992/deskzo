import type { TradeDocumentType, TradeDirection, TradeDocumentStatus, DocumentOrigin } from "@prisma/client";

export const tradeDocumentTypeValues = [
  "PROPOSAL",
  "PROFORMA",
  "INVOICE",
  "CREDIT_NOTE",
  "DEBIT_NOTE",
  "PURCHASE_ORDER",
  "BILL",
  // DELIVERY_CHALLAN is deliberately absent: it is raised from a consignment, which already knows
  // what is moving and where to, rather than typed from a blank form.
] as const;

export const tradeDocumentLabels: Record<TradeDocumentType, string> = {
  PROPOSAL: "Proposal",
  PROFORMA: "Proforma invoice",
  INVOICE: "Tax invoice",
  CREDIT_NOTE: "Credit note",
  DEBIT_NOTE: "Debit note",
  PURCHASE_ORDER: "Purchase order",
  BILL: "Vendor bill",
  DELIVERY_CHALLAN: "Delivery challan",
};

/** Prefixes appear in the document number, so they're short and unambiguous on a printed page. */
export const documentPrefixes: Record<TradeDocumentType, string> = {
  PROPOSAL: "QT",
  PROFORMA: "PI",
  INVOICE: "INV",
  CREDIT_NOTE: "CN",
  DEBIT_NOTE: "DN",
  PURCHASE_ORDER: "PO",
  BILL: "BILL",
  DELIVERY_CHALLAN: "DC",
};

export const documentDirection: Record<TradeDocumentType, TradeDirection> = {
  PROPOSAL: "SALES",
  PROFORMA: "SALES",
  INVOICE: "SALES",
  CREDIT_NOTE: "SALES",
  DEBIT_NOTE: "SALES",
  PURCHASE_ORDER: "PURCHASE",
  BILL: "PURCHASE",
  DELIVERY_CHALLAN: "SALES",
};

/** Only a tax invoice, a credit note and a debit note are reported to the IRP — quotes and proformas never are. */
export function isEInvoiceEligible(docType: TradeDocumentType) {
  return docType === "INVOICE" || docType === "CREDIT_NOTE" || docType === "DEBIT_NOTE";
}

/**
 * What a customer owes on (owner, 23 Oct 2026): a tax invoice, and a debit note that adds to one. Each is
 * settled by payments and credit notes, aged, chased and posted to receivables alike — anything that asks
 * "what's open against this customer" asks for both.
 */
export const RECEIVABLE_TYPES = ["INVOICE", "DEBIT_NOTE"] as const satisfies readonly TradeDocumentType[];

/** Every document type — typed, so a new one can't be left off. */
const EVERY_TYPE: Record<TradeDocumentType, true> = {
  PROPOSAL: true,
  PROFORMA: true,
  INVOICE: true,
  CREDIT_NOTE: true,
  DEBIT_NOTE: true,
  PURCHASE_ORDER: true,
  BILL: true,
  DELIVERY_CHALLAN: true,
};
const ALL_TYPES = Object.keys(EVERY_TYPE) as TradeDocumentType[];
/** Types newer than some workspaces' databases: named to a database only once its migration has run. */
const NEWER_TYPES: readonly TradeDocumentType[] = ["DEBIT_NOTE"];

/**
 * A where on `docType` for just these types, safe on a database not migrated yet (Coolify migrates after the
 * deploy): a list holding a type the database may not have yet is written as "none of the others", so that
 * type is never named to it — where it doesn't exist, there are simply none of it.
 */
export function docTypeIn(types: readonly TradeDocumentType[]): { in: TradeDocumentType[] } | { notIn: TradeDocumentType[] } {
  return types.some((t) => NEWER_TYPES.includes(t)) ? { notIn: ALL_TYPES.filter((t) => !types.includes(t)) } : { in: [...types] };
}

/** `docType` for what's owed — invoices and debit notes — safe before the debit note's migration. */
export const RECEIVABLE_DOC_TYPE = docTypeIn(RECEIVABLE_TYPES);

export function isReceivable(docType: TradeDocumentType): docType is (typeof RECEIVABLE_TYPES)[number] {
  return docType === "INVOICE" || docType === "DEBIT_NOTE";
}

/** Documents raised against an issued invoice, which they correct: down (a credit note) or up (a debit note). */
export function isNoteAgainstInvoice(docType: TradeDocumentType): boolean {
  return docType === "CREDIT_NOTE" || docType === "DEBIT_NOTE";
}

/** What a document of this type can become next, driving the "Convert to…" actions. */
export const conversionTargets: Partial<Record<TradeDocumentType, TradeDocumentType[]>> = {
  PROPOSAL: ["PROFORMA", "INVOICE"],
  PROFORMA: ["INVOICE"],
  INVOICE: ["CREDIT_NOTE", "DEBIT_NOTE"],
  PURCHASE_ORDER: ["BILL"],
};

export const tradeDocumentStatusLabels: Record<TradeDocumentStatus, string> = {
  DRAFT: "Draft",
  ISSUED: "Issued",
  ACCEPTED: "Accepted",
  REJECTED: "Rejected",
  PARTIALLY_PAID: "Partially paid",
  PAID: "Paid",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
};

/**
 * Where a document came from, in words — see `TradeDocument.origin`.
 *
 * "Manual" is deliberately not the label for a null. A row with no origin is one written by a path
 * that never said, and reading that as "somebody typed it" would be a guess presented as a fact;
 * every document that existed before the column was added was placed by the migration, so a blank
 * one means something newer is not declaring itself.
 */
export const documentOriginLabels: Record<DocumentOrigin, string> = {
  MANUAL: "Entered by hand",
  CONVERSION: "Converted",
  ADDON_CALCULATOR: "Add-on calculator",
  RENEWAL: "Renewals list",
  CONSIGNMENT: "Consignment",
  RECURRING_BILLING: "Recurring billing",
  IMPORTED: "Brought from the old system",
};

/** Muted throughout: provenance is context, not status, and should not compete with the status badge. */
export const documentOriginTone: Record<DocumentOrigin, "default" | "blue"> = {
  MANUAL: "default",
  CONVERSION: "blue",
  ADDON_CALCULATOR: "blue",
  RENEWAL: "blue",
  CONSIGNMENT: "default",
  RECURRING_BILLING: "blue",
  IMPORTED: "default",
};

export const statusTone: Record<TradeDocumentStatus, "default" | "green" | "blue" | "red" | "amber" | "brand"> = {
  DRAFT: "default",
  ISSUED: "blue",
  ACCEPTED: "green",
  REJECTED: "red",
  PARTIALLY_PAID: "amber",
  PAID: "green",
  CANCELLED: "default",
  EXPIRED: "red",
};

/**
 * A document is only editable while it's a draft. Once issued its number is committed to a GST
 * series and, for an invoice, possibly reported to the portal — corrections happen through a credit
 * note, not by rewriting history.
 */
export function isEditable(status: TradeDocumentStatus) {
  return status === "DRAFT";
}

/** List route per document type — the nav reads naturally while every detail page is shared. */
export const documentListPath: Record<TradeDocumentType, string> = {
  PROPOSAL: "/sales/proposals",
  PROFORMA: "/sales/proformas",
  INVOICE: "/sales/invoices",
  CREDIT_NOTE: "/sales/credit-notes",
  DEBIT_NOTE: "/sales/debit-notes",
  PURCHASE_ORDER: "/purchase/orders",
  BILL: "/purchase/bills",
  DELIVERY_CHALLAN: "/sales/challans",
};

export const documentTypeByListPath = Object.fromEntries(
  Object.entries(documentListPath).map(([type, path]) => [path, type as TradeDocumentType]),
) as Record<string, TradeDocumentType>;

export function documentPath(id: string) {
  return `/documents/${id}`;
}

/** Statuses a user can set by hand — the rest are reached by issuing, converting or recording payment. */
export const manualStatuses: Record<TradeDocumentType, TradeDocumentStatus[]> = {
  PROPOSAL: ["ACCEPTED", "REJECTED", "EXPIRED", "CANCELLED"],
  PROFORMA: ["CANCELLED"],
  INVOICE: ["CANCELLED"],
  CREDIT_NOTE: ["CANCELLED"],
  DEBIT_NOTE: ["CANCELLED"],
  PURCHASE_ORDER: ["ACCEPTED", "CANCELLED"],
  BILL: ["PAID", "CANCELLED"],
  DELIVERY_CHALLAN: ["CANCELLED"],
};

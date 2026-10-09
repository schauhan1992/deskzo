import type { TradeDocumentType, TradeDirection, TradeDocumentStatus, DocumentOrigin } from "@prisma/client";

export const tradeDocumentTypeValues = [
  "PROPOSAL",
  "PROFORMA",
  "INVOICE",
  "CREDIT_NOTE",
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
  PURCHASE_ORDER: "PO",
  BILL: "BILL",
  DELIVERY_CHALLAN: "DC",
};

export const documentDirection: Record<TradeDocumentType, TradeDirection> = {
  PROPOSAL: "SALES",
  PROFORMA: "SALES",
  INVOICE: "SALES",
  CREDIT_NOTE: "SALES",
  PURCHASE_ORDER: "PURCHASE",
  BILL: "PURCHASE",
  DELIVERY_CHALLAN: "SALES",
};

/** Only a tax invoice and a credit note are reported to the IRP — quotes and proformas never are. */
export function isEInvoiceEligible(docType: TradeDocumentType) {
  return docType === "INVOICE" || docType === "CREDIT_NOTE";
}

/** What a document of this type can become next, driving the "Convert to…" actions. */
export const conversionTargets: Partial<Record<TradeDocumentType, TradeDocumentType[]>> = {
  PROPOSAL: ["PROFORMA", "INVOICE"],
  PROFORMA: ["INVOICE"],
  INVOICE: ["CREDIT_NOTE"],
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
};

/** Muted throughout: provenance is context, not status, and should not compete with the status badge. */
export const documentOriginTone: Record<DocumentOrigin, "default" | "blue"> = {
  MANUAL: "default",
  CONVERSION: "blue",
  ADDON_CALCULATOR: "blue",
  RENEWAL: "blue",
  CONSIGNMENT: "default",
  RECURRING_BILLING: "blue",
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
  PURCHASE_ORDER: ["ACCEPTED", "CANCELLED"],
  BILL: ["PAID", "CANCELLED"],
  DELIVERY_CHALLAN: ["CANCELLED"],
};

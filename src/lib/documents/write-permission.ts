import type { TradeDocumentType } from "@prisma/client";
import type { PermissionKey } from "@/lib/permissions";

/**
 * Which permission writing a document of this type asks for (owner, 15 Oct 2026).
 *
 * A purchase order is purchase's: raising, editing, issuing, deleting and cancelling one all ask
 * "Raise purchase orders". Every other document — quotes, proformas, invoices, credit notes, and the
 * vendor's bill, which posts to the books — asks the sales-document pair as before: "Raise and issue"
 * to write, "Delete or cancel" to undo. One place, so the actions and the buttons that lead to them
 * can't disagree. Dependency-free, for server pages and actions alike.
 */
export function documentWriteKey(docType: TradeDocumentType, kind: "issue" | "void"): PermissionKey {
  if (docType === "PURCHASE_ORDER") return "purchase.raiseOrders";
  return kind === "issue" ? "documents.issue" : "documents.void";
}

/** The refusal for somebody without it, in words. */
export function documentWriteRefusal(docType: TradeDocumentType, kind: "issue" | "void"): string {
  if (docType === "PURCHASE_ORDER") return "You don't have permission to raise purchase orders.";
  return kind === "issue" ? "You don't have permission to raise or issue sales documents." : "You don't have permission to delete or cancel a document.";
}

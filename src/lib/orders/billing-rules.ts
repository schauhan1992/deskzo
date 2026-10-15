/**
 * Whether an order has been invoiced — its quantity against the quantity on the tax invoices that
 * bill it (`TradeDocumentLine.companyProductId`). Plain, so the order page, the orders list, the
 * invoice form and `check:order-billing` share one answer.
 *
 * - An order is billed by tax invoices that are issued and still standing: a draft hasn't billed
 *   anything yet, and a cancelled invoice has billed nothing.
 * - Credit notes are shown beside it but don't reduce what was invoiced: a credit note for a price
 *   correction carries a quantity too, and counting it back would reopen an order nobody needs to
 *   bill again.
 * - An order billed in instalments (recurring billing) is billed by its schedule, many invoices for
 *   the same quantity — it is never "to invoice", and billing it again is the point.
 */

export type OrderBillingStatus = "NOT_INVOICED" | "PART_INVOICED" | "INVOICED" | "INSTALMENTS";

/** The documents that billed (or are drafting to bill) an order, as the order shows them. */
export type BilledDocument = {
  documentId: string;
  docNumber: string;
  docType: "INVOICE" | "CREDIT_NOTE";
  status: string;
  quantity: number;
  /** The line on the document — what "link an existing invoice" sets, and unlinking clears. */
  lineId: string;
};

export type OrderBilling = {
  orderId: string;
  ordered: number;
  invoiced: number;
  /** Still to bill — never below nothing. */
  remaining: number;
  status: OrderBillingStatus;
  invoices: BilledDocument[];
  drafts: BilledDocument[];
  creditNotes: BilledDocument[];
};

/** The tax invoice statuses that have billed something. */
export const BILLED_STATUSES = ["ISSUED", "ACCEPTED", "PARTIALLY_PAID", "PAID"] as const;

/** The order statuses that are sold — approved onwards — and so can wait to be invoiced. */
export const INVOICEABLE_ORDER_STATUSES = ["APPROVED", "PROCESSING", "FULFILLED"] as const;

export function billingStatusOf(ordered: number, invoiced: number, instalments: boolean): OrderBillingStatus {
  if (instalments) return "INSTALMENTS";
  if (invoiced <= 0) return "NOT_INVOICED";
  if (invoiced < ordered) return "PART_INVOICED";
  return "INVOICED";
}

export const billingStatusLabels: Record<OrderBillingStatus, string> = {
  NOT_INVOICED: "Not invoiced",
  PART_INVOICED: "Part invoiced",
  INVOICED: "Invoiced",
  INSTALMENTS: "Billed in instalments",
};

export const billingStatusTones: Record<OrderBillingStatus, "default" | "green" | "blue" | "red" | "amber"> = {
  NOT_INVOICED: "amber",
  PART_INVOICED: "blue",
  INVOICED: "green",
  INSTALMENTS: "default",
};

/** Quantities as people write them: whole where they are whole. */
export function quantityLabel(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * What an invoice line billing this order would do, for the warning on the invoice form: nothing to
 * say, bill it a second time, or bill more than is left. Instalment orders are billed again by
 * design, so they never warn.
 */
export function overBillingWarning(
  billing: Pick<OrderBilling, "status" | "ordered" | "invoiced" | "remaining"> & { invoices: { docNumber: string }[]; drafts?: { docNumber: string }[] },
  quantity: number,
): string | null {
  if (billing.status === "INSTALMENTS" || !(quantity > 0)) return null;
  const numbers = billing.invoices.map((i) => i.docNumber).join(", ");
  if (billing.status === "INVOICED") return `Already invoiced in full (${numbers}) — this would bill it a second time.`;
  if (quantity > billing.remaining) {
    return `Only ${quantityLabel(billing.remaining)} of ${quantityLabel(billing.ordered)} is left to bill${numbers ? ` (${numbers} billed the rest)` : ""} — this line bills ${quantityLabel(quantity)}.`;
  }
  const drafts = (billing.drafts ?? []).map((d) => d.docNumber);
  if (drafts.length > 0) return `It's already on draft invoice ${drafts.join(", ")} — this would be a second invoice for it.`;
  return null;
}

/** Orders that go on one invoice share a customer and a site — the address and the place of supply. */
export function invoiceTogetherRefusal(orders: { companyId: string; locationId: string }[]): string | null {
  if (orders.length === 0) return "Pick at least one order.";
  if (new Set(orders.map((o) => o.companyId)).size > 1) return "These orders are for different customers — each needs its own invoice.";
  if (new Set(orders.map((o) => o.locationId)).size > 1) {
    return "These orders are for different sites of the customer, with their own address and place of supply — invoice them separately.";
  }
  return null;
}

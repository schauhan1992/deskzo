export const gstTreatmentValues = [
  "REGISTERED_REGULAR",
  "REGISTERED_COMPOSITION",
  "UNREGISTERED",
  "CONSUMER",
  "OVERSEAS",
  "SEZ",
  "DEEMED_EXPORT",
] as const;

export const gstTreatmentLabels: Record<(typeof gstTreatmentValues)[number], string> = {
  REGISTERED_REGULAR: "Registered Business — Regular",
  REGISTERED_COMPOSITION: "Registered Business — Composition",
  UNREGISTERED: "Unregistered Business",
  CONSUMER: "Consumer",
  OVERSEAS: "Overseas",
  SEZ: "Special Economic Zone (SEZ)",
  DEEMED_EXPORT: "Deemed Export",
};

export const paymentTermsValues = ["DUE_ON_RECEIPT", "ADVANCE", "NET_15", "NET_30", "NET_45", "NET_60"] as const;

export const paymentTermsLabels: Record<(typeof paymentTermsValues)[number], string> = {
  DUE_ON_RECEIPT: "Due on receipt",
  ADVANCE: "Advance",
  NET_15: "Net 15",
  NET_30: "Net 30",
  NET_45: "Net 45",
  NET_60: "Net 60",
};

export const paymentMethodValues = ["BANK_TRANSFER", "UPI", "CHEQUE", "CASH", "CARD", "OTHER"] as const;

export const paymentMethodLabels: Record<(typeof paymentMethodValues)[number], string> = {
  BANK_TRANSFER: "Bank transfer",
  UPI: "UPI",
  CHEQUE: "Cheque",
  CASH: "Cash",
  CARD: "Card",
  OTHER: "Other",
};

/**
 * GST is calculated from the item's own tax rate regardless of the company's GST
 * treatment — treatment affects invoice categorization/compliance, not whether tax
 * applies. A jurisdiction-aware CGST/SGST vs IGST split isn't implemented (that needs
 * Wroffy's own registered state to compare against each company's), so this returns a
 * single combined GST amount.
 */
export function calculateOrderAmount(params: {
  quantity: number;
  unitPrice: number;
  taxRatePercent: number | null;
}) {
  const subtotal = params.quantity * params.unitPrice;
  const rate = params.taxRatePercent ?? 0;
  const gstAmount = Math.round(subtotal * (rate / 100) * 100) / 100;
  const total = Math.round((subtotal + gstAmount) * 100) / 100;
  return { subtotal, gstAmount, total, rate };
}

/** Gross margin on an order — null until both the actual sale price and the purchase (cost) price are known, since a catalog default on either side isn't a real transaction figure. */
export function calculateOrderMargin(params: {
  quantity: number;
  unitPrice: number | null;
  purchasePrice: number | null;
  totalExpenses: number;
}) {
  if (params.unitPrice === null || params.purchasePrice === null) return null;
  const revenue = Math.round(params.quantity * params.unitPrice * 100) / 100;
  const cost = Math.round(params.quantity * params.purchasePrice * 100) / 100;
  const margin = Math.round((revenue - cost - params.totalExpenses) * 100) / 100;
  const marginPercent = revenue > 0 ? Math.round((margin / revenue) * 10000) / 100 : null;
  return { revenue, cost, margin, marginPercent };
}

export type PaymentStatusKey = "unpaid" | "partial" | "paid" | "overpaid";

export function getPaymentStatus(
  total: number,
  paid: number,
): { key: PaymentStatusKey; label: string; tone: "default" | "red" | "amber" | "green" | "blue" } {
  if (paid <= 0) return { key: "unpaid", label: "Unpaid", tone: "red" };
  if (paid < total) return { key: "partial", label: "Partially paid", tone: "amber" };
  if (paid > total) return { key: "overpaid", label: "Overpaid", tone: "blue" };
  return { key: "paid", label: "Paid", tone: "green" };
}

/**
 * The treatment an address should move to when its country changes — or null to leave it alone.
 *
 * Only between the two defaults: Unregistered (domestic) and Overseas. A customer abroad billed as
 * "Unregistered" is taxed as a domestic sale, which is wrong on every invoice; and the quick-create
 * dialog has no treatment field, so there was no way to put it right there. Anything somebody chose
 * deliberately — Registered, SEZ, Deemed export — is left exactly as they chose it.
 */
export function treatmentForCountryChange(
  domestic: boolean,
  current: string | null | undefined,
): (typeof gstTreatmentValues)[number] | null {
  if (!domestic && current === "UNREGISTERED") return "OVERSEAS";
  if (domestic && current === "OVERSEAS") return "UNREGISTERED";
  return null;
}

import { db } from "@/lib/db";
import { formatOrderId } from "@/lib/order-id";
import { partyDetails } from "@/lib/proposals/party";
import { tradeDocumentSchema } from "@/lib/validation/trade-document";
import { createDraftDocument } from "@/lib/documents/create-draft";
import { defaultServicePeriod } from "@/lib/documents/service-period";
import { workspaceClock } from "@/lib/time/workspace";
import { orderBilling } from "@/lib/orders/billing";
import { invoiceTogetherRefusal } from "@/lib/orders/billing-rules";
import { moduleAccessFor } from "@/lib/modules-access";
import { mayAccess } from "@/lib/authz/access";
import type { ActionResult } from "@/actions/company";

/**
 * A tax invoice started from orders (owner, 15 Oct 2026): from the order page or the "to invoice" view,
 * one invoice for one order, for several on the same customer PO, or one per order. Each line bills its
 * order (`companyProductId`) for what is still to bill, at the order's price, over the order's term.
 * Server only.
 */

const orderSelect = {
  id: true,
  orderSeq: true,
  companyId: true,
  locationId: true,
  quantity: true,
  unitPrice: true,
  poNumber: true,
  startDate: true,
  endDate: true,
  orderStatus: true,
  addedByUserId: true,
  company: { select: { id: true, name: true } },
  location: { select: { id: true, address: true, city: true, state: true, pincode: true, country: true, gstNumber: true, gstTreatment: true } },
  item: { select: { id: true, name: true, description: true, unit: true, hsnCode: true, sellingPrice: true, taxRatePercent: true, type: true } },
} as const;

export type OrderForInvoice = NonNullable<Awaited<ReturnType<typeof loadOrders>>>[number];

/** These orders, in the order asked for; null when any is missing, cancelled or rejected. */
export async function loadOrders(ids: string[]) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return null;
  const rows = await db.companyProduct.findMany({ where: { id: { in: unique } }, select: orderSelect });
  if (rows.length !== unique.length || rows.some((r) => r.orderStatus === "CANCELLED" || r.orderStatus === "REJECTED")) return null;
  const byId = new Map(rows.map((r) => [r.id, r]));
  return unique.map((id) => byId.get(id)!);
}

/** One invoice line per order: what is still to bill (all of it, when it's billed in instalments or not at all yet). */
export type OrderInvoiceLine = {
  companyProductId: string;
  itemId: string;
  itemType: string;
  name: string;
  description: string;
  hsnCode: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  taxRatePercent: number;
  servicePeriodFrom: string;
  servicePeriodTo: string;
  periodSource: string;
};

export async function invoiceLinesFor(orders: OrderForInvoice[], issueDate: string): Promise<OrderInvoiceLine[]> {
  const billing = await orderBilling(orders.map((o) => o.id));
  return orders.map((o) => {
    const b = billing.get(o.id);
    const quantity = b && b.status !== "INSTALMENTS" && b.remaining > 0 ? b.remaining : o.quantity;
    const period = defaultServicePeriod({ order: o, item: o.item, issueDate });
    return {
      companyProductId: o.id,
      itemId: o.item.id,
      itemType: o.item.type,
      name: o.item.name,
      description: o.item.description ?? "",
      hsnCode: o.item.hsnCode ?? "",
      unit: o.item.unit ?? "",
      quantity,
      unitPrice: Number(o.unitPrice ?? o.item.sellingPrice ?? 0),
      taxRatePercent: Number(o.item.taxRatePercent ?? 0),
      servicePeriodFrom: period?.from ?? "",
      servicePeriodTo: period?.to ?? "",
      periodSource: period?.source ?? "",
    };
  });
}

/**
 * The new-invoice form started from orders (`/documents/new?type=INVOICE&orders=…`): the orders' customer,
 * site, reference, salesperson and one line each — or why it can't start from them. Orders this person
 * can't see, or a plan without Orders, start nothing.
 */
export async function invoiceStartFromOrders(
  userId: string,
  ids: string[],
  issueDate: string,
): Promise<{ ok: true; orders: OrderForInvoice[]; lines: OrderInvoiceLine[]; reference: string } | { ok: false; error: string }> {
  if ((await moduleAccessFor(userId, "orders")) !== "available") return { ok: false, error: "Orders aren't open to you." };
  const orders = await loadOrders(ids.slice(0, 50));
  if (!orders) return { ok: false, error: "One of those orders no longer exists, or was cancelled." };
  for (const o of orders) if (!(await mayAccess(userId, "orders", "view", o.id))) return { ok: false, error: "One of those orders isn't one you can see." };
  const refused = invoiceTogetherRefusal(orders);
  if (refused) return { ok: false, error: refused };
  return { ok: true, orders, lines: await invoiceLinesFor(orders, issueDate), reference: invoiceReference(orders) };
}

/** What the invoice says it is for: the customer's PO when the orders share one, else the order numbers. */
export function invoiceReference(orders: Pick<OrderForInvoice, "orderSeq" | "poNumber">[]): string {
  const pos = [...new Set(orders.map((o) => o.poNumber?.trim()).filter((p): p is string => !!p))];
  if (pos.length === 1) return `PO ${pos[0]}`.slice(0, 120);
  return orders.map((o) => formatOrderId(o.orderSeq)).join(", ").slice(0, 120);
}

/**
 * A draft tax invoice for these orders, as the person raising it: the customer's site gives the
 * address, place of supply and GST, the orders the lines. Nothing is issued — they check it and issue.
 */
export async function createOrderInvoiceDraft(orders: OrderForInvoice[], actorId: string): Promise<ActionResult<{ id: string }>> {
  const refused = invoiceTogetherRefusal(orders);
  if (refused) return { ok: false, error: refused };
  const first = orders[0]!;
  const party = partyDetails(first.location, first.company.name);
  if (!party.ok) return party;
  const issueDate = (await workspaceClock()).today();
  const lines = await invoiceLinesFor(orders, issueDate);
  const parsed = tradeDocumentSchema.safeParse({
    docType: "INVOICE",
    companyId: first.companyId,
    locationId: party.data.locationId,
    docNumber: "",
    placeOfSupplyCode: party.data.placeOfSupplyCode,
    gstTreatment: party.data.gstTreatment,
    buyerGstin: party.data.gstin,
    reverseCharge: false,
    currency: "INR",
    exchangeRate: 1,
    issueDate,
    dueDate: "",
    validUntil: "",
    reference: invoiceReference(orders),
    salespersonId: first.addedByUserId,
    notes: "",
    terms: "",
    dispatchFromAddress: "",
    billing: party.data.address,
    shippingSameAsBilling: true,
    shipping: party.data.address,
    shippingGstin: "",
    shippingCharge: 0,
    shippingTaxRatePercent: 0,
    withholdingMode: "NONE",
    withholdingSection: "",
    withholdingRatePercent: 0,
    adjustmentLabel: "",
    adjustment: 0,
    sourceDocumentId: "",
    leadId: "",
    againstDocumentId: "",
    lines: lines.map((l) => ({
      itemId: l.itemId,
      companyProductId: l.companyProductId,
      name: l.name,
      description: l.description,
      servicePeriodFrom: l.servicePeriodFrom,
      servicePeriodTo: l.servicePeriodTo,
      hsnCode: l.hsnCode,
      unit: l.unit,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discountMode: "PERCENT",
      discountValue: 0,
      taxRatePercent: l.taxRatePercent,
    })),
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "The invoice didn't validate." };
  return createDraftDocument({ id: actorId, branchFor: first.addedByUserId }, parsed.data, "MANUAL");
}

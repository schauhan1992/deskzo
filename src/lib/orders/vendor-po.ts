import type { Prisma, TradeDocumentStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { formatOrderId } from "@/lib/order-id";
import { partyDetails, type DocumentAddress } from "@/lib/proposals/party";
import { tradeDocumentSchema } from "@/lib/validation/trade-document";
import { isVendorRelationshipType } from "@/lib/validation/company";
import { createDraftDocument, resolveDocumentBranch } from "@/lib/documents/create-draft";
import { branchIdentity } from "@/lib/branches/identity";
import { workspaceClock } from "@/lib/time/workspace";
import { reverseDocumentPosting } from "@/lib/ledger/journal";
import { CANCEL_REASON_MAX } from "@/lib/documents/cancel-reason";
import type { ActionResult } from "@/actions/company";

/**
 * Our purchase order to the vendor, raised from the order (owner, 15 Oct 2026): one click in the order's
 * Purchasing box makes a draft PO — the vendor and price purchase saved, the order's item and quantity,
 * delivered to our own address — and opens it to check and issue. One order, one PO. Its line points at
 * the order (`companyProductId`), which invoicing never counts: only tax invoices and credit notes bill
 * an order (src/lib/orders/billing.ts). Issuing the PO puts its number in the order's "Our PO to vendor";
 * cancelling it takes it out again. Server only.
 */

/** A PO in one of these has gone: the order may have another. */
export const DEAD_PO_STATUSES: readonly TradeDocumentStatus[] = ["CANCELLED", "REJECTED", "EXPIRED"];

export type LivePurchaseOrder = { id: string; docNumber: string; status: TradeDocumentStatus };

/** Each order's live purchase order — a draft counts, so a second one isn't raised beside it. */
export async function livePurchaseOrders(orderIds: string[]): Promise<Map<string, LivePurchaseOrder>> {
  const ids = [...new Set(orderIds.filter(Boolean))];
  const out = new Map<string, LivePurchaseOrder>();
  if (ids.length === 0) return out;
  const lines = await db.tradeDocumentLine.findMany({
    where: {
      companyProductId: { in: ids },
      document: { docType: "PURCHASE_ORDER", status: { notIn: [...DEAD_PO_STATUSES] } },
    },
    select: { companyProductId: true, document: { select: { id: true, docNumber: true, status: true, createdAt: true } } },
    orderBy: [{ document: { createdAt: "asc" } }, { document: { id: "asc" } }],
  });
  for (const l of lines) {
    if (l.companyProductId && !out.has(l.companyProductId)) {
      out.set(l.companyProductId, { id: l.document.id, docNumber: l.document.docNumber, status: l.document.status });
    }
  }
  return out;
}

/** What raising a PO from an order needs of it — the purchasing box's own state. */
export type OrderForPo = {
  orderStatus: string;
  purchaseRelease: string;
  vendorId: string | null;
  purchasePrice: unknown;
  pendingPurchasePrice: unknown;
};

/** Why this order can't have a PO raised from it yet, in words; null when it can. Pure. */
export function vendorPoRefusal(order: OrderForPo): string | null {
  if (order.orderStatus !== "APPROVED" && order.orderStatus !== "PROCESSING") {
    return order.orderStatus === "FULFILLED"
      ? "This order is already fulfilled."
      : order.orderStatus === "CANCELLED" || order.orderStatus === "REJECTED"
        ? "This order was cancelled."
        : "This order isn't ready for purchasing yet — it needs accounts approval first.";
  }
  if (order.purchaseRelease !== "RELEASED") return "This order hasn't come to purchase yet.";
  const price = order.purchasePrice === null || order.purchasePrice === undefined || order.purchasePrice === "" ? NaN : Number(order.purchasePrice);
  if (!order.vendorId || !Number.isFinite(price)) return "Save the vendor and purchase price first — the PO is raised from them.";
  if (order.pendingPurchasePrice !== null && order.pendingPurchasePrice !== undefined) {
    return "The PO waits for sales to accept the higher price.";
  }
  return null;
}

/**
 * A draft purchase order for this order, as the person raising it, from the branch they buy for. The
 * caller has already answered *may they*. Refused when the order already has a live PO.
 */
export async function createVendorPoDraft(orderId: string, actorId: string): Promise<ActionResult<{ id: string; docNumber: string }>> {
  const order = await db.companyProduct.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderSeq: true,
      quantity: true,
      orderStatus: true,
      purchaseRelease: true,
      vendorId: true,
      purchasePrice: true,
      pendingPurchasePrice: true,
      item: { select: { id: true, name: true, description: true, unit: true, hsnCode: true, taxRatePercent: true } },
    },
  });
  if (!order) return { ok: false, error: "Order not found." };
  const refused = vendorPoRefusal(order);
  if (refused) return { ok: false, error: refused };
  const live = (await livePurchaseOrders([order.id])).get(order.id);
  if (live) return { ok: false, error: `This order already has purchase order ${live.docNumber}.` };

  const vendor = await db.company.findUnique({
    where: { id: order.vendorId! },
    select: {
      id: true,
      name: true,
      relationshipType: true,
      // The vendor's billing address, else its main one, else the first it was given.
      locations: {
        select: { id: true, address: true, city: true, state: true, pincode: true, country: true, gstNumber: true, gstTreatment: true },
        orderBy: [{ isBilling: "desc" }, { isPrimary: "desc" }, { createdAt: "asc" }],
        take: 1,
      },
    },
  });
  if (!vendor || !isVendorRelationshipType(vendor.relationshipType)) return { ok: false, error: "The vendor saved on this order is no longer a vendor." };
  const party = partyDetails(vendor.locations[0] ?? null, vendor.name);
  if (!party.ok) return party;

  // Delivered to us (owner's choice): the buying branch's own address, printed as "Ship to".
  const picked = await resolveDocumentBranch({ userId: actorId, docType: "PURCHASE_ORDER", requestedBranchId: null, againstDocumentId: null });
  if ("error" in picked) return { ok: false, error: picked.error };
  const us = await branchIdentity(picked.branch.id);
  const ourAddress: DocumentAddress = {
    attention: "",
    line1: us.addressLine1 ?? "",
    line2: us.addressLine2 ?? "",
    city: us.city ?? "",
    state: us.state ?? "",
    stateCode: us.stateCode ?? "",
    pincode: us.pincode ?? "",
    country: us.country?.trim() || "India",
    phone: us.phone ?? "",
  };

  const parsed = tradeDocumentSchema.safeParse({
    docType: "PURCHASE_ORDER",
    companyId: vendor.id,
    locationId: party.data.locationId,
    branchId: picked.branch.id,
    docNumber: "",
    // A purchase's place of supply is the buying branch's own state; the server works it out.
    placeOfSupplyCode: "",
    gstTreatment: party.data.gstTreatment,
    buyerGstin: party.data.gstin,
    reverseCharge: false,
    currency: "INR",
    exchangeRate: 1,
    issueDate: (await workspaceClock()).today(),
    dueDate: "",
    validUntil: "",
    reference: formatOrderId(order.orderSeq),
    salespersonId: "",
    notes: "",
    terms: "",
    dispatchFromAddress: "",
    billing: party.data.address,
    shippingSameAsBilling: false,
    shipping: ourAddress,
    shippingGstin: us.gstin ?? "",
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
    lines: [
      {
        itemId: order.item.id,
        companyProductId: order.id,
        name: order.item.name,
        description: order.item.description ?? "",
        servicePeriodFrom: "",
        servicePeriodTo: "",
        hsnCode: order.item.hsnCode ?? "",
        unit: order.item.unit ?? "",
        quantity: order.quantity,
        unitPrice: Number(order.purchasePrice),
        discountMode: "PERCENT",
        discountValue: 0,
        taxRatePercent: Number(order.item.taxRatePercent ?? 0),
      },
    ],
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "The purchase order didn't validate." };
  const made = await createDraftDocument({ id: actorId }, parsed.data, "MANUAL");
  if (!made.ok) return made;

  // Two presses at once each passed the check above: the first PO made stands, and this one goes.
  const first = (await livePurchaseOrders([order.id])).get(order.id);
  if (first && first.id !== made.data.id) {
    await db.tradeDocument.delete({ where: { id: made.data.id } });
    return { ok: false, error: `This order already has purchase order ${first.docNumber}.` };
  }
  const docNumber = (await db.tradeDocument.findUnique({ where: { id: made.data.id }, select: { docNumber: true } }))?.docNumber ?? "";
  return { ok: true, data: { id: made.data.id, docNumber } };
}

/**
 * Keeps "Our PO to vendor" on the orders a purchase order's lines are for in step with it: issued (or
 * accepted, or paid) puts its number there; cancelled, rejected or expired takes it out, where it is
 * still this PO's number. A draft changes nothing. Never throws — a document's own change has already
 * happened, and the order's field is a convenience beside it. Returns the orders it changed.
 */
export async function syncOrdersWithPurchaseOrder(documentId: string): Promise<string[]> {
  try {
    const po = await db.tradeDocument.findUnique({
      where: { id: documentId },
      select: { docType: true, status: true, docNumber: true, lines: { select: { companyProductId: true } } },
    });
    if (!po || po.docType !== "PURCHASE_ORDER" || po.status === "DRAFT") return [];
    const orderIds = [...new Set(po.lines.map((l) => l.companyProductId).filter((v): v is string => !!v))];
    if (orderIds.length === 0) return [];
    const where = DEAD_PO_STATUSES.includes(po.status)
      ? { id: { in: orderIds }, ourPoNumber: po.docNumber }
      : // Blank or another number — a NOT alone would leave the blanks out (it's NULL in SQL).
        { id: { in: orderIds }, OR: [{ ourPoNumber: null }, { ourPoNumber: { not: po.docNumber } }] };
    const changing = await db.companyProduct.findMany({ where, select: { id: true } });
    if (changing.length === 0) return [];
    await db.companyProduct.updateMany({
      where: { id: { in: changing.map((o) => o.id) } },
      data: { ourPoNumber: DEAD_PO_STATUSES.includes(po.status) ? null : po.docNumber },
    });
    return changing.map((o) => o.id);
  } catch (err) {
    console.error("[orders] couldn't bring the order's PO number in step with its purchase order", err);
    return [];
  }
}

/** Whether any purchase order for this order has gone to the vendor — issued, not a draft, not cancelled. */
export async function hasIssuedPurchaseOrder(orderId: string): Promise<boolean> {
  const count = await db.tradeDocumentLine.count({
    where: { companyProductId: orderId, document: { docType: "PURCHASE_ORDER", status: { notIn: ["DRAFT", ...DEAD_PO_STATUSES] } } },
  });
  return count > 0;
}

export type PoCancelledWithOrder = { id: string; docNumber: string; wasIssued: boolean; createdById: string | null };
/** Left open: the vendor has billed us against it, or it also buys for another order still live. */
export type PoKeptOnCancel = { id: string; docNumber: string; why: "BILLED" | "OTHER_ORDERS"; createdById: string | null };

/**
 * The customer cancelled the order, so the purchase orders raised for it are cancelled with it (owner,
 * 15 Oct 2026) — a draft as much as an issued one, each saying in its cancel reason which order and
 * why, so the PO itself tells anybody who opens it. Two stay open, for purchase to settle by hand: one
 * the vendor has already billed us against (a bill was raised from it — that is a return, not a
 * cancellation), and one that also buys for another order still live.
 *
 * Run inside the order's own cancellation, after the order is marked cancelled. The order keeps its
 * "Our PO to vendor": it is the number purchase quotes when cancelling with the vendor.
 */
export async function cancelPurchaseOrdersWithOrder(
  tx: Prisma.TransactionClient,
  input: { orderId: string; orderLabel: string; reason: string; userId: string; at: Date },
): Promise<{ cancelled: PoCancelledWithOrder[]; kept: PoKeptOnCancel[] }> {
  const lines = await tx.tradeDocumentLine.findMany({
    where: { companyProductId: input.orderId, document: { docType: "PURCHASE_ORDER", status: { notIn: [...DEAD_PO_STATUSES] } } },
    select: {
      document: {
        select: {
          id: true,
          docNumber: true,
          status: true,
          createdById: true,
          conversions: { select: { status: true } },
          lines: { select: { companyProductId: true, companyProduct: { select: { orderStatus: true } } } },
        },
      },
    },
  });
  const documents = [...new Map(lines.map((l) => [l.document.id, l.document])).values()];
  const reason = `Customer order ${input.orderLabel} was cancelled${input.reason ? `: ${input.reason}` : "."}`.slice(0, CANCEL_REASON_MAX);
  const cancelled: PoCancelledWithOrder[] = [];
  const kept: PoKeptOnCancel[] = [];
  for (const po of documents) {
    const billed = po.conversions.some((c) => !DEAD_PO_STATUSES.includes(c.status));
    const otherLive = po.lines.some(
      (l) => l.companyProductId && l.companyProductId !== input.orderId && l.companyProduct && !["CANCELLED", "REJECTED"].includes(l.companyProduct.orderStatus),
    );
    if (billed || otherLive) {
      kept.push({ id: po.id, docNumber: po.docNumber, why: billed ? "BILLED" : "OTHER_ORDERS", createdById: po.createdById });
      continue;
    }
    await tx.tradeDocument.update({
      where: { id: po.id },
      data: { status: "CANCELLED", cancelReason: reason, cancelledAt: input.at, cancelledById: input.userId },
      select: { id: true },
    });
    // A PO posts nothing; this is for the day one does.
    await reverseDocumentPosting(tx, po.id, input.userId);
    cancelled.push({ id: po.id, docNumber: po.docNumber, wasIssued: po.status !== "DRAFT", createdById: po.createdById });
  }
  return { cancelled, kept };
}

/** What became of an order's purchase orders when it was cancelled, in a sentence for the people told. */
export function purchaseOrdersOnCancelNote(outcome: { cancelled: { docNumber: string }[]; kept: PoKeptOnCancel[] }): string {
  const parts: string[] = [];
  if (outcome.cancelled.length) {
    const numbers = outcome.cancelled.map((p) => p.docNumber).join(", ");
    parts.push(`${outcome.cancelled.length === 1 ? "Purchase order" : "Purchase orders"} ${numbers} ${outcome.cancelled.length === 1 ? "was" : "were"} cancelled with it.`);
  }
  for (const k of outcome.kept) {
    parts.push(
      k.why === "BILLED"
        ? `${k.docNumber} stays open — the vendor has billed us against it, so settle it with them (a vendor credit note).`
        : `${k.docNumber} stays open — it also buys for another order.`,
    );
  }
  return parts.join(" ");
}

/** The purchase orders raised for an order, newest first, whatever became of them — for the order page. */
export async function purchaseOrdersOf(orderId: string): Promise<{ id: string; docNumber: string; status: TradeDocumentStatus }[]> {
  const lines = await db.tradeDocumentLine.findMany({
    where: { companyProductId: orderId, document: { docType: "PURCHASE_ORDER" } },
    select: { document: { select: { id: true, docNumber: true, status: true, createdAt: true } } },
    orderBy: { document: { createdAt: "desc" } },
  });
  return [...new Map(lines.map((l) => [l.document.id, { id: l.document.id, docNumber: l.document.docNumber, status: l.document.status }])).values()];
}

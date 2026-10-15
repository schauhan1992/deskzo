"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireModuleUser, moduleAccessFor } from "@/lib/modules-access";
import { refuseWhileViewingAs } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { documentAccess, mayAccess, mayAddTo, orderAccess } from "@/lib/authz/access";
import { orderBilling, toInvoiceWhere } from "@/lib/orders/billing";
import { recordAudit } from "@/lib/audit";
import { formatOrderId } from "@/lib/order-id";
import { orderPath } from "@/lib/record-links";
import { createOrderInvoiceDraft, loadOrders, type OrderForInvoice } from "@/lib/orders/invoice-draft";
import { invoiceTogetherRefusal, type OrderBillingStatus } from "@/lib/orders/billing-rules";
import type { ActionResult } from "@/actions/company";

/**
 * Invoicing orders (owner, 15 Oct 2026): draft tax invoices raised from orders, and an order linked to
 * an invoice that was raised before it was punched.
 *
 * Orders' own file, borrowing invoices: everything here also asks for Sales documents in the plan and
 * "Raise and issue sales documents" — the same gate the invoice form has — so a workspace with Orders
 * and no Books gets no invoice it couldn't have raised itself.
 */

async function invoicingUser(): Promise<{ user: { id: string; name?: string | null } } | { error: string }> {
  const user = await requireModuleUser("orders");
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { error: viewingAs };
  if ((await moduleAccessFor(user.id, "sales_documents")) !== "available") return { error: "Tax invoices aren't part of this workspace's plan." };
  if (!(await can(user.id, "documents.issue"))) return { error: "You don't have permission to raise or issue sales documents." };
  return { user };
}

/** The orders, if this person may see each and raise an invoice to its customer. */
async function ordersToInvoice(userId: string, ids: string[]): Promise<OrderForInvoice[] | { error: string }> {
  const orders = await loadOrders(ids.slice(0, 50));
  if (!orders) return { error: "One of those orders no longer exists, or was cancelled." };
  for (const o of orders) {
    if (!(await mayAccess(userId, "orders", "view", o.id))) return { error: "One of those orders isn't one you can see." };
  }
  const company = await db.company.findUnique({ where: { id: orders[0]!.companyId }, select: { ownerUserId: true, relationshipType: true } });
  if (!company || !(await mayAddTo(userId, "documents", company))) return { error: "You can't raise documents for this customer." };
  return orders;
}

const revalidateOrders = (orders: { orderSeq: number }[]) => {
  for (const o of orders) revalidatePath(orderPath(o.orderSeq));
  revalidatePath("/orders");
  revalidatePath("/sales/invoices");
};

/**
 * Draft tax invoices for these orders: one for them all (`ONE` — they must share a customer and a site)
 * or one per order (`EACH`). Each bills what is still to bill. Nothing is issued.
 */
export async function createInvoicesForOrders(orderIds: string[], mode: "ONE" | "EACH"): Promise<ActionResult<{ ids: string[] }>> {
  const auth = await invoicingUser();
  if ("error" in auth) return { ok: false, error: auth.error };
  const orders = await ordersToInvoice(auth.user.id, orderIds);
  if ("error" in orders) return { ok: false, error: orders.error };
  const groups = mode === "ONE" ? [orders] : orders.map((o) => [o]);
  if (mode === "ONE") {
    const refused = invoiceTogetherRefusal(orders);
    if (refused) return { ok: false, error: refused };
  }
  const ids: string[] = [];
  for (const group of groups) {
    const made = await createOrderInvoiceDraft(group, auth.user.id);
    if (!made.ok) {
      const which = group.map((o) => formatOrderId(o.orderSeq)).join(", ");
      return { ok: false, error: ids.length ? `${ids.length} draft(s) made; ${which} wasn't: ${made.error}` : made.error };
    }
    ids.push(made.data.id);
  }
  revalidateOrders(orders);
  return { ok: true, data: { ids } };
}

export type ToInvoiceOrder = {
  id: string;
  orderSeq: number;
  itemName: string;
  unit: string | null;
  locationId: string;
  ordered: number;
  invoiced: number;
  remaining: number;
  status: OrderBillingStatus;
  /** What is still to bill, at the order's price, before GST. */
  amountToBill: number;
};

export type ToInvoiceGroup = {
  key: string;
  company: { id: string; companySeq: number; name: string };
  /** The customer's PO the orders share; null for an order with none, which stands alone. */
  po: string | null;
  orders: ToInvoiceOrder[];
  /** They share one site, so one invoice can carry them all. */
  oneSite: boolean;
};

/**
 * Finance's "to invoice" view: sold orders still to bill that this person can see, grouped by the
 * customer's PO — the orders that usually go on one invoice. Oldest first; at most 500 orders.
 */
export async function listOrdersToInvoice(params: { search?: string } = {}): Promise<ToInvoiceGroup[]> {
  const user = await requireModuleUser("orders");
  if (!(await can(user.id, "orders.view"))) return [];
  const search = params.search?.trim();
  const rows = await db.companyProduct.findMany({
    where: {
      AND: [
        await orderAccess(user.id, "view"),
        await toInvoiceWhere(),
        ...(search ? [{ OR: [{ company: { name: { contains: search, mode: "insensitive" as const } } }, { poNumber: { contains: search, mode: "insensitive" as const } }] }] : []),
      ],
    },
    select: {
      id: true,
      orderSeq: true,
      locationId: true,
      poNumber: true,
      unitPrice: true,
      company: { select: { id: true, companySeq: true, name: true } },
      item: { select: { name: true, unit: true, sellingPrice: true } },
    },
    orderBy: { orderSeq: "asc" },
    take: 500,
  });
  const billing = await orderBilling(rows.map((r) => r.id));
  const groups = new Map<string, ToInvoiceGroup>();
  for (const r of rows) {
    const b = billing.get(r.id)!;
    const po = r.poNumber?.trim() || null;
    const key = po ? `${r.company.id}|${po.toLowerCase()}` : `order|${r.id}`;
    const group = groups.get(key) ?? { key, company: r.company, po, orders: [], oneSite: true };
    group.orders.push({
      id: r.id,
      orderSeq: r.orderSeq,
      itemName: r.item.name,
      unit: r.item.unit,
      locationId: r.locationId,
      ordered: b.ordered,
      invoiced: b.invoiced,
      remaining: b.remaining,
      status: b.status,
      amountToBill: Math.round(b.remaining * Number(r.unitPrice ?? r.item.sellingPrice ?? 0) * 100) / 100,
    });
    group.oneSite = new Set(group.orders.map((o) => o.locationId)).size === 1;
    groups.set(key, group);
  }
  return [...groups.values()];
}

export type LinkableInvoiceLine = {
  lineId: string;
  documentId: string;
  docNumber: string;
  issueDate: string;
  name: string;
  quantity: number;
  amount: number;
  /** The line is for this order's product — the likely match, listed first. */
  sameProduct: boolean;
};

/**
 * Lines of this customer's tax invoices that bill no order yet — for an order punched after its
 * invoice. Issued invoices only; a draft is linked from the invoice form itself.
 */
export async function invoiceLinesToLink(orderId: string): Promise<LinkableInvoiceLine[]> {
  const auth = await invoicingUser();
  if ("error" in auth) return [];
  if (!(await mayAccess(auth.user.id, "orders", "view", orderId))) return [];
  const order = await db.companyProduct.findUnique({ where: { id: orderId }, select: { companyId: true, itemId: true } });
  if (!order) return [];
  const rows = await db.tradeDocumentLine.findMany({
    where: {
      companyProductId: null,
      document: { AND: [{ companyId: order.companyId, docType: "INVOICE", status: { notIn: ["DRAFT", "CANCELLED", "REJECTED", "EXPIRED"] } }, await documentAccess(auth.user.id, "view")] },
    },
    select: { id: true, name: true, quantity: true, lineTotal: true, itemId: true, document: { select: { id: true, docNumber: true, issueDate: true } } },
    orderBy: { document: { issueDate: "desc" } },
    take: 60,
  });
  return rows
    .map((r) => ({
      lineId: r.id,
      documentId: r.document.id,
      docNumber: r.document.docNumber,
      issueDate: r.document.issueDate.toISOString(),
      name: r.name,
      quantity: Number(r.quantity),
      amount: Number(r.lineTotal),
      sameProduct: r.itemId === order.itemId,
    }))
    .sort((a, b) => Number(b.sameProduct) - Number(a.sameProduct));
}

/** The line of an invoice this order is linked to or from, if this person may change that link. */
async function lineFor(userId: string, orderId: string, lineId: string) {
  if (!(await mayAccess(userId, "orders", "view", orderId))) return null;
  const [order, line] = await Promise.all([
    db.companyProduct.findUnique({ where: { id: orderId }, select: { id: true, orderSeq: true, companyId: true } }),
    db.tradeDocumentLine.findUnique({
      where: { id: lineId },
      select: { id: true, companyProductId: true, document: { select: { id: true, docNumber: true, docType: true, status: true, companyId: true } } },
    }),
  ]);
  if (!order || !line) return null;
  const visible = await db.tradeDocument.count({ where: { AND: [{ id: line.document.id }, await documentAccess(userId, "view")] } });
  return visible ? { order, line } : null;
}

/**
 * Links an issued invoice's line to this order — for an order punched after the invoice that billed it.
 * Only the link: the invoice's amounts, tax and number are untouched, as an issued invoice must be.
 */
export async function linkInvoiceLine(orderId: string, lineId: string): Promise<ActionResult<null>> {
  const auth = await invoicingUser();
  if ("error" in auth) return { ok: false, error: auth.error };
  const found = await lineFor(auth.user.id, orderId, lineId);
  if (!found) return { ok: false, error: "That invoice line isn't one you can link." };
  const { order, line } = found;
  if (line.document.docType !== "INVOICE" || line.document.companyId !== order.companyId) return { ok: false, error: "Only a tax invoice to this order's customer can be linked." };
  if (["DRAFT", "CANCELLED", "REJECTED", "EXPIRED"].includes(line.document.status)) return { ok: false, error: "Only an issued invoice is linked here — a draft is linked from the invoice itself." };
  if (line.companyProductId === order.id) return { ok: true, data: null };
  if (line.companyProductId) return { ok: false, error: "That line already bills another order." };
  await db.tradeDocumentLine.update({ where: { id: line.id }, data: { companyProductId: order.id } });
  await recordAudit({ userId: auth.user.id, action: "UPDATE", entityType: "Order", entityId: order.id, entityLabel: `${formatOrderId(order.orderSeq)} linked to invoice ${line.document.docNumber}` });
  revalidateOrders([order]);
  return { ok: true, data: null };
}

/** Takes a link back — the line no longer counts as billing this order. The invoice itself is untouched. */
export async function unlinkInvoiceLine(orderId: string, lineId: string): Promise<ActionResult<null>> {
  const auth = await invoicingUser();
  if ("error" in auth) return { ok: false, error: auth.error };
  const found = await lineFor(auth.user.id, orderId, lineId);
  if (!found || found.line.companyProductId !== orderId) return { ok: false, error: "That invoice line doesn't bill this order." };
  if (found.line.document.status === "DRAFT") return { ok: false, error: "Change a draft's lines on the draft itself." };
  await db.tradeDocumentLine.update({ where: { id: lineId }, data: { companyProductId: null } });
  await recordAudit({ userId: auth.user.id, action: "UPDATE", entityType: "Order", entityId: orderId, entityLabel: `${formatOrderId(found.order.orderSeq)} unlinked from invoice ${found.line.document.docNumber}` });
  revalidateOrders([found.order]);
  return { ok: true, data: null };
}

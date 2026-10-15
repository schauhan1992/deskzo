"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireModuleUser, moduleAccessFor } from "@/lib/modules-access";
import { refuseWhileViewingAs } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { mayAccess, mayAddTo } from "@/lib/authz/access";
import { orderPath } from "@/lib/record-links";
import { documentListPath } from "@/lib/trade-documents";
import { createVendorPoDraft } from "@/lib/orders/vendor-po";
import type { ActionResult } from "@/actions/company";

/**
 * "Create vendor PO" in an order's Purchasing box (owner, 15 Oct 2026): a draft purchase order to the
 * vendor purchase saved, opened to check and issue (src/lib/orders/vendor-po.ts).
 *
 * Orders' own file, borrowing purchase orders: it asks for Purchase documents in the plan and "Raise
 * purchase orders", as the PO form does, as well as "Process orders" — the purchasing box is theirs.
 */
export async function createVendorPoForOrder(orderId: string): Promise<ActionResult<{ id: string; docNumber: string }>> {
  const user = await requireModuleUser("orders");
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  if ((await moduleAccessFor(user.id, "purchase_documents")) !== "available") {
    return { ok: false, error: "Purchase orders aren't part of this workspace's plan." };
  }
  if (!(await can(user.id, "orders.process"))) return { ok: false, error: "You don't have permission to process orders." };
  if (!(await can(user.id, "purchase.raiseOrders"))) return { ok: false, error: "You don't have permission to raise purchase orders." };
  if (typeof orderId !== "string" || !orderId || !(await mayAccess(user.id, "orders", "view", orderId))) {
    return { ok: false, error: "Order not found." };
  }
  const order = await db.companyProduct.findUnique({ where: { id: orderId }, select: { orderSeq: true, vendorId: true } });
  if (!order) return { ok: false, error: "Order not found." };
  if (order.vendorId) {
    const vendor = await db.company.findUnique({ where: { id: order.vendorId }, select: { ownerUserId: true, relationshipType: true } });
    if (!vendor || !(await mayAddTo(user.id, "documents", vendor))) return { ok: false, error: "You can't raise documents for this vendor." };
  }

  const made = await createVendorPoDraft(orderId, user.id);
  if (!made.ok) return made;
  revalidatePath(orderPath(order.orderSeq));
  revalidatePath("/orders");
  revalidatePath(documentListPath.PURCHASE_ORDER);
  return made;
}

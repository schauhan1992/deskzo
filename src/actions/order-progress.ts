"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { formatOrderId } from "@/lib/order-id";
import { orderSteps, stepIdsOf } from "@/lib/pipeline/order-steps-server";
import { stepOfOrder, stepsOf, takesSteps } from "@/lib/pipeline/order-steps";
import type { ActionResult } from "@/actions/company";

/**
 * Moving an order between the workspace's own steps within its status (src/lib/pipeline/order-steps.ts)
 * — "Material ordered" to "Installed". The status itself moves only through its own actions (approve,
 * process, fulfil, cancel in src/actions/order.ts); this says where within it the order has got to.
 *
 * Who may: whoever works the order through — purchase (`orders.process`), the salesperson who punched
 * it, or anyone who approves orders — on an account they can open. An order out of scope answers as one
 * that doesn't exist.
 */
export async function setOrderStep(orderId: string, stepId: string, note?: string | null): Promise<ActionResult<null>> {
  const user = await requireModuleUser("orders");
  if (typeof orderId !== "string" || !orderId || typeof stepId !== "string" || !stepId) return { ok: false, error: "Order not found." };
  const order = await db.companyProduct.findUnique({
    where: { id: orderId },
    select: { id: true, orderSeq: true, orderStatus: true, addedByUserId: true, company: { select: { name: true, ownerUserId: true } } },
  });
  if (!order || !(await canSeeCompany(user.id, order.company.ownerUserId))) return { ok: false, error: "Order not found." };
  const allowed =
    order.addedByUserId === user.id || (await hasEffectivePermission(user.id, "orders.process")) || (await hasEffectivePermission(user.id, "orders.approve"));
  if (!allowed) return { ok: false, error: "Only the salesperson, an approver or purchase can move this order along." };
  if (!takesSteps(order.orderStatus)) return { ok: false, error: "An order has steps once it is approved, until it is fulfilled — not while it waits, or once cancelled or rejected." };

  const { steps, stored } = await orderSteps();
  if (!stored) return { ok: false, error: "This workspace is still being updated. Try again in a minute." };
  const target = stepsOf(steps, order.orderStatus).find((s) => s.id === stepId);
  if (!target) return { ok: false, error: "That step isn't one of this order's. Refresh the page and choose again." };
  const from = stepOfOrder(steps, { orderStatus: order.orderStatus, stepId: (await stepIdsOf([order.id])).get(order.id) });
  if (from?.id === target.id) return { ok: true, data: null };

  const text = note?.trim().slice(0, 500) || null;
  await db.$transaction(async (tx) => {
    await tx.companyProduct.update({ where: { id: order.id }, data: { stepId: target.id, stepChangedAt: new Date() } });
    await tx.orderStepChange.create({
      data: { orderId: order.id, fromStepId: from?.id ?? null, fromLabel: from?.label ?? null, toStepId: target.id, toLabel: target.label, userId: user.id, note: text },
    });
  });

  const ref = formatOrderId(order.orderSeq);
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Order", entityId: order.id, entityLabel: `${ref} — ${from ? `${from.label} → ` : ""}${target.label}` });
  // The salesperson hears when somebody else moves their order on — it is their customer asking.
  if (order.addedByUserId !== user.id) {
    await notifyUser({
      userId: order.addedByUserId,
      type: "ORDER_STATUS_CHANGED",
      title: `${ref} is at ${target.label}`,
      message: `${order.company.name}${text ? ` — ${text}` : ""}`,
      link: `/orders/${order.id}`,
    });
  }
  revalidatePath("/orders");
  revalidatePath(`/orders/${order.id}`);
  return { ok: true, data: null };
}

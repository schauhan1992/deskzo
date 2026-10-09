"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { formatOrderId } from "@/lib/order-id";
import { orderPath } from "@/lib/record-links";
import { orderSteps } from "@/lib/pipeline/order-steps-server";
import { nextStepsOf, stepOfOrder, stepsOf, takesSteps } from "@/lib/pipeline/order-steps";
import type { OrderStatus } from "@prisma/client";
import type { ActionResult } from "@/actions/company";

/**
 * Moving an order between the workspace's own steps within its status (src/lib/pipeline/order-steps.ts)
 * — "Material ordered" to "Installed". The status itself moves only through its own actions (approve,
 * process, fulfil, cancel in src/actions/order.ts); this says where within it the order has got to.
 *
 * Who may: whoever works the order through — purchase (`orders.process`), the salesperson who punched
 * it, or anyone who approves orders — on an account they can open. An order out of scope answers as one
 * that doesn't exist.
 *
 * Forward only (`nextStepsOf`), and decided against the order as it is when the move is written: the
 * row is locked for the move, so two clicks, two tabs or a page left open after somebody else moved it
 * on are taken one at a time. `from` is the step the page showed; given, a move made from a page that
 * is out of date is refused rather than applied to an order that has since moved. Asking for the step
 * the order is already at records nothing, however often it is asked.
 */
export async function setOrderStep(orderId: string, stepId: string, note?: string | null, from?: string | null): Promise<ActionResult<null>> {
  const user = await requireModuleUser("orders");
  if (typeof orderId !== "string" || !orderId || typeof stepId !== "string" || !stepId) return { ok: false, error: "Order not found." };
  const order = await db.companyProduct.findUnique({
    where: { id: orderId },
    select: { id: true, orderSeq: true, orderStatus: true, addedByUserId: true, company: { select: { name: true, ownerUserId: true, relationshipType: true } } },
  });
  if (!order || !(await canSeeCompany(user.id, order.company))) return { ok: false, error: "Order not found." };
  const allowed =
    order.addedByUserId === user.id || (await hasEffectivePermission(user.id, "orders.process")) || (await hasEffectivePermission(user.id, "orders.approve"));
  if (!allowed) return { ok: false, error: "Only the salesperson, an approver or purchase can move this order along." };
  if (!takesSteps(order.orderStatus)) return { ok: false, error: "An order has steps once it is approved, until it is fulfilled — not while it waits, or once cancelled or rejected." };

  const { steps, stored } = await orderSteps();
  if (!stored) return { ok: false, error: "This workspace is still being updated. Try again in a minute." };
  const target = stepsOf(steps, order.orderStatus).find((s) => s.id === stepId);
  if (!target) return { ok: false, error: "That step isn't one of this order's. Refresh the page and choose again." };

  const text = note?.trim().slice(0, 500) || null;
  const outcome = await db.$transaction(async (tx) => {
    // The order as it is now, held until this move is written. `stepId` is read by name, as everywhere
    // (src/lib/pipeline/order-steps-server.ts): `stored` above says this workspace has it.
    const [row] = await tx.$queryRaw<{ stepId: string | null; orderStatus: OrderStatus }[]>`
      SELECT "stepId", "orderStatus"::text AS "orderStatus" FROM "company_products" WHERE "id" = ${order.id} FOR UPDATE`;
    if (!row || row.orderStatus !== order.orderStatus) return { kind: "stale" as const };
    const at = stepOfOrder(steps, { orderStatus: row.orderStatus, stepId: row.stepId });
    if (at?.id === target.id) return { kind: "there" as const };
    if (from !== undefined && (at?.id ?? null) !== from) return { kind: "stale" as const };
    if (!nextStepsOf(steps, row.orderStatus, at?.id ?? null).some((s) => s.id === target.id)) return { kind: "back" as const, at };
    await tx.companyProduct.update({ where: { id: order.id }, data: { stepId: target.id, stepChangedAt: new Date() } });
    await tx.orderStepChange.create({
      data: { orderId: order.id, fromStepId: at?.id ?? null, fromLabel: at?.label ?? null, toStepId: target.id, toLabel: target.label, userId: user.id, note: text },
    });
    return { kind: "moved" as const, at };
  });
  if (outcome.kind === "there") return { ok: true, data: null };
  if (outcome.kind === "stale") return { ok: false, error: "This order has moved on since the page was opened. Refresh to see where it is now." };
  if (outcome.kind === "back") {
    return { ok: false, error: `${target.label} comes before ${outcome.at?.label ?? "where the order is"} — an order only moves forward through its steps.` };
  }
  const prior = outcome.at;

  const ref = formatOrderId(order.orderSeq);
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Order", entityId: order.id, entityLabel: `${ref} — ${prior ? `${prior.label} → ` : ""}${target.label}` });
  // The salesperson hears when somebody else moves their order on — it is their customer asking.
  if (order.addedByUserId !== user.id) {
    await notifyUser({
      userId: order.addedByUserId,
      type: "ORDER_STATUS_CHANGED",
      title: `${ref} is at ${target.label}`,
      message: `${order.company.name}${text ? ` — ${text}` : ""}`,
      link: orderPath(order.orderSeq),
    });
  }
  revalidatePath("/orders");
  revalidatePath(`/orders/${order.id}`);
  return { ok: true, data: null };
}

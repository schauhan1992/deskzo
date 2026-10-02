import { cache } from "react";
import type { OrderStatus, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/custom-fields/server";
import { isStageColor } from "@/lib/pipeline/rules";
import { stepOfOrder, stepsOf, type OrderStepDef } from "@/lib/pipeline/order-steps";

/**
 * The workspace's own order steps, read from its database (src/lib/pipeline/order-steps.ts has the
 * rules). Fails soft while a workspace waits for the migration that brought them
 * (20261016100000_order_steps): no steps, and `stored` false, so nothing offers to set one.
 * `CompanyProduct.stepId` is left out of select-less reads until every workspace has it
 * (NOT_YET_EVERYWHERE in src/lib/tenancy/clients.ts), so it is read by name, through here.
 */

export type OrderSteps = { steps: OrderStepDef[]; stored: boolean };

/** Every step, retired ones included, by status and then in order. Once per request. */
export const orderSteps = cache(async (): Promise<OrderSteps> => {
  try {
    const rows = await db.orderStep.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
    return {
      stored: true,
      steps: rows.map((r) => ({
        id: r.id,
        key: r.key,
        label: r.label,
        status: r.status,
        color: isStageColor(r.color) ? r.color : "default",
        archived: r.archivedAt !== null,
      })),
    };
  } catch (err) {
    if (notMigratedYet(err)) return { steps: [], stored: false };
    throw err;
  }
});

/** Each of these orders' step ids, by order id — read on their own, by name. Empty before the migration. */
export async function stepIdsOf(orderIds: string[]): Promise<Map<string, string | null>> {
  if (orderIds.length === 0) return new Map();
  try {
    const rows = await db.companyProduct.findMany({ where: { id: { in: orderIds } }, select: { id: true, stepId: true } });
    return new Map(rows.map((r) => [r.id, r.stepId]));
  } catch (err) {
    if (notMigratedYet(err)) return new Map();
    throw err;
  }
}

/** The step each of these orders shows (`stepOfOrder`), by order id — null where its status has none. */
export async function stepsOfOrders(orders: { id: string; orderStatus: OrderStatus }[]): Promise<Map<string, OrderStepDef | null>> {
  const [{ steps }, ids] = await Promise.all([orderSteps(), stepIdsOf(orders.map((o) => o.id))]);
  return new Map(orders.map((o) => [o.id, stepOfOrder(steps, { orderStatus: o.orderStatus, stepId: ids.get(o.id) })]));
}

/**
 * A `where` for the orders shown at this step. The first step of a status also holds the orders in
 * that status with no step of it — none set yet, one since retired, or one left from the status they
 * were in before (`stepOfOrder`).
 */
export function inStepWhere(data: OrderSteps, step: OrderStepDef): Prisma.CompanyProductWhereInput {
  if (!data.stored) return { id: { in: [] } };
  const first = stepsOf(data.steps, step.status)[0]?.id === step.id;
  if (!first) return { orderStatus: step.status, stepId: step.id };
  return {
    orderStatus: step.status,
    OR: [{ stepId: step.id }, { stepId: null }, { step: { status: { not: step.status } } }, { step: { archivedAt: { not: null } } }],
  };
}

export type StepMove = { id: string; fromLabel: string | null; toLabel: string; note: string | null; createdAt: Date; by: string };

/** An order's moves between steps, newest first — the progress history on its page. */
export async function stepHistory(orderId: string, take = 20): Promise<StepMove[]> {
  try {
    const rows = await db.orderStepChange.findMany({
      where: { orderId },
      orderBy: { createdAt: "desc" },
      take,
      select: { id: true, fromLabel: true, toLabel: true, note: true, createdAt: true, user: { select: { name: true } } },
    });
    return rows.map((r) => ({ id: r.id, fromLabel: r.fromLabel, toLabel: r.toLabel, note: r.note, createdAt: r.createdAt, by: r.user.name }));
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

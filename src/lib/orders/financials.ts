import { calculateOrderAmount } from "@/lib/gst";

/**
 * What an order is worth, what has been allocated to it, and what is still owed — the one calculation
 * the Payments screens, the dashboard snapshot and Collections all read.
 *
 * Lifted out of src/actions/payment.ts, where it was module-private: a `"use server"` file can only
 * export async functions, and Collections needed the same arithmetic for the orders it chases. Two
 * copies of a money calculation is how two screens come to disagree, so there is still exactly one.
 *
 * Pure: no database, no session.
 */
export function computeOrderFinancials(order: {
  quantity: number;
  unitPrice?: unknown;
  item: { sellingPrice: unknown; taxRatePercent: unknown };
  allocations: { amount: unknown }[];
}) {
  const { subtotal, gstAmount, total } = calculateOrderAmount({
    quantity: order.quantity,
    // A punched order's own negotiated price wins over the item's catalog default, if one was set.
    unitPrice: Number(order.unitPrice ?? order.item.sellingPrice),
    taxRatePercent: order.item.taxRatePercent ? Number(order.item.taxRatePercent) : null,
  });
  const paid = order.allocations.reduce((sum, a) => sum + Number(a.amount), 0);
  const balance = Math.round((total - paid) * 100) / 100;
  const status: "unpaid" | "partial" | "paid" = paid <= 0 ? "unpaid" : paid < total ? "partial" : "paid";
  return { subtotal, gstAmount, total, paid, balance, status };
}

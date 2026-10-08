import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { mayAccess } from "@/lib/authz/access";
import { canonicalise, parseRecordRef } from "@/lib/record-url";
import { formatOrderId } from "@/lib/order-id";
import { OrderDetail } from "@/components/orders/order-detail";

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, query, user] = await Promise.all([params, searchParams, requireUser()]);
  const ref = parseRecordRef(id);

  /**
   * `company`, the customer — deliberately not `vendor`, the other company an order points at.
   * The vendor is who we bought the supply from; it says nothing about whose account this is, and
   * scoping by it would hand every rep the orders of whichever vendor they happen to deal with.
   *
   * A renewal is this same record, so this is also the guard on the renewal detail view.
   * The access engine answers it (`mayAccess`, the same fragment the orders list takes).
   */
  const order = await db.companyProduct.findUnique({
    where: ref.kind === "seq" ? { orderSeq: ref.seq } : { id: ref.id },
    select: { id: true, orderSeq: true },
  });
  if (!order || !(await mayAccess(user.id, "orders", "view", order.id))) notFound();

  // After the check, never before — see `canonicalise`.
  canonicalise(id, "/orders", formatOrderId(order.orderSeq), query);

  return <OrderDetail id={order.id} />;
}

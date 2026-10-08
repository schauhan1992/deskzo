import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { canonicalise, parseRecordRef } from "@/lib/record-url";
import { formatOrderId } from "@/lib/order-id";
import { OrderDetail } from "@/components/orders/order-detail";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!(await isModuleEnabled("orders"))) return <ModuleDisabledNotice moduleKey="orders" />;
  const [{ id }, query, user] = await Promise.all([params, searchParams, requireUser()]);
  const ref = parseRecordRef(id);

  /**
   * `company`, the customer — deliberately not `vendor`, the other company an order points at.
   * The vendor is who we bought the supply from; it says nothing about whose account this is, and
   * scoping by it would hand every rep the orders of whichever vendor they happen to deal with.
   *
   * A renewal is this same record, so this is also the guard on the renewal detail view.
   */
  const order = await db.companyProduct.findUnique({
    where: ref.kind === "seq" ? { orderSeq: ref.seq } : { id: ref.id },
    select: { id: true, orderSeq: true, company: { select: { ownerUserId: true } } },
  });
  if (!order || !(await canSeeCompany(user.id, order.company.ownerUserId))) notFound();

  // After the check, never before — see `canonicalise`.
  canonicalise(id, "/orders", formatOrderId(order.orderSeq), query);

  return <OrderDetail id={order.id} />;
}

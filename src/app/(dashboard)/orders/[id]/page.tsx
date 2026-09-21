import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { OrderDetail } from "@/components/orders/order-detail";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, user] = await Promise.all([params, requireUser()]);

  /**
   * `company`, the customer — deliberately not `vendor`, the other company an order points at.
   * The vendor is who we bought the supply from; it says nothing about whose account this is, and
   * scoping by it would hand every rep the orders of whichever vendor they happen to deal with.
   *
   * A renewal is this same record, so this is also the guard on the renewal detail view.
   */
  const order = await db.companyProduct.findUnique({
    where: { id },
    select: { company: { select: { ownerUserId: true } } },
  });
  if (!order || !(await canSeeCompany(user.id, order.company.ownerUserId))) notFound();

  return <OrderDetail id={id} />;
}

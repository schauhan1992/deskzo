import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrder } from "@/actions/order";
import { listVendorOptions } from "@/actions/company";
import { hasEffectivePermission } from "@/actions/permission";
import { isModuleEnabled } from "@/actions/module";
import { currentUser } from "@/lib/session";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { OrderActionsPanel } from "@/components/orders/order-actions-panel";
import { CallButton } from "@/components/calls/call-button";
import { CustomerNoticeButton } from "@/components/marketing/customer-notice-button";
import { canAnnounceFulfilment } from "@/lib/marketing/customer-notices";
import { formatCurrency, formatDate } from "@/lib/utils";
import { formatOrderId } from "@/lib/order-id";
import { calculateOrderAmount, calculateOrderMargin, getPaymentStatus, paymentTermsLabels } from "@/lib/gst";
import { orderExpenseTypeLabels, orderBusinessTypeLabels } from "@/lib/validation/order";
import type { OrderStatus, OrderBusinessType } from "@prisma/client";

const ORDER_STATUS_TONE: Record<OrderStatus, "default" | "green" | "blue" | "red" | "amber"> = {
  PENDING_APPROVAL: "amber",
  APPROVED: "blue",
  REJECTED: "red",
  PROCESSING: "blue",
  FULFILLED: "green",
  CANCELLED: "default",
};

const BUSINESS_TYPE_TONE: Record<OrderBusinessType, "default" | "green" | "blue" | "red" | "amber"> = {
  NEW: "green",
  RENEWAL: "blue",
  NEW_TO_US_RENEWAL: "amber",
  ADDON: "default",
};

/**
 * An order's full detail. Rendered on its own page and again inside the Orders split view.
 */
export async function OrderDetail({
  id,
  showCall = true,
}: {
  id: string;
  /**
   * Set false where the surrounding page already offers a call button, so a screen never shows
   * two of them behaving differently — which is exactly what the renewals split view did.
   */
  showCall?: boolean;
}) {
  const enabled = await isModuleEnabled("orders");
  if (!enabled) {
    return <ModuleDisabledNotice moduleKey="orders" />;
  }

  const sessionUser = await currentUser();
  const userId = sessionUser!.id;
  const [order, vendorOptions, canApprove, canProcess, canRecordPayments, canDeletePayments] = await Promise.all([
    getOrder(id),
    listVendorOptions(),
    hasEffectivePermission(userId, "orders.approve"),
    hasEffectivePermission(userId, "orders.process"),
    hasEffectivePermission(userId, "payments.record"),
    hasEffectivePermission(userId, "payments.delete"),
  ]);
  if (!order) notFound();

  const { subtotal, gstAmount, total } = calculateOrderAmount({
    quantity: order.quantity,
    unitPrice: Number(order.unitPrice ?? order.item.sellingPrice),
    taxRatePercent: order.item.taxRatePercent ? Number(order.item.taxRatePercent) : null,
  });
  const paid = order.allocations.reduce((sum, a) => sum + Number(a.amount), 0);
  const balance = Math.round((total - paid) * 100) / 100;
  const paymentStatus = getPaymentStatus(total, paid);

  const totalExpenses = order.expenses.reduce((sum, e) => sum + Number(e.amount), 0);
  const margin = calculateOrderMargin({
    quantity: order.quantity,
    unitPrice: order.unitPrice !== null ? Number(order.unitPrice) : Number(order.item.sellingPrice),
    purchasePrice: order.purchasePrice !== null ? Number(order.purchasePrice) : null,
    totalExpenses,
  });

  const viaReseller = order.company.relationshipType === "RESELLER";

  return (
    <div className="@container space-y-6">
      {viaReseller && (
        <div className="rounded-md border border-info bg-info-bg px-4 py-3 text-sm text-info">
          <span className="font-medium">Reseller order.</span> Placed by{" "}
          <Link href={`/companies/${order.company.id}`} className="font-medium underline">
            {order.company.name}
          </Link>
          {order.endCustomer ? (
            <>
              {" "}
              for their customer{" "}
              <Link href={`/companies/${order.endCustomer.id}`} className="font-medium underline">
                {order.endCustomer.name}
              </Link>
              . Deal with the reseller only — don&apos;t contact the end customer directly.
            </>
          ) : (
            <> — invoice and chase payment from them, not an end customer.</>
          )}
        </div>
      )}

      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold text-text">{formatOrderId(order.orderSeq)}</h1>
            {viaReseller && <Badge tone="blue">Via reseller</Badge>}
            <Badge tone={ORDER_STATUS_TONE[order.orderStatus]}>{order.orderStatus.replaceAll("_", " ")}</Badge>
            <Badge tone={BUSINESS_TYPE_TONE[order.businessType]}>{orderBusinessTypeLabels[order.businessType]}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted">
            <Link href={`/companies/${order.company.id}`} className="hover:underline">
              {order.company.name}
            </Link>
            {" · "}
            {order.item.name} × {order.quantity}
            {order.item.unit ? ` ${order.item.unit}` : ""}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 @3xl:grid-cols-3">
        <div className="space-y-6 @3xl:col-span-2">
          <Card>
            <CardHeader className="text-sm font-medium text-text">Order details</CardHeader>
            <CardContent className="grid grid-cols-1 gap-x-6 gap-y-2 @lg:grid-cols-2 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Location</span>
                <span className="text-text">{order.location.label}</span>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Customer PO / invoice #</span>
                <span className="text-text">{order.poNumber ?? "—"}</span>
              </div>
              {viaReseller && (
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-muted">End customer</span>
                  <span className="text-text">
                    {order.endCustomer ? (
                      <Link href={`/companies/${order.endCustomer.id}`} className="hover:underline">
                        {order.endCustomer.name}
                      </Link>
                    ) : (
                      "Not specified"
                    )}
                  </span>
                </div>
              )}
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Payment terms</span>
                <span className="text-text">{paymentTermsLabels[order.paymentTerms ?? order.company.paymentTerms]}</span>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Proposal</span>
                <span className="text-text">{order.proposal ? order.proposal.status : "—"}</span>
              </div>
              {(order.startDate || order.endDate) && (
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-muted">Subscription period</span>
                  <span className="text-text">
                    {formatDate(order.startDate)} – {formatDate(order.endDate)}
                  </span>
                </div>
              )}
              {order.notes && (
                <div className="col-span-2 border-t border-line pt-2 text-text">{order.notes}</div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="text-sm font-medium text-text">Vendor & purchasing</CardHeader>
            <CardContent className="grid grid-cols-1 gap-x-6 gap-y-2 @lg:grid-cols-2 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Vendor</span>
                <span className="text-text">
                  {order.vendor ? (
                    <Link href={`/companies/${order.vendor.id}`} className="hover:underline">
                      {order.vendor.name}
                    </Link>
                  ) : (
                    "Not set yet"
                  )}
                </span>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Our PO to vendor</span>
                <span className="text-text">{order.ourPoNumber ?? "—"}</span>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Purchase price / unit</span>
                <span className="text-text">{order.purchasePrice !== null ? formatCurrency(String(order.purchasePrice)) : "—"}</span>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Purchased by</span>
                <span className="text-text">{order.purchasedBy?.name ?? "—"}</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="text-sm font-medium text-text">Financials</CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="grid grid-cols-1 gap-x-6 gap-y-2 @lg:grid-cols-2">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-muted">Sale price / unit</span>
                  <span className="text-text">{formatCurrency(String(order.unitPrice ?? order.item.sellingPrice))}</span>
                </div>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-muted">Subtotal</span>
                  <span className="text-text">{formatCurrency(String(subtotal))}</span>
                </div>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-muted">GST</span>
                  <span className="text-text">{formatCurrency(String(gstAmount))}</span>
                </div>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-muted">Total</span>
                  <span className="font-medium text-text">{formatCurrency(String(total))}</span>
                </div>
              </div>
              <div className="flex items-center justify-between border-t border-line pt-3">
                <Badge tone={paymentStatus.tone}>{paymentStatus.label}</Badge>
                <span className="text-muted">
                  Paid {formatCurrency(String(paid))}
                  {balance > 0 ? ` · Due ${formatCurrency(String(balance))}` : ""}
                </span>
              </div>
              <div className="border-t border-line pt-3">
                <div className="flex justify-between text-muted">
                  <span>Margin</span>
                  {margin ? (
                    <span className={margin.margin >= 0 ? "font-medium text-success" : "font-medium text-danger"}>
                      {formatCurrency(String(margin.margin))} ({margin.marginPercent}%)
                    </span>
                  ) : (
                    <span className="text-subtle">Set purchase price to see margin</span>
                  )}
                </div>
                {totalExpenses > 0 && (
                  <p className="mt-1 text-xs text-subtle">Includes {formatCurrency(String(totalExpenses))} in expenses.</p>
                )}
              </div>
            </CardContent>
          </Card>

          {order.expenses.length > 0 && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">Expenses</CardHeader>
              <CardContent className="space-y-2 text-sm">
                {order.expenses.map((e) => (
                  <div key={e.id} className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-muted">
                      {orderExpenseTypeLabels[e.type]}
                      {e.payee ? ` — paid to ${e.payee.name}` : ""}
                      {e.payeeAccount ? ` (${e.payeeAccount.label})` : ""}
                      {e.notes ? ` — ${e.notes}` : ""}
                    </span>
                    <span className="text-text">{formatCurrency(String(e.amount))}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader className="flex items-center justify-between text-sm font-medium text-text">
              <span>Actions</span>
              <span className="flex items-center gap-1">
                {showCall && (
                  <CallButton
                    companyId={order.company.id}
                    companyName={order.company.name}
                    companyProductId={order.id}
                    size="sm"
                  />
                )}
                {/* Appears the moment the order is fulfilled, and not a step before. */}
                {canAnnounceFulfilment(order.orderStatus) && (
                  <CustomerNoticeButton
                    companyProductId={order.id}
                    companyName={order.company.name}
                    kind="FULFILMENT"
                  />
                )}
              </span>
            </CardHeader>
            <CardContent>
              <OrderActionsPanel
                order={{
                  id: order.id,
                  orderSeq: order.orderSeq,
                  quantity: order.quantity,
                  unitPrice: order.unitPrice,
                  item: { name: order.item.name, sellingPrice: order.item.sellingPrice, taxRatePercent: order.item.taxRatePercent },
                  allocations: order.allocations,
                  orderStatus: order.orderStatus,
                  vendorId: order.vendor?.id ?? null,
                  purchasePrice: order.purchasePrice,
                  ourPoNumber: order.ourPoNumber,
                  addedByUserId: order.addedBy.id,
                }}
                currentUserId={userId}
                canApprove={canApprove}
                canProcess={canProcess}
                canRecordPayments={canRecordPayments}
                canDeletePayments={canDeletePayments}
                vendorOptions={vendorOptions}
                companyId={order.company.id}
                companyName={order.company.name}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="text-sm font-medium text-text">Timeline</CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Punched by</span>
                <span className="text-text">{order.addedBy.name}</span>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Created on</span>
                <span className="text-text">{formatDate(order.createdAt)}</span>
              </div>
              {order.accountsApprovedBy && (
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-muted">Reviewed by</span>
                  <span className="text-text">
                    {order.accountsApprovedBy.name} · {formatDate(order.accountsApprovedAt)}
                  </span>
                </div>
              )}
              {order.accountsNotes && <p className="border-t border-line pt-2 text-text">{order.accountsNotes}</p>}
              {order.fulfilledAt && (
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-muted">Fulfilled on</span>
                  <span className="text-text">{formatDate(order.fulfilledAt)}</span>
                </div>
              )}
            </CardContent>
          </Card>

          {order.watchers.length > 0 && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">Watchers</CardHeader>
              <CardContent className="space-y-1 text-sm">
                {order.watchers.map((w) => (
                  <div key={w.id} className="text-text">
                    {w.name}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

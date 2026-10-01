import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrder } from "@/actions/order";
import { listVendorOptions } from "@/actions/company";
import { hasEffectivePermission, viewerHas } from "@/actions/permission";
import { orderCreditPosition } from "@/lib/credit/order";
import { isModuleEnabled } from "@/actions/module";
import { currentUser } from "@/lib/session";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { OrderActionsPanel } from "@/components/orders/order-actions-panel";
import { OrderHandoffPanel, OrderPriceReview, OrderQuoteEditor, VendorPoSettle } from "@/components/orders/order-handoff-controls";
import { CallButton } from "@/components/calls/call-button";
import { CustomerNoticeButton } from "@/components/marketing/customer-notice-button";
import { canAnnounceFulfilment } from "@/lib/marketing/customer-notices";
import { formatCurrency, formatDate } from "@/lib/utils";
import { formatOrderId } from "@/lib/order-id";
import { calculateOrderAmount, calculateOrderMargin, getPaymentStatus, paymentTermsLabels } from "@/lib/gst";
import { orderExpenseTypeLabels, orderBusinessTypeLabels } from "@/lib/validation/order";
import { handoffBadge, impliedMargin, priceCeiling, priceEventLabels, vendorPoLabels } from "@/lib/orders/handoff-rules";
import { formatIstDate, formatIstDateTime } from "@/lib/india-time";
import type { OrderStatus, OrderBusinessType } from "@prisma/client";
import { CategoryChip } from "@/components/customers/category-chip";
import { followUpPanel } from "@/actions/collections";
import { getOrderRebates } from "@/actions/rebate";
import { OrderDealEditor, OrderLossApproval, OrderRebatesPanel } from "@/components/orders/order-rebates";
import { COST_SOURCE_LABELS, DEAL_REG_LABELS, needsLossApproval, unitCostOf, type DealRegStatusKey } from "@/lib/rebates/rules";
import { FollowUpPanel } from "@/components/collections/follow-up-panel";

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
  const [order, vendorOptions, canApprove, canProcess, canRecordPayments, canDeletePayments, canSeeRebates, canApproveLoss] = await Promise.all([
    getOrder(id),
    listVendorOptions(),
    hasEffectivePermission(userId, "orders.approve"),
    hasEffectivePermission(userId, "orders.process"),
    hasEffectivePermission(userId, "payments.record"),
    hasEffectivePermission(userId, "payments.delete"),
    hasEffectivePermission(userId, "rebates.view"),
    hasEffectivePermission(userId, "orders.approveLoss"),
  ]);
  if (!order) notFound();

  /**
   * Where the order stands on credit, while it waits for approval — computed by the same function
   * `approveOrder` enforces with, so what the approver reads is what the action will decide. Shown
   * to anyone who can see the customer's money; the override itself is only offered to approvers.
   */
  const position =
    order.orderStatus === "PENDING_APPROVAL" && (await viewerHas("payments.view")) ? await orderCreditPosition(order.id) : null;
  const credit = position
    ? {
        rating: position.assessment.rating,
        score: position.assessment.score,
        recommendedTerms: position.assessment.recommendedTerms,
        terms: position.terms,
        limit: position.assessment.limit,
        outstanding: position.assessment.outstanding,
        overdue: position.assessment.overdue,
        concerns: position.concerns.map((c) => c.text),
        termsDecided: position.termsDecided,
        canOverride: await viewerHas("credit.override"),
      }
    : null;

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

  // ── The hand-off to purchase, the distributor price, and any price waiting for sales ──────────────
  const now = new Date();
  const closed = order.orderStatus === "CANCELLED" || order.orderStatus === "REJECTED" || order.orderStatus === "FULFILLED";
  const handoffNote = closed ? null : handoffBadge(order, now);
  /** The salesperson who punched it, or an approver: who decides when it goes and what it may cost. */
  const speaksForSales = order.addedBy.id === userId || canApprove;
  const quotePrice = order.quotedPurchasePrice;
  const ceiling = priceCeiling(
    { quotedPurchasePrice: quotePrice, quotedById: order.quotedBy?.id ?? null, orderStatus: order.orderStatus, purchasePrice: order.purchasePrice },
    userId,
  );
  const pending =
    order.pendingPurchasePrice !== null
      ? {
          price: order.pendingPurchasePrice,
          ceiling: priceCeiling(
            { quotedPurchasePrice: quotePrice, quotedById: order.quotedBy?.id ?? null, orderStatus: order.orderStatus, purchasePrice: order.purchasePrice },
            order.priceReviewRequestedBy?.id ?? "",
          ),
          quantity: order.quantity,
          vendorName: order.pendingVendor?.name ?? null,
          reason: order.priceIncreaseReason ?? "",
          requestedBy: order.priceReviewRequestedBy?.name ?? null,
          requestedAt: order.priceReviewRequestedAt ?? now,
        }
      : null;
  const quoteEditable =
    speaksForSales && (order.orderStatus === "PENDING_APPROVAL" || order.orderStatus === "APPROVED") && !pending;
  const salePrice = Number(order.unitPrice ?? order.item.sellingPrice);
  const quoteMargin = quotePrice !== null ? impliedMargin(salePrice, quotePrice, order.quantity) : null;
  const saving = order.purchaseSaving;

  // ── The deal registration, selling below cost, and backend rebates (owner, 1 Oct 2026) ────────────
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const rebates = canSeeRebates ? await getOrderRebates(order.id) : null;
  /** The cost the order would go on at now: a higher price waiting for sales, else the best known. */
  // The highest in play: what somebody was stopped at for selling below cost, a higher price waiting
  // for sales, or the best known.
  const known = unitCostOf({ purchasePrice: num(order.purchasePrice), dealPrice: num(order.dealPrice), quotedPurchasePrice: num(quotePrice) });
  const costNow =
    [
      ...(known ? [{ cost: known.cost, label: COST_SOURCE_LABELS[known.from] }] : []),
      ...(order.pendingPurchasePrice !== null ? [{ cost: Number(order.pendingPurchasePrice), label: "the higher price purchase asked for" }] : []),
      ...(order.lossRequestedCost !== null ? [{ cost: Number(order.lossRequestedCost), label: "the price somebody was stopped at" }] : []),
    ].sort((a, b) => b.cost - a.cost)[0] ?? null;
  const awaitingLossApproval =
    !closed && costNow !== null && needsLossApproval({ unitPrice: salePrice, unitCost: costNow.cost, lossApprovedCost: num(order.lossApprovedCost) });
  const mayApproveLoss = canApproveLoss && order.addedBy.id !== userId;
  const dealEditable = !closed && (speaksForSales || canProcess);
  const hasDeal = !!order.dealRegStatus || order.dealPrice !== null;

  // Collections: what has been said to the customer about paying for this order, and any promise —
  // Receivables' own, so only where it is on for this viewer (and null outside the account's money).
  const followUps = (await isModuleEnabled("receivables")) ? await followUpPanel({ companyProductId: order.id }) : null;

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
            {handoffNote && <Badge tone="amber">{handoffNote}</Badge>}
            {pending && <Badge tone="amber">Waiting for sales approval</Badge>}
            {order.vendorPoCancel && <Badge tone={order.vendorPoCancel === "PENDING" ? "red" : "default"}>{vendorPoLabels[order.vendorPoCancel]}</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted">
            <Link href={`/companies/${order.company.id}`} className="hover:underline">
              {order.company.name}
            </Link>
            <CategoryChip category={order.company.customerCategory} className="ml-1.5 align-middle" />
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
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Hand-off</span>
                <span className="text-text">
                  {order.purchaseRelease === "RELEASED"
                    ? order.releasedAt
                      ? `With purchase since ${formatIstDate(order.releasedAt)}`
                      : "With purchase"
                    : (handoffNote ?? "Never sent to purchase")}
                </span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex items-center justify-between text-sm font-medium text-text">
              <span>Distributor price</span>
              {quoteEditable && (
                <OrderQuoteEditor
                  orderId={order.id}
                  vendors={vendorOptions.map((v) => ({ id: v.id, name: v.name }))}
                  quote={{
                    price: quotePrice,
                    vendorId: order.quoteVendor?.id ?? null,
                    vendorName: order.quoteVendorName,
                    contact: order.quoteContact,
                    quotedOn: order.quotedOn,
                    remarks: order.quoteRemarks,
                  }}
                />
              )}
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {quotePrice === null ? (
                <p className="text-subtle">
                  No price from sales. Purchase buys as usual, and no saving is recorded against this order.
                </p>
              ) : (
                <>
                  <div className="grid grid-cols-1 gap-x-6 gap-y-2 @lg:grid-cols-2">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className="text-muted">Price / unit</span>
                      <span className="font-medium text-text">{formatCurrency(String(quotePrice))}</span>
                    </div>
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className="text-muted">Distributor</span>
                      <span className="text-text">
                        {order.quoteVendor ? (
                          <Link href={`/companies/${order.quoteVendor.id}`} className="hover:underline">
                            {order.quoteVendor.name}
                          </Link>
                        ) : (
                          (order.quoteVendorName ?? "—")
                        )}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className="text-muted">Contact there</span>
                      <span className="text-text">{order.quoteContact ?? "—"}</span>
                    </div>
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className="text-muted">Quoted on</span>
                      <span className="text-text">{order.quotedOn ? formatIstDate(order.quotedOn) : "—"}</span>
                    </div>
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className="text-muted">Entered by</span>
                      <span className="text-text">{order.quotedBy?.name ?? "—"}</span>
                    </div>
                    {quoteMargin && (
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <span className="text-muted">Margin at this price</span>
                        <span className={quoteMargin.margin >= 0 ? "text-success" : "text-danger"}>
                          {formatCurrency(String(quoteMargin.margin))}
                          {quoteMargin.percent !== null ? ` (${quoteMargin.percent}%)` : ""}
                        </span>
                      </div>
                    )}
                  </div>
                  {order.quoteRemarks && <p className="border-t border-line pt-2 text-text">{order.quoteRemarks}</p>}
                </>
              )}
              {saving && (
                <div
                  className={`flex flex-wrap items-baseline justify-between gap-x-3 border-t border-line pt-2 ${saving.cancelledAt ? "text-subtle line-through" : ""}`}
                >
                  <span className="text-muted">{saving.amount >= 0 ? "Purchase saving" : "Accepted increase"}</span>
                  <span className={saving.cancelledAt ? "" : saving.amount >= 0 ? "font-medium text-success" : "font-medium text-danger"}>
                    {formatCurrency(String(saving.amount))} · {saving.purchaser.name} · {formatIstDate(saving.recordedOn)}
                  </span>
                </div>
              )}
              {saving?.cancelledAt && <p className="text-xs text-subtle">The order was cancelled, so this doesn&apos;t count.</p>}
            </CardContent>
          </Card>

          {awaitingLossApproval && costNow && (
            <Card className="border-danger">
              <CardHeader className="text-sm font-medium text-danger">Sold below cost — needs a manager&apos;s approval</CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p className="text-text">
                  It sells at {formatCurrency(String(salePrice))} a unit against {formatCurrency(String(costNow.cost))} —{" "}
                  {costNow.label}: {formatCurrency(String(Math.round((costNow.cost - salePrice) * order.quantity * 100) / 100))} under
                  cost on {order.quantity} unit{order.quantity === 1 ? "" : "s"}. A negative call goes ahead only once somebody holding
                  &ldquo;Approve orders sold below cost&rdquo; approves it, whatever rebate is expected.
                </p>
                {rebates && rebates.rebates.length > 0 && (
                  <p className="text-muted">
                    Backend rebates expected: {formatCurrency(String(rebates.totals.expected))}
                    {rebates.net !== null ? ` · net margin after them ${formatCurrency(String(rebates.net))}` : ""}
                  </p>
                )}
                {mayApproveLoss ? (
                  <OrderLossApproval orderId={order.id} />
                ) : (
                  <p className="text-xs text-subtle">
                    {canApproveLoss ? "You punched it, so somebody else approves it." : "The managers who can approve it are told when purchase tries to buy it."}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="flex items-center justify-between text-sm font-medium text-text">
              <span>Deal registration</span>
              {dealEditable && (
                <OrderDealEditor
                  orderId={order.id}
                  deal={{
                    status: (order.dealRegStatus ?? null) as DealRegStatusKey | null,
                    number: order.dealRegNumber,
                    validTo: order.dealRegValidTo,
                    price: num(order.dealPrice),
                  }}
                />
              )}
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {!hasDeal ? (
                <p className="text-muted">None recorded.</p>
              ) : (
                <>
                  {order.dealRegStatus && (
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className="text-muted">Deal registration</span>
                      <span className="text-text">
                        <Badge tone={order.dealRegStatus === "APPROVED" ? "green" : order.dealRegStatus === "REJECTED" ? "red" : "amber"}>
                          {DEAL_REG_LABELS[order.dealRegStatus as DealRegStatusKey]}
                        </Badge>
                        {order.dealRegNumber ? <span className="ml-2">{order.dealRegNumber}</span> : null}
                      </span>
                    </div>
                  )}
                  {order.dealRegValidTo && (
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className="text-muted">Valid until</span>
                      <span className="text-text">{formatIstDate(order.dealRegValidTo)}</span>
                    </div>
                  )}
                  {order.dealPrice !== null && (
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className="text-muted">Deal price / unit</span>
                      <span className="text-text">{formatCurrency(String(order.dealPrice))}</span>
                    </div>
                  )}
                  {order.dealPrice !== null && order.purchasePrice !== null && Number(order.purchasePrice) > Number(order.dealPrice) && (
                    <p className="text-xs text-warning">
                      Bought at {formatCurrency(String(order.purchasePrice))} — above the deal price. Check the distributor applied it.
                    </p>
                  )}
                </>
              )}
              {order.lossApprovedAt && (
                <p className="border-t border-line pt-2 text-xs text-muted">
                  Selling below cost approved by {order.lossApprovedBy?.name ?? "a manager"} on {formatIstDate(order.lossApprovedAt)}, at{" "}
                  {formatCurrency(String(order.lossApprovedCost))} a unit{order.lossApprovalNote ? `: “${order.lossApprovalNote}”` : ""}
                </p>
              )}
            </CardContent>
          </Card>

          {rebates && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">Backend rebates</CardHeader>
              <CardContent>
                <OrderRebatesPanel
                  orderId={order.id}
                  summary={rebates}
                  vendors={vendorOptions.map((v) => ({ id: v.id, name: v.name }))}
                  defaultPayerId={order.vendor?.id ?? order.quoteVendor?.id ?? null}
                  canEdit={!closed || order.orderStatus === "FULFILLED"}
                  canManage={rebates.canManage}
                />
              </CardContent>
            </Card>
          )}

          {order.priceChanges.length > 0 && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">Price history</CardHeader>
              <CardContent>
                <ol className="space-y-3 text-sm">
                  {order.priceChanges.map((c) => (
                    <li key={c.id} className="border-l-2 border-line pl-3">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <span className="font-medium text-text">{priceEventLabels[c.event]}</span>
                        <span className="text-xs text-muted">{formatIstDateTime(c.at)}</span>
                      </div>
                      <p className="text-muted">
                        {c.fromPrice !== null && c.toPrice !== null
                          ? `${formatCurrency(String(c.fromPrice))} → ${formatCurrency(String(c.toPrice))}`
                          : c.toPrice !== null
                            ? formatCurrency(String(c.toPrice))
                            : c.fromPrice !== null
                              ? `${formatCurrency(String(c.fromPrice))} removed`
                              : ""}
                        {c.vendorName ? ` · ${c.vendorName}` : ""}
                        {c.byUser ? ` · by ${c.byUser.name}` : ""}
                      </p>
                      {c.reason && <p className="text-text">&ldquo;{c.reason}&rdquo;</p>}
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          )}

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
                {rebates && rebates.rebates.length > 0 && (
                  <>
                    <div className="mt-2 flex justify-between text-muted">
                      <span>Backend rebates</span>
                      <span className="text-text">+{formatCurrency(String(rebates.totals.expected))}</span>
                    </div>
                    <div className="mt-1 flex justify-between text-muted">
                      <span>Net margin</span>
                      {rebates.net !== null ? (
                        <span className={rebates.net >= 0 ? "font-medium text-success" : "font-medium text-danger"}>{formatCurrency(String(rebates.net))}</span>
                      ) : (
                        <span className="text-subtle">Once the cost is known</span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-subtle">Targets and incentives count the margin before rebates.</p>
                  </>
                )}
              </div>
            </CardContent>
          </Card>

          {followUps && (followUps.history.length > 0 || followUps.canLog) && <FollowUpPanel panel={followUps} />}

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
            <CardContent className="space-y-4">
              {speaksForSales && !closed && order.purchaseRelease !== "RELEASED" && (
                <OrderHandoffPanel orderId={order.id} purchaseRelease={order.purchaseRelease} releaseOn={order.releaseOn} />
              )}
              {pending && !closed && (
                <OrderPriceReview
                  orderId={order.id}
                  pending={pending}
                  canDecide={speaksForSales && order.priceReviewRequestedBy?.id !== userId}
                />
              )}
              {order.vendorPoCancel === "PENDING" && canProcess && <VendorPoSettle orderId={order.id} />}
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
                credit={credit}
                purchase={{
                  purchaseRelease: order.purchaseRelease,
                  releaseOn: order.releaseOn,
                  priceCeiling: ceiling,
                  quotePrice,
                  pendingIncrease: !!pending,
                  paid,
                  vendorName: order.vendor?.name ?? null,
                }}
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
              {order.accountsNotes && !order.cancelledAt && <p className="border-t border-line pt-2 text-text">{order.accountsNotes}</p>}
              {order.releasedAt && (
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-muted">Sent to purchase</span>
                  <span className="text-text">
                    {order.releasedBy ? `${order.releasedBy.name} · ` : "On its scheduled day · "}
                    {formatIstDate(order.releasedAt)}
                  </span>
                </div>
              )}
              {order.fulfilledAt && (
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-muted">Fulfilled on</span>
                  <span className="text-text">{formatDate(order.fulfilledAt)}</span>
                </div>
              )}
              {order.cancelledAt && (
                <div className="space-y-1 border-t border-line pt-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-muted">Cancelled</span>
                    <span className="text-text">
                      {order.cancelledBy?.name ?? "—"} · {formatIstDateTime(order.cancelledAt)}
                    </span>
                  </div>
                  {order.cancelReason && <p className="text-text">&ldquo;{order.cancelReason}&rdquo;</p>}
                  {order.vendorPoCancel && (
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className="text-muted">{vendorPoLabels[order.vendorPoCancel]}</span>
                      <span className="text-text">
                        {order.vendorPoSettledAt
                          ? `${order.vendorPoSettledBy?.name ?? "—"} · ${formatIstDate(order.vendorPoSettledAt)}`
                          : "Waiting for purchase"}
                      </span>
                    </div>
                  )}
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

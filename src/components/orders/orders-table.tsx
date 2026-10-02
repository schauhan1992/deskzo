"use client";

import Link from "next/link";
import type { OrderStatus, OrderBusinessType, CompanyRelationshipType } from "@prisma/client";
import { orderBusinessTypeLabels } from "@/lib/validation/order";
import { calculateOrderAmount } from "@/lib/gst";
import { formatOrderId } from "@/lib/order-id";
import { CustomerNoticeButton } from "@/components/marketing/customer-notice-button";
import { canAnnounceFulfilment } from "@/lib/marketing/customer-notices";
import { formatCurrency } from "@/lib/utils";
import { Badge, Card } from "@/components/ui/card";
import { useColumns } from "@/components/ui/table-columns";
import { CustomFieldBodyCells, CustomFieldHeaderCells, type CustomColumn } from "@/components/custom-fields/custom-field-cells";
import { handoffBadge, vendorPoLabels, type ReleaseState } from "@/lib/orders/handoff-rules";
import type { StageColor } from "@/lib/pipeline/rules";

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

type OrderRow = {
  id: string;
  orderSeq: number;
  /** The workspace's own step it is at within its status (src/lib/pipeline/order-steps.ts), if any. */
  step?: { label: string; color: StageColor } | null;
  quantity: number;
  unitPrice: number | null;
  orderStatus: OrderStatus;
  businessType: OrderBusinessType;
  company: { id: string; name: string; relationshipType: CompanyRelationshipType };
  endCustomer: { id: string; name: string } | null;
  item: { id: string; name: string; unit: string | null; sellingPrice: number; taxRatePercent: number | null };
  vendor: { id: string; name: string } | null;
  addedBy: { id: string; name: string };
  purchaseRelease: ReleaseState;
  releaseOn: Date | string | null;
  pendingPurchasePrice: number | null;
  vendorPoCancel: "PENDING" | "CANCELLED" | "NOT_NEEDED" | null;
};

/**
 * What an order is waiting on besides its status: sales holding it back from purchase, a higher price
 * waiting for sales, or a cancelled order's vendor PO. Shared with the split list.
 */
export function orderFlags(o: Pick<OrderRow, "orderStatus" | "purchaseRelease" | "releaseOn" | "pendingPurchasePrice" | "vendorPoCancel">): string[] {
  const flags: string[] = [];
  const open = o.orderStatus !== "CANCELLED" && o.orderStatus !== "REJECTED" && o.orderStatus !== "FULFILLED";
  const handoff = open ? handoffBadge(o) : null;
  if (handoff) flags.push(handoff);
  if (open && o.pendingPurchasePrice !== null) flags.push("Waiting for sales approval");
  if (o.vendorPoCancel === "PENDING") flags.push(vendorPoLabels.PENDING);
  return flags;
}

/**
 * Deliberately has no row selection or bulk actions. An order moves through approval one at a time
 * because each step is a judgement about that specific order — accounts weighs its payment terms,
 * purchasing sources its vendor and cost. Approving a screenful at once would turn a review into a
 * rubber stamp, so the workflow stays on the order's own page.
 */
export function OrdersTable({
  orders,
  stepsOn = false,
  customColumns = { columns: [], texts: {} },
}: {
  orders: OrderRow[];
  /** The workspace has order steps (Settings → Pipeline): only then is there a Step column to show. */
  stepsOn?: boolean;
  /**
   * The workspace's own fields this person may see (src/lib/custom-fields/server.ts `listColumns`):
   * the ones they show in the column picker, or each field's default.
   */
  customColumns?: { columns: CustomColumn[]; texts: Record<string, Record<string, string>> };
}) {
  const cols = useColumns("orders");
  // The fields this person shows, worked out once: the header and every row draw this one list.
  const fieldColumns = customColumns.columns.filter((c) => cols.showCustom(c.key, c.default));
  // The Step column counts as shown by the picker even where there are no steps to show in it.
  const hiddenStep = !stepsOn && cols.show("step");
  const span = cols.count - Number(hiddenStep) + fieldColumns.length;
  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full text-sm">
        <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            {cols.show("order") && <th className="px-4 py-2.5">Order</th>}
            {cols.show("status") && <th className="px-4 py-2.5">Status</th>}
            {stepsOn && cols.show("step") && <th className="px-4 py-2.5">Step</th>}
            {cols.show("type") && <th className="px-4 py-2.5">Type</th>}
            {cols.show("customer") && <th className="px-4 py-2.5">Customer</th>}
            {cols.show("product") && <th className="px-4 py-2.5">Product</th>}
            {cols.show("qty") && <th className="px-4 py-2.5">Qty</th>}
            {cols.show("total") && <th className="px-4 py-2.5">Total</th>}
            {cols.show("vendor") && <th className="px-4 py-2.5">Vendor</th>}
            {cols.show("addedBy") && <th className="px-4 py-2.5">Added by</th>}
            {cols.show("actions") && <th className="px-4 py-2.5 text-right">Tell them</th>}
            <CustomFieldHeaderCells columns={fieldColumns} className="px-4 py-2.5" />
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => {
            const { total } = calculateOrderAmount({
              quantity: o.quantity,
              unitPrice: Number(o.unitPrice ?? o.item.sellingPrice),
              taxRatePercent: o.item.taxRatePercent ? Number(o.item.taxRatePercent) : null,
            });
            return (
              <tr key={o.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                {cols.show("order") && (
                  <td className="px-4 py-2.5 font-mono text-xs">
                    <Link href={`/orders/${o.id}`} className="text-text hover:underline">
                      {formatOrderId(o.orderSeq)}
                    </Link>
                  </td>
                )}
                {cols.show("status") && (
                  <td className="px-4 py-2.5">
                    <Badge tone={ORDER_STATUS_TONE[o.orderStatus]}>{o.orderStatus.replaceAll("_", " ")}</Badge>
                    {orderFlags(o).map((flag) => (
                      <div key={flag} className="mt-1">
                        <Badge tone={flag === vendorPoLabels.PENDING ? "red" : "amber"}>{flag}</Badge>
                      </div>
                    ))}
                  </td>
                )}
                {stepsOn && cols.show("step") && (
                  <td className="px-4 py-2.5">{o.step ? <Badge tone={o.step.color}>{o.step.label}</Badge> : <span className="text-subtle">—</span>}</td>
                )}
                {cols.show("type") && (
                  <td className="px-4 py-2.5">
                    <Badge tone={BUSINESS_TYPE_TONE[o.businessType]}>{orderBusinessTypeLabels[o.businessType]}</Badge>
                  </td>
                )}
                {cols.show("customer") && (
                  <td className="px-4 py-2.5">
                    <Link href={`/companies/${o.company.id}`} className="text-text hover:underline">
                      {o.company.name}
                    </Link>
                    {o.company.relationshipType === "RESELLER" && (
                      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-info">
                        <Badge tone="blue">Reseller</Badge>
                        {o.endCustomer && <span className="text-muted">for {o.endCustomer.name}</span>}
                      </div>
                    )}
                  </td>
                )}
                {cols.show("product") && (
                  <td className="px-4 py-2.5 text-muted">{o.item.name}</td>
                )}
                {cols.show("qty") && (
                  <td className="px-4 py-2.5 text-muted">
                    {o.quantity}
                    {o.item.unit ? ` ${o.item.unit}` : ""}
                  </td>
                )}
                {cols.show("total") && (
                  <td className="px-4 py-2.5 font-medium text-text">{formatCurrency(total)}</td>
                )}
                {cols.show("vendor") && (
                  <td className="px-4 py-2.5 text-muted">{o.vendor?.name ?? "—"}</td>
                )}
                {cols.show("addedBy") && (
                  <td className="px-4 py-2.5 text-muted">{o.addedBy.name}</td>
                )}
                {cols.show("actions") && (
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end">
                      {/* Only once it is actually fulfilled. "Your order is ready" sent while
                          purchasing is still sourcing it invites a delivery query nobody can
                          answer, and cannot be taken back. */}
                      {canAnnounceFulfilment(o.orderStatus) && (
                        <CustomerNoticeButton
                          companyProductId={o.id}
                          companyName={o.company.name}
                          kind="FULFILMENT"
                        />
                      )}
                    </div>
                  </td>
                )}
                <CustomFieldBodyCells columns={fieldColumns} texts={customColumns.texts[o.id]} className="px-4 py-2.5 text-muted" />
              </tr>
            );
          })}
          {orders.length === 0 && (
            <tr>
              <td colSpan={span} className="px-4 py-8 text-center text-subtle">
                No orders found.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Card>
  );
}

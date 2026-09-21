"use client";

import { usePathname, useSearchParams } from "next/navigation";
import type { OrderStatus, OrderBusinessType, CompanyRelationshipType } from "@prisma/client";
import { Badge } from "@/components/ui/card";
import { SplitRow } from "@/components/ui/split-list";
import { SELECTED_PARAM } from "@/lib/view-mode";
import { calculateOrderAmount } from "@/lib/gst";
import { formatOrderId } from "@/lib/order-id";
import { formatCurrency } from "@/lib/utils";
import { orderBusinessTypeLabels } from "@/lib/validation/order";

const ORDER_STATUS_TONE: Record<OrderStatus, "default" | "green" | "blue" | "red" | "amber"> = {
  PENDING_APPROVAL: "amber",
  APPROVED: "blue",
  REJECTED: "red",
  PROCESSING: "blue",
  FULFILLED: "green",
  CANCELLED: "default",
};

type OrderRow = {
  id: string;
  orderSeq: number;
  quantity: number;
  unitPrice: number | null;
  orderStatus: OrderStatus;
  businessType: OrderBusinessType;
  company: { id: string; name: string; relationshipType: CompanyRelationshipType };
  endCustomer: { id: string; name: string } | null;
  item: { id: string; name: string; unit: string | null; sellingPrice: number; taxRatePercent: number | null };
};

/**
 * The narrow pane beside an open order. It leads with what was ordered rather than the order id,
 * because that's what people recognise — the id is the thing you quote back afterwards.
 *
 * A reseller order names the end customer too: the order belongs to the reseller, but the question
 * being asked of it is usually about who it's ultimately for.
 */
export function OrderSplitList({ orders, selectedId }: { orders: OrderRow[]; selectedId: string | null }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function hrefFor(id: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(SELECTED_PARAM, id);
    return `${pathname}?${params.toString()}`;
  }

  return (
    <div className="divide-y divide-line">
      {orders.map((order) => {
        const amount = calculateOrderAmount({
          quantity: order.quantity,
          unitPrice: order.unitPrice ?? order.item.sellingPrice,
          taxRatePercent: order.item.taxRatePercent,
        });
        return (
          <SplitRow
            key={order.id}
            href={hrefFor(order.id)}
            active={order.id === selectedId}
            title={order.item.name}
            trailing={formatCurrency(amount.total)}
            subtitle={
              order.endCustomer
                ? `${order.company.name} → ${order.endCustomer.name}`
                : order.company.name
            }
            badges={
              <>
                <span className="font-mono text-xs text-subtle">{formatOrderId(order.orderSeq)}</span>
                <Badge tone={ORDER_STATUS_TONE[order.orderStatus]}>
                  {order.orderStatus.replaceAll("_", " ")}
                </Badge>
                <span className="text-xs text-subtle">{orderBusinessTypeLabels[order.businessType]}</span>
              </>
            }
          />
        );
      })}
      {orders.length === 0 && <p className="px-4 py-8 text-center text-sm text-subtle">Nothing here yet.</p>}
    </div>
  );
}

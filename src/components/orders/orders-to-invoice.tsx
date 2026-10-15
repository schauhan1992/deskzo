"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createInvoicesForOrders, type ToInvoiceGroup } from "@/actions/order-billing";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatOrderId } from "@/lib/order-id";
import { companyPath, orderPath } from "@/lib/record-links";
import { documentPath } from "@/lib/trade-documents";
import { formatCurrency } from "@/lib/utils";
import { billingStatusLabels, billingStatusTones, quantityLabel } from "@/lib/orders/billing-rules";

/**
 * Orders to invoice (owner, 15 Oct 2026): sold and not yet billed in full, grouped by the customer's PO
 * — the orders that usually go on one invoice. Each group raises one invoice for all its orders, or one
 * per product; each order its own.
 */
export function OrdersToInvoice({ groups, canInvoice }: { groups: ToInvoiceGroup[]; canInvoice: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ key: string; ids?: string[]; error?: string } | null>(null);

  if (groups.length === 0) {
    return <Card className="mt-6 px-4 py-10 text-center text-sm text-muted">Nothing waiting to be invoiced — every sold order is billed.</Card>;
  }

  return (
    <div className="mt-6 space-y-3">
      {groups.map((g) => {
        const ids = g.orders.map((o) => o.id);
        const total = g.orders.reduce((t, o) => t + o.amountToBill, 0);
        return (
          <Card key={g.key} className="overflow-hidden p-0">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface-sunken px-4 py-2.5">
              <div className="min-w-0">
                <Link href={companyPath(g.company.companySeq)} className="text-sm font-medium text-text hover:underline">
                  {g.company.name}
                </Link>
                <span className="ml-2 text-xs text-muted">{g.po ? `Customer PO ${g.po}` : "No customer PO"}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted">{formatCurrency(total)} to bill, before GST</span>
                {canInvoice && g.orders.length > 1 && (
                  <>
                    {g.oneSite ? (
                      <Link href={`/documents/new?type=INVOICE&orders=${ids.join(",")}`}>
                        <Button size="sm">One invoice for all {g.orders.length}</Button>
                      </Link>
                    ) : (
                      <span className="text-[11px] text-subtle" title="Different sites have their own address and place of supply">
                        Different sites — one per product
                      </span>
                    )}
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={pending}
                      onClick={() =>
                        start(async () => {
                          const res = await createInvoicesForOrders(ids, "EACH");
                          setResult(res.ok ? { key: g.key, ids: res.data.ids } : { key: g.key, error: res.error });
                          router.refresh();
                        })
                      }
                    >
                      One per product
                    </Button>
                  </>
                )}
              </div>
            </div>
            <table className="w-full text-sm">
              <tbody>
                {g.orders.map((o) => (
                  <tr key={o.id} className="border-b border-line last:border-0">
                    <td className="px-4 py-2 font-mono text-xs">
                      <Link href={orderPath(o.orderSeq)} className="text-text hover:underline">
                        {formatOrderId(o.orderSeq)}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-muted">{o.itemName}</td>
                    <td className="px-4 py-2">
                      <Badge tone={billingStatusTones[o.status]}>{billingStatusLabels[o.status]}</Badge>
                    </td>
                    <td className="px-4 py-2 text-xs text-muted">
                      {quantityLabel(o.invoiced)} of {quantityLabel(o.ordered)}
                      {o.unit ? ` ${o.unit}` : ""} invoiced · <span className="font-medium text-text">{quantityLabel(o.remaining)} to bill</span>
                    </td>
                    <td className="px-4 py-2 text-right text-xs text-text">{formatCurrency(o.amountToBill)}</td>
                    <td className="px-4 py-2 text-right">
                      {canInvoice && (
                        <Link href={`/documents/new?type=INVOICE&orders=${o.id}`} className="text-xs text-brand hover:underline">
                          Invoice
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {result?.key === g.key && (
              <p className={`border-t border-line px-4 py-2 text-xs ${result.error ? "text-danger" : "text-success"}`}>
                {result.error ??
                  (
                    <>
                      {result.ids!.length} draft invoice{result.ids!.length === 1 ? "" : "s"} made — check and issue each:{" "}
                      {result.ids!.map((id, i) => (
                        <Link key={id} href={documentPath(id)} className="mr-1.5 underline">
                          {i + 1}
                        </Link>
                      ))}
                    </>
                  )}
              </p>
            )}
          </Card>
        );
      })}
    </div>
  );
}

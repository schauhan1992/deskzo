"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { bulkDeletePayments } from "@/actions/payment";
import { Badge, Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { BulkBar, Checkbox, useRowSelection } from "@/components/ui/bulk-select";
import { AllocatePaymentButton } from "@/components/payments/allocate-payment-button";
import { DeletePaymentButton } from "@/components/payments/delete-payment-button";
import { formatCurrency } from "@/lib/utils";
import { formatCalendarDay } from "@/lib/time/zone";
import { paymentMethodLabels } from "@/lib/gst";
import { isBaseCurrency } from "@/lib/currency";
import { companyPath } from "@/lib/record-links";

type PaymentRow = {
  id: string;
  amount: number | string;
  /** What it was received in — a receipt against a USD invoice is in dollars. */
  currency?: string;
  paidOn: Date | string;
  method: string;
  reference: string | null;
  allocated: number;
  unallocated: number;
  company: { id: string; companySeq: number; name: string };
  recordedBy: { id: string; name: string };
};

export function PaymentsReceivedTable({
  payments,
  canRecord,
  canDelete,
}: {
  payments: PaymentRow[];
  canRecord: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const selection = useRowSelection(payments);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selectedTotal = payments
    .filter((p) => selection.isSelected(p.id))
    .reduce((sum, p) => sum + Number(p.amount), 0);

  function removeSelected() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await bulkDeletePayments(selection.ids);
      if (!result.ok) {
        setError(result.error);
        // Some may have gone even so: each payment is deleted on its own.
        router.refresh();
        return;
      }
      setNotice(`Deleted ${result.data.count} payment(s).`);
      selection.clear();
      router.refresh();
    });
  }

  return (
    <div>
      <BulkBar count={selection.count} onClear={selection.clear} error={error} notice={notice}>
        <span className="text-sm text-muted">{formatCurrency(selectedTotal)} selected</span>
        {canDelete && (
          <Button
            size="sm"
            variant="danger"
            disabled={isPending}
            onClick={() => {
              if (
                confirm(
                  `Delete ${selection.count} payment(s) totalling ${formatCurrency(selectedTotal)}? ` +
                    "Their allocations go too, so the orders they paid for become outstanding again.",
                )
              ) {
                removeSelected();
              }
            }}
          >
            Delete
          </Button>
        )}
      </BulkBar>

      <Card>
        <CardHeader className="text-sm font-medium text-text">Payments received</CardHeader>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="w-10 px-4 py-2.5">
                  <Checkbox
                    checked={selection.allSelected}
                    onChange={selection.toggleAll}
                    aria-label="Select all payments on this page"
                  />
                </th>
                <th className="px-4 py-2.5">Company</th>
                <th className="px-4 py-2.5">Amount</th>
                <th className="px-4 py-2.5">Paid on</th>
                <th className="px-4 py-2.5">Method</th>
                <th className="px-4 py-2.5">Reference</th>
                <th className="px-4 py-2.5">Allocated</th>
                <th className="px-4 py-2.5">Unallocated</th>
                <th className="px-4 py-2.5">Recorded by</th>
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                  <td className="px-4 py-2.5">
                    <Checkbox
                      checked={selection.isSelected(p.id)}
                      onChange={() => selection.toggle(p.id)}
                      aria-label={`Select payment from ${p.company.name}`}
                    />
                  </td>
                  <td className="px-4 py-2.5">
                    <Link href={`${companyPath(p.company.companySeq)}?tab=payments`} className="font-medium text-text hover:underline">
                      {p.company.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 text-muted">{formatCurrency(String(p.amount), p.currency)}</td>
                  <td className="px-4 py-2.5 text-muted">{formatCalendarDay(p.paidOn)}</td>
                  <td className="px-4 py-2.5 text-muted">
                    {paymentMethodLabels[p.method as keyof typeof paymentMethodLabels] ?? p.method}
                  </td>
                  <td className="px-4 py-2.5 text-muted">{p.reference ?? "—"}</td>
                  <td className="px-4 py-2.5 text-muted">{formatCurrency(String(p.allocated), p.currency)}</td>
                  <td className="px-4 py-2.5">
                    {p.unallocated > 0 ? (
                      <Badge tone="amber">{formatCurrency(String(p.unallocated), p.currency)}</Badge>
                    ) : (
                      <span className="text-subtle">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted">{p.recordedBy.name}</td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex justify-end gap-1">
                      {/* Orders are in rupees; money in another currency is applied to an invoice in it instead. */}
                      {canRecord && p.unallocated > 0 && isBaseCurrency(p.currency) && (
                        <AllocatePaymentButton payment={{ id: p.id, unallocated: p.unallocated, company: p.company }} />
                      )}
                      {canDelete && (
                        <DeletePaymentButton paymentId={p.id} amount={Number(p.amount)} companyName={p.company.name} />
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {payments.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-subtle">
                    No payments recorded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

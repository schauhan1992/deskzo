import Link from "next/link";
import { listCompanyPayments, companyPaymentSummary } from "@/actions/payment";
import { Badge } from "@/components/ui/card";
import { RecordPaymentButton } from "@/components/payments/record-payment-button";
import { DeletePaymentButton } from "@/components/payments/delete-payment-button";
import { AllocatePaymentButton } from "@/components/payments/allocate-payment-button";
import { formatCurrency, formatDate } from "@/lib/utils";
import { paymentMethodLabels } from "@/lib/gst";
import { formatOrderId } from "@/lib/order-id";
import { isBaseCurrency } from "@/lib/currency";

type Payment = Awaited<ReturnType<typeof listCompanyPayments>>[number];
type Summary = Awaited<ReturnType<typeof companyPaymentSummary>>;

export function CompanyPayments({
  companyId,
  companyName,
  payments,
  summary,
  canRecord,
  canDelete,
}: {
  companyId: string;
  companyName: string;
  payments: Payment[];
  summary: Summary;
  canRecord: boolean;
  canDelete: boolean;
}) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-4">
        <Stat label="Billed" value={formatCurrency(summary.billed)} />
        <Stat label="Received" value={formatCurrency(summary.received)} />
        <Stat
          label="Outstanding"
          value={formatCurrency(summary.outstanding)}
          tone={summary.outstanding > 0 ? "danger" : "success"}
        />
        {summary.credit > 0 ? (
          <Stat label="In credit" value={formatCurrency(summary.credit)} tone="warning" />
        ) : (
          <Stat
            label="Unallocated"
            value={formatCurrency(summary.unallocated)}
            tone={summary.unallocated > 0 ? "warning" : undefined}
          />
        )}
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {payments.length === 0
            ? "No payments recorded from this company yet."
            : `${payments.length} payment(s) received.`}
        </p>
        {/* The company is fixed here, so the picker is pre-filled rather than asking again. */}
        <RecordPaymentButton companies={[{ id: companyId, name: companyName }]} canRecord={canRecord} />
      </div>

      {payments.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2">Paid on</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2">Method</th>
                <th className="px-3 py-2">Reference</th>
                <th className="px-3 py-2">Allocated to</th>
                <th className="px-3 py-2">Recorded by</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {payments.map((payment) => (
                <tr key={payment.id} className="border-b border-line align-top last:border-0">
                  <td className="px-3 py-2 text-muted">{formatDate(payment.paidOn)}</td>
                  <td className="px-3 py-2 text-right font-medium text-text">{formatCurrency(payment.amount, payment.currency)}</td>
                  <td className="px-3 py-2 text-muted">{paymentMethodLabels[payment.method]}</td>
                  <td className="px-3 py-2 text-subtle">{payment.reference ?? "—"}</td>
                  <td className="px-3 py-2">
                    {payment.allocations.length === 0 ? (
                      <Badge tone="amber">Unallocated</Badge>
                    ) : (
                      <div className="space-y-0.5">
                        {payment.allocations.map((allocation) => (
                          <div key={allocation.id} className="text-xs">
                            {allocation.document ? (
                              <Link href={`/documents/${allocation.document.id}`} className="text-text hover:underline">
                                {allocation.document.docNumber}
                              </Link>
                            ) : allocation.companyProduct ? (
                              <>
                                <Link href={`/orders/${allocation.companyProduct.id}`} className="text-text hover:underline">
                                  {formatOrderId(allocation.companyProduct.orderSeq)}
                                </Link>
                                <span className="text-subtle"> {allocation.companyProduct.item.name}</span>
                              </>
                            ) : (
                              <span className="text-subtle">Unlinked</span>
                            )}
                            {/* What it settled, in the document's currency; and, across currencies, what it took from this payment. */}
                            <span className="text-subtle">
                              {" "}
                              · {formatCurrency(allocation.amount, allocation.document?.currency ?? payment.currency)}
                              {allocation.paymentAmount !== null && ` (${formatCurrency(allocation.paymentAmount, payment.currency)})`}
                            </span>
                          </div>
                        ))}
                        {payment.unallocated > 0 && (
                          <div className="text-xs text-warning">
                            {formatCurrency(payment.unallocated, payment.currency)} still unallocated
                          </div>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted">{payment.recordedBy.name}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1">
                      {canRecord && payment.unallocated > 0 && isBaseCurrency(payment.currency) && (
                        <AllocatePaymentButton
                          payment={{
                            id: payment.id,
                            unallocated: payment.unallocated,
                            company: { id: companyId, name: companyName },
                          }}
                        />
                      )}
                      {canDelete && (
                        <DeletePaymentButton
                          paymentId={payment.id}
                          amount={Number(payment.amount)}
                          companyName={companyName}
                        />
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "danger" | "success" | "warning";
}) {
  const toneClass =
    tone === "danger" ? "text-danger" : tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : "text-text";
  return (
    <div className="rounded-lg border border-line bg-surface-sunken px-3 py-2.5">
      <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
      <div className={`mt-0.5 text-base font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}

import Link from "next/link";
import { customerStatement } from "@/actions/receivable";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatCurrency, formatDate } from "@/lib/utils";
import { AGING_BUCKETS } from "@/lib/receivables";

type Statement = Awaited<ReturnType<typeof customerStatement>>;

const KIND_TONE = {
  INVOICE: "blue",
  PAYMENT: "green",
  CREDIT_NOTE: "amber",
} as const;

const KIND_LABEL = {
  INVOICE: "Invoice",
  PAYMENT: "Payment",
  CREDIT_NOTE: "Credit note",
} as const;

/**
 * A statement of account: every invoice, payment and credit note in date order with a running
 * balance, the aging of what's still open, and the invoices making it up.
 */
export function CompanyStatement({ statement }: { statement: Statement }) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-4">
        <Figure label="Invoiced" value={formatCurrency(statement.invoiced)} hint="issued tax invoices" />
        <Figure
          label="Received"
          value={formatCurrency(statement.received)}
          tone="success"
          hint={statement.unappliedPayments > 0 ? `${formatCurrency(statement.unappliedPayments)} unapplied` : "all applied"}
        />
        <Figure
          label="Credit notes"
          value={formatCurrency(statement.credited)}
          tone="warning"
          hint={statement.unappliedCredits > 0 ? `${formatCurrency(statement.unappliedCredits)} unapplied` : "all applied"}
        />
        <Figure
          label="Outstanding"
          value={formatCurrency(statement.outstanding)}
          tone={statement.outstanding > 0 ? "danger" : "success"}
          hint="still owed on invoices"
        />
      </div>

      {/* Two different questions — what's owed on invoices, and what's sitting on account — so the
          net is spelled out rather than leaving the reader to reconcile them. */}
      {(statement.unappliedPayments > 0 || statement.unappliedCredits > 0) && (
        <Card
          className={`px-4 py-3 text-sm ${
            statement.netPosition < 0 ? "border-warning/40 bg-warning-bg text-warning" : "text-muted"
          }`}
        >
          {statement.netPosition < 0 ? (
            <>
              <span className="font-medium">
                {formatCurrency(Math.abs(statement.netPosition))} in credit on this account
              </span>{" "}
              — {formatCurrency(statement.unappliedPayments)} in unapplied payments and{" "}
              {formatCurrency(statement.unappliedCredits)} in unapplied credit notes, against{" "}
              {formatCurrency(statement.outstanding)} still owed. Apply it to an invoice to clear it down.
            </>
          ) : (
            <>
              <span className="font-medium">{formatCurrency(statement.netPosition)} net owed</span> after{" "}
              {formatCurrency(statement.unappliedPayments + statement.unappliedCredits)} of unapplied payments and
              credit notes.
            </>
          )}
        </Card>
      )}

      <Card>
        <CardHeader className="text-sm font-medium text-text">Aging</CardHeader>
        <CardContent>
          {statement.outstanding === 0 ? (
            <p className="text-sm text-subtle">Nothing outstanding — every issued invoice is settled.</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-5">
              {AGING_BUCKETS.map((bucket) => (
                <div key={bucket.key} className="rounded-lg border border-line bg-surface-sunken px-3 py-2">
                  <div className="text-xs uppercase tracking-wide text-subtle">{bucket.label}</div>
                  <div
                    className={`mt-0.5 text-sm font-semibold ${
                      statement.aging[bucket.key] > 0 && bucket.key !== "current" ? "text-danger" : "text-text"
                    }`}
                  >
                    {formatCurrency(statement.aging[bucket.key])}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {statement.openInvoices.length > 0 && (
        <Card>
          <CardHeader className="text-sm font-medium text-text">Open invoices</CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-y border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-5 py-2">Invoice</th>
                  <th className="px-3 py-2">Issued</th>
                  <th className="px-3 py-2">Due</th>
                  <th className="px-3 py-2">Age</th>
                  <th className="px-3 py-2 text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {statement.openInvoices.map((invoice) => (
                  <tr key={invoice.id} className="border-b border-line last:border-0">
                    <td className="px-5 py-2">
                      <Link href={`/documents/${invoice.id}`} className="font-mono text-xs text-text hover:underline">
                        {invoice.docNumber}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-muted">{formatDate(invoice.issueDate)}</td>
                    <td className="px-3 py-2 text-muted">{invoice.dueDate ? formatDate(invoice.dueDate) : "—"}</td>
                    <td className="px-3 py-2">
                      {invoice.daysOverdue > 0 ? (
                        <Badge tone={invoice.daysOverdue > 90 ? "red" : "amber"}>{invoice.daysOverdue}d overdue</Badge>
                      ) : (
                        <Badge tone="default">Not due</Badge>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-medium text-text">{formatCurrency(invoice.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="text-sm font-medium text-text">
          Statement of account
          <span className="ml-2 text-xs font-normal text-subtle">
            Running balance — a negative figure means they&apos;re in credit with us.
          </span>
        </CardHeader>
        <CardContent className={statement.ledger.length === 0 ? undefined : "p-0"}>
          {statement.ledger.length === 0 ? (
            <p className="text-sm text-subtle">
              Nothing on this account yet. Invoices, payments and credit notes appear here in date order.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-y border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-5 py-2">Date</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Reference</th>
                  <th className="px-3 py-2 text-right">Debit</th>
                  <th className="px-3 py-2 text-right">Credit</th>
                  <th className="px-3 py-2 text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {statement.ledger.map((entry) => (
                  <tr key={`${entry.kind}-${entry.id}`} className="border-b border-line last:border-0">
                    <td className="px-5 py-2 text-muted">{formatDate(entry.date)}</td>
                    <td className="px-3 py-2">
                      <Badge tone={KIND_TONE[entry.kind]}>{KIND_LABEL[entry.kind]}</Badge>
                    </td>
                    <td className="px-3 py-2">
                      {entry.href ? (
                        <Link href={entry.href} className="font-mono text-xs text-text hover:underline">
                          {entry.reference}
                        </Link>
                      ) : (
                        <span className="text-muted">{entry.reference}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-muted">
                      {entry.debit > 0 ? formatCurrency(entry.debit) : "—"}
                    </td>
                    <td className="px-3 py-2 text-right text-muted">
                      {entry.credit > 0 ? formatCurrency(entry.credit) : "—"}
                    </td>
                    <td className="px-3 py-2 text-right font-medium text-text">{formatCurrency(entry.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Figure({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: "danger" | "success" | "warning";
  hint?: string;
}) {
  const toneClass =
    tone === "danger" ? "text-danger" : tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : "text-text";
  return (
    <Card className="px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${toneClass}`}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </Card>
  );
}

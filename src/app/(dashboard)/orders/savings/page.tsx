import Link from "next/link";
import { purchaseSavingsReport } from "@/actions/order";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { Card } from "@/components/ui/card";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { formatCurrency } from "@/lib/utils";
import { formatOrderId } from "@/lib/order-id";

const MONTH = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", month: "long", year: "numeric" });
const DAY = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });

/**
 * Purchase savings: what each purchaser bought below the salesperson's distributor price, by month —
 * with the increases sales accepted shown beside them rather than netted away, and every order line
 * underneath so any figure can be traced to the orders behind it.
 */
export default async function PurchaseSavingsPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const enabled = await isModuleEnabled("orders");
  if (!enabled) return <ModuleDisabledNotice moduleKey="orders" />;

  const params = await searchParams;
  const report = await purchaseSavingsReport({ from: params.from, to: params.to });
  if (!report) {
    return (
      <div className="max-w-md">
        <h1 className="text-xl font-semibold text-text">Purchase savings</h1>
        <p className="mt-2 text-sm text-muted">
          This report is for purchase, order approvers, and anyone who can see team performance.
        </p>
      </div>
    );
  }

  const totals = report.summary.reduce(
    (t, r) => ({ savings: t.savings + r.savings, increases: t.increases + r.increases }),
    { savings: 0, increases: 0 },
  );

  return (
    <div>
      <h1 className="text-xl font-semibold text-text">Purchase savings</h1>
      <p className="mt-1 text-sm text-muted">
        What purchase bought below the distributor price sales had, times the quantity — and, separately, where sales
        accepted a higher price. Only orders with a distributor price from sales count; cancelled orders are struck
        through and count nowhere. {report.everyone ? "Everyone's." : "Yours."}
      </p>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <DateRangePicker fromParam="from" toParam="to" label="Recorded" />
        {(report.from || report.to) && (
          <p className="text-sm text-muted">
            {report.from ? DAY.format(new Date(`${report.from}T00:00:00Z`)) : "From the start"} –{" "}
            {report.to ? DAY.format(new Date(`${report.to}T00:00:00Z`)) : "today"}
          </p>
        )}
      </div>

      <Card className="mt-6 overflow-x-auto p-0">
        <table className="w-full text-sm">
          <caption className="sr-only">Purchase savings by person and month</caption>
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">Purchaser</th>
              <th className="px-4 py-2.5">Month</th>
              <th className="px-4 py-2.5 text-right">Savings</th>
              <th className="px-4 py-2.5 text-right">Accepted increases</th>
              <th className="px-4 py-2.5 text-right">Net</th>
              <th className="px-4 py-2.5 text-right">Order lines</th>
            </tr>
          </thead>
          <tbody>
            {report.summary.map((r) => (
              <tr key={`${r.purchaserId}-${r.month}`} className="border-b border-line last:border-0">
                <td className="px-4 py-2.5 font-medium text-text">{r.purchaser}</td>
                <td className="px-4 py-2.5 text-muted">{MONTH.format(new Date(`${r.month}-01T00:00:00Z`))}</td>
                <td className="px-4 py-2.5 text-right text-success">{formatCurrency(r.savings)}</td>
                <td className="px-4 py-2.5 text-right text-danger">{r.increases < 0 ? formatCurrency(r.increases) : "—"}</td>
                <td className={`px-4 py-2.5 text-right font-medium ${r.net >= 0 ? "text-text" : "text-danger"}`}>{formatCurrency(r.net)}</td>
                <td className="px-4 py-2.5 text-right text-muted">{r.lines}</td>
              </tr>
            ))}
            {report.summary.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-subtle">
                  Nothing recorded in this period.
                </td>
              </tr>
            ) : (
              <tr className="border-t border-line bg-surface-sunken">
                <td className="px-4 py-2.5 font-medium text-text" colSpan={2}>
                  Total
                </td>
                <td className="px-4 py-2.5 text-right font-medium text-success">{formatCurrency(Math.round(totals.savings * 100) / 100)}</td>
                <td className="px-4 py-2.5 text-right font-medium text-danger">
                  {totals.increases < 0 ? formatCurrency(Math.round(totals.increases * 100) / 100) : "—"}
                </td>
                <td className="px-4 py-2.5 text-right font-medium text-text">
                  {formatCurrency(Math.round((totals.savings + totals.increases) * 100) / 100)}
                </td>
                <td className="px-4 py-2.5" />
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {report.lines.length > 0 && (
        <>
          <h2 className="mt-8 text-sm font-medium text-text">Order lines</h2>
          <Card className="mt-3 overflow-x-auto p-0">
            <table className="w-full text-sm">
              <caption className="sr-only">Each order line behind the figures</caption>
              <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2.5">Recorded</th>
                  <th className="px-4 py-2.5">Order</th>
                  <th className="px-4 py-2.5">Customer · product</th>
                  <th className="px-4 py-2.5">Purchaser</th>
                  <th className="px-4 py-2.5">Salesperson</th>
                  <th className="px-4 py-2.5 text-right">Distributor price</th>
                  <th className="px-4 py-2.5 text-right">Bought at</th>
                  <th className="px-4 py-2.5 text-right">Qty</th>
                  <th className="px-4 py-2.5 text-right">Saving</th>
                </tr>
              </thead>
              <tbody>
                {report.lines.map((l) => (
                  <tr key={l.id} className={`border-b border-line last:border-0 ${l.cancelled ? "text-subtle line-through" : ""}`}>
                    <td className="px-4 py-2.5">{DAY.format(new Date(`${l.recordedOn}T00:00:00Z`))}</td>
                    <td className="px-4 py-2.5 font-mono text-xs">
                      <Link href={`/orders/${l.orderId}`} className="hover:underline">
                        {formatOrderId(l.orderSeq)}
                      </Link>
                      {l.cancelled && <span className="ml-1.5 font-sans no-underline">(cancelled)</span>}
                    </td>
                    <td className="px-4 py-2.5">
                      {l.customer} · {l.item}
                    </td>
                    <td className="px-4 py-2.5">{l.purchaser}</td>
                    <td className="px-4 py-2.5">{l.salesperson}</td>
                    <td className="px-4 py-2.5 text-right">{formatCurrency(l.quotedPrice)}</td>
                    <td className="px-4 py-2.5 text-right">{formatCurrency(l.actualPrice)}</td>
                    <td className="px-4 py-2.5 text-right">{l.quantity}</td>
                    <td className={`px-4 py-2.5 text-right font-medium ${l.cancelled ? "" : l.amount >= 0 ? "text-success" : "text-danger"}`}>
                      {formatCurrency(l.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}

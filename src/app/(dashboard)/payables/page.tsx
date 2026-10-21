import Link from "next/link";
import { notFound } from "next/navigation";
import { payablesAging, payablesAgingReport, vendorBalanceSummary } from "@/actions/payable";
import { BalanceSummaryReport, BalanceViews } from "@/components/receivables/balance-summary-report";
import { AgingDocumentsView, AgingReportView } from "@/components/receivables/aging-report";
import type { AgingParams } from "@/lib/receivables/aging";
import { formatMoney } from "@/lib/currency";
import { isModuleEnabled } from "@/actions/module";
import { Badge, Card } from "@/components/ui/card";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { formatCurrency } from "@/lib/utils";
import { AGING_BUCKETS } from "@/lib/receivables";
import { companyPath } from "@/lib/record-links";

/**
 * Accounts payable, aged. One row per vendor we still owe, bucketed by how long past due each of
 * their bills is — the mirror of receivables, and the report a payment run is planned from. In rupees,
 * each bill at its own rate.
 *
 * `?view=balances`: the Vendor Balance Summary (owner, 21 Oct 2026) — what we owed each vendor as of a day,
 * with unused credits and journals beside the open bills, in rupees and their own currency.
 */
export default async function PayablesPage({ searchParams }: { searchParams: Promise<AgingParams & { q?: string; view?: string; asOf?: string; docs?: string }> }) {
  const enabled = await isModuleEnabled("payables");
  if (!enabled) return <ModuleDisabledNotice moduleKey="payables" />;

  const params = await searchParams;
  // The AP aging report (owner, 21 Oct 2026): as of a day, by due date or bill date, in chosen intervals.
  if (params.view === "aging") {
    const report = await payablesAgingReport(params);
    if (!report) notFound();
    return (
      <div className="animate-fade-rise">
        <div>
          <h1 className="text-xl font-semibold text-text">Payables</h1>
          <p className="mt-1 text-sm text-muted">What was open on each bill at the end of a day, by how far past due — or how old — it was then. Click a figure to see its bills.</p>
        </div>
        <BalanceViews base="/payables" current="aging" q={params.q} />
        {params.docs ? <AgingDocumentsView report={report} base="/payables" /> : <AgingReportView report={report} base="/payables" />}
      </div>
    );
  }
  if (params.view === "balances") {
    const summary = await vendorBalanceSummary({ asOf: params.asOf, search: params.q });
    if (!summary) notFound();
    return (
      <div className="animate-fade-rise">
        <div>
          <h1 className="text-xl font-semibold text-text">Payables</h1>
          <p className="mt-1 text-sm text-muted">
            What we owed each vendor at the end of a day: their open bills, less payments and vendor credit notes not yet set against one,
            with opening balances and journals — the balance Accounts Payable holds for them.
          </p>
        </div>
        <BalanceViews base="/payables" current="balances" q={params.q} />
        <BalanceSummaryReport summary={summary} />
      </div>
    );
  }
  const { rows, totals } = await payablesAging({ search: params.q });
  const overdue = totals.total - totals.buckets.current;

  return (
    <div className="animate-fade-rise">
      <div>
        <h1 className="text-xl font-semibold text-text">Payables</h1>
        <p className="mt-1 text-sm text-muted">
          What we owe vendors, aged from each bill&apos;s due date. Bills settle through payments recorded against
          them, the same way invoices do on the other side.
        </p>
      </div>

      <BalanceViews base="/payables" current="aged" q={params.q} />

      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Total owed</div>
          <div className="mt-1 text-lg font-semibold text-text">{formatCurrency(totals.total)}</div>
          <div className="mt-0.5 text-xs text-muted">{rows.length} vendor(s)</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Overdue</div>
          <div className={`mt-1 text-lg font-semibold ${overdue > 0 ? "text-danger" : "text-text"}`}>
            {formatCurrency(overdue)}
          </div>
          <div className="mt-0.5 text-xs text-muted">past the agreed terms</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Not yet due</div>
          <div className="mt-1 text-lg font-semibold text-text">{formatCurrency(totals.buckets.current)}</div>
          <div className="mt-0.5 text-xs text-muted">within terms</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Over 90 days</div>
          <div className={`mt-1 text-lg font-semibold ${totals.buckets.d90_plus > 0 ? "text-danger" : "text-text"}`}>
            {formatCurrency(totals.buckets.d90_plus)}
          </div>
          <div className="mt-0.5 text-xs text-muted">worth a call before they chase</div>
        </Card>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <SearchParamInput paramName="q" placeholder="Search vendor name…" />
      </div>

      <Card className="mt-4 overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">Vendor</th>
              {AGING_BUCKETS.map((b) => (
                <th key={b.key} className="px-4 py-2.5 text-right">
                  {b.label}
                </th>
              ))}
              <th className="px-4 py-2.5 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                <td className="px-4 py-2.5">
                  <Link href={companyPath(row.companySeq)} className="text-text hover:underline">
                    {row.name}
                  </Link>
                  <div className="mt-0.5 text-xs text-subtle">
                    {row.billCount} bill(s)
                    {row.oldest > 0 && ` · oldest ${row.oldest} day(s) overdue`}
                  </div>
                  {Object.keys(row.foreign).length > 0 && (
                    <div className="mt-0.5 text-xs text-subtle">
                      Includes {Object.entries(row.foreign).map(([currency, amount]) => formatMoney(amount, currency)).join(" and ")}
                    </div>
                  )}
                </td>
                {AGING_BUCKETS.map((b) => (
                  <td key={b.key} className="px-4 py-2.5 text-right tabular-nums text-muted">
                    {row.buckets[b.key] > 0 ? formatCurrency(row.buckets[b.key]) : "—"}
                  </td>
                ))}
                <td className="px-4 py-2.5 text-right font-medium tabular-nums text-text">
                  {formatCurrency(row.total)}
                  {row.oldest > 90 && (
                    <Badge tone="red" className="ml-2">
                      Overdue
                    </Badge>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={AGING_BUCKETS.length + 2} className="px-4 py-12 text-center text-subtle">
                  Nothing outstanding. Every bill on file has been paid.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-line-strong">
              <td className="px-4 py-2.5 font-semibold text-text">Total</td>
              {AGING_BUCKETS.map((b) => (
                <td key={b.key} className="px-4 py-2.5 text-right font-semibold tabular-nums text-text">
                  {totals.buckets[b.key] > 0 ? formatCurrency(totals.buckets[b.key]) : "—"}
                </td>
              ))}
              <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-text">
                {formatCurrency(totals.total)}
              </td>
            </tr>
          </tfoot>
        </table>
      </Card>
    </div>
  );
}

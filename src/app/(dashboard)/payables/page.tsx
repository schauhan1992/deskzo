import Link from "next/link";
import { payablesAging } from "@/actions/payable";
import { isModuleEnabled } from "@/actions/module";
import { Badge, Card } from "@/components/ui/card";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { formatCurrency } from "@/lib/utils";
import { AGING_BUCKETS } from "@/lib/receivables";

/**
 * Accounts payable, aged. One row per vendor we still owe, bucketed by how long past due each of
 * their bills is — the mirror of receivables, and the report a payment run is planned from.
 */
export default async function PayablesPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const enabled = await isModuleEnabled("payables");
  if (!enabled) return <ModuleDisabledNotice moduleKey="payables" />;

  const params = await searchParams;
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
                  <Link href={`/companies/${row.id}`} className="text-text hover:underline">
                    {row.name}
                  </Link>
                  <div className="mt-0.5 text-xs text-subtle">
                    {row.billCount} bill(s)
                    {row.oldest > 0 && ` · oldest ${row.oldest} day(s) overdue`}
                  </div>
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

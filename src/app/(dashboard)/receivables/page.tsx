import Link from "next/link";
import { agingReport } from "@/actions/receivable";
import { isModuleEnabled } from "@/actions/module";
import { Badge, Card } from "@/components/ui/card";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { formatCurrency } from "@/lib/utils";
import { AGING_BUCKETS } from "@/lib/receivables";

/**
 * Accounts receivable, aged. One row per customer with something outstanding, bucketed by how long
 * past due each of their invoices is — the report a collections call is made from.
 */
export default async function ReceivablesPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const enabled = await isModuleEnabled("receivables");
  if (!enabled) return <ModuleDisabledNotice moduleKey="receivables" />;

  const params = await searchParams;
  const { rows, totals } = await agingReport({ search: params.q });

  const overdue = totals.total - totals.buckets.current;

  return (
    <div className="animate-fade-rise">
      <div>
        <h1 className="text-xl font-semibold text-text">Receivables</h1>
        <p className="mt-1 text-sm text-muted">
          What customers owe, aged from each invoice&apos;s due date. Invoices settle through payments and credit
          notes applied against them.
        </p>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Total outstanding</div>
          <div className="mt-1 text-lg font-semibold text-text">{formatCurrency(totals.total)}</div>
          <div className="mt-0.5 text-xs text-muted">{rows.length} customer(s)</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Overdue</div>
          <div className={`mt-1 text-lg font-semibold ${overdue > 0 ? "text-danger" : "text-text"}`}>
            {formatCurrency(overdue)}
          </div>
          <div className="mt-0.5 text-xs text-muted">past the due date</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Not yet due</div>
          <div className="mt-1 text-lg font-semibold text-text">{formatCurrency(totals.buckets.current)}</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">90+ days</div>
          <div className={`mt-1 text-lg font-semibold ${totals.buckets.d90_plus > 0 ? "text-danger" : "text-text"}`}>
            {formatCurrency(totals.buckets.d90_plus)}
          </div>
          <div className="mt-0.5 text-xs text-muted">worth chasing hard</div>
        </Card>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <SearchParamInput paramName="q" placeholder="Search customer name…" />
      </div>

      <Card className="mt-5 overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">Customer</th>
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
                  <Link href={`/companies/${row.id}?tab=statement`} className="font-medium text-text hover:underline">
                    {row.name}
                  </Link>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-subtle">
                    {row.invoiceCount} open invoice(s)
                    {row.oldest > 0 && <Badge tone={row.oldest > 90 ? "red" : "amber"}>{row.oldest}d overdue</Badge>}
                  </div>
                </td>
                {AGING_BUCKETS.map((b) => (
                  <td
                    key={b.key}
                    className={`px-4 py-2.5 text-right ${
                      row.buckets[b.key] > 0 && b.key !== "current" ? "text-danger" : "text-muted"
                    }`}
                  >
                    {row.buckets[b.key] > 0 ? formatCurrency(row.buckets[b.key]) : "—"}
                  </td>
                ))}
                <td className="px-4 py-2.5 text-right font-semibold text-text">{formatCurrency(row.total)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={AGING_BUCKETS.length + 2} className="px-4 py-10 text-center text-subtle">
                  Nothing outstanding — every issued invoice is settled.
                </td>
              </tr>
            )}
          </tbody>
          {rows.length > 0 && (
            <tfoot className="border-t border-line bg-surface-sunken text-sm font-semibold text-text">
              <tr>
                <td className="px-4 py-2.5">Total</td>
                {AGING_BUCKETS.map((b) => (
                  <td key={b.key} className="px-4 py-2.5 text-right">
                    {formatCurrency(totals.buckets[b.key])}
                  </td>
                ))}
                <td className="px-4 py-2.5 text-right">{formatCurrency(totals.total)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </Card>
    </div>
  );
}

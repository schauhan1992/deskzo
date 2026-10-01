import Link from "next/link";
import { agingReport } from "@/actions/receivable";
import { isModuleEnabled } from "@/actions/module";
import { Badge, Card } from "@/components/ui/card";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { PromiseBadge, promiseText } from "@/components/collections/follow-up-history";
import { formatCurrency } from "@/lib/utils";
import { AGING_BUCKETS } from "@/lib/receivables";
import { followUpChannelLabels } from "@/lib/collections/rules";
import { formatIstDate } from "@/lib/india-time";

/** Collections' views of the list: customers with a promise to pay broken, or due in the next week. */
const PROMISE_FILTERS = [
  { value: undefined, label: "All" },
  { value: "broken", label: "Broken promises" },
  { value: "week", label: "Promised this week" },
] as const;

/**
 * Accounts receivable, aged. One row per customer with something outstanding, bucketed by how long
 * past due each of their invoices is — the report a collections call is made from — with the last
 * follow-up anybody logged and the promise that matters most.
 */
export default async function ReceivablesPage({ searchParams }: { searchParams: Promise<{ q?: string; promise?: string }> }) {
  const enabled = await isModuleEnabled("receivables");
  if (!enabled) return <ModuleDisabledNotice moduleKey="receivables" />;

  const params = await searchParams;
  const promise = params.promise === "broken" || params.promise === "week" ? params.promise : undefined;
  const { rows, totals } = await agingReport({ search: params.q, promise });

  const overdue = totals.total - totals.buckets.current;
  const query = (overrides: Record<string, string | undefined>) =>
    Object.fromEntries(Object.entries({ q: params.q, promise, ...overrides }).filter(([, v]) => v)) as Record<string, string>;

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
        <nav aria-label="Promises to pay" className="flex flex-wrap items-center gap-2">
          {PROMISE_FILTERS.map((f) => (
            <Link
              key={f.label}
              href={{ pathname: "/receivables", query: query({ promise: f.value }) }}
              aria-current={promise === f.value ? "page" : undefined}
              className={`rounded-full px-3 py-1 text-sm ${
                promise === f.value ? "bg-brand text-brand-contrast" : "border border-line-strong bg-surface text-muted"
              }`}
            >
              {f.label}
            </Link>
          ))}
        </nav>
      </div>
      {promise && (
        <p className="mt-2 text-xs text-muted">
          {promise === "broken"
            ? "Customers with a promise to pay on an open invoice whose day has passed unpaid."
            : "Customers who promised to pay an open invoice today or in the next six days."}{" "}
          Each invoice and order, with who logged what, is on{" "}
          <Link href={{ pathname: "/collections", query: { filter: promise } }} className="underline hover:text-text">
            Collections
          </Link>
          .
        </p>
      )}

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
              <th className="px-4 py-2.5">Last follow-up</th>
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
                <td className="min-w-48 px-4 py-2.5 text-xs">
                  {row.lastFollowUp ? (
                    <div className="text-muted">
                      <span className="text-text">{formatIstDate(row.lastFollowUp.createdAt)}</span> ·{" "}
                      {followUpChannelLabels[row.lastFollowUp.channel]}
                      {row.lastFollowUp.byName ? ` · ${row.lastFollowUp.byName}` : ""}
                    </div>
                  ) : (
                    <span className="text-subtle">None logged</span>
                  )}
                  {row.promise && (
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-muted">
                      <span>
                        {row.promise.targetLabel ? `${row.promise.targetLabel}: ` : ""}
                        {promiseText(row.promise)}
                      </span>
                      <PromiseBadge view={row.promise} />
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={AGING_BUCKETS.length + 3} className="px-4 py-10 text-center text-subtle">
                  {promise === "broken"
                    ? "No broken promises on an open invoice."
                    : promise === "week"
                      ? "Nobody has promised to pay an open invoice this week."
                      : "Nothing outstanding — every issued invoice is settled."}
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
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </Card>
    </div>
  );
}

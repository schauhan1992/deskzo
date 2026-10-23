import type { CollectionInsights } from "@/lib/collect/insights";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { formatCalendarDay } from "@/lib/time/zone";

/**
 * Receivables › DSO & forecast (owner, 23 Oct 2026 — src/lib/collect/insights.ts): one figure for today, a
 * year of month-ends as bars with their values on hover and in a table, and the next eight weeks as a table.
 */
export function CollectionInsightsView({ insights }: { insights: CollectionInsights }) {
  const values = insights.dso.map((m) => m.dso ?? 0);
  const top = Math.max(...values, 1);
  const weeksTotal = insights.weeks.reduce((t, w) => t + w.promised + w.due, 0);

  return (
    <div className="mt-4 space-y-6">
      <Card>
        <CardHeader className="text-sm font-medium text-text">Days sales outstanding</CardHeader>
        <CardContent className="space-y-4">
          <div>
            <div className="text-3xl font-semibold tabular-nums text-text">{insights.current === null ? "—" : `${insights.current} days`}</div>
            <p className="mt-1 text-sm text-muted">
              Today: what customers owe, over what was invoiced in the last three months, in days. The lower it is, the sooner sales turn into money.
            </p>
          </div>
          {/* Twelve month-ends, one hue, read left to right; each bar's figure on hover and in the table below. */}
          <div className="flex h-40 items-end gap-0.5 border-b border-line" role="img" aria-label={`DSO at each month's end: ${insights.dso.map((m) => `${m.label} ${m.dso ?? "no sales"}`).join(", ")}`}>
            {insights.dso.map((m, n) => (
              <div key={m.monthKey} className="group relative flex h-full flex-1 flex-col justify-end">
                <span className="pointer-events-none absolute -top-1 left-1/2 z-10 hidden -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-base border border-line bg-surface px-2 py-1 text-xs text-text shadow-sm group-hover:block">
                  {m.label}: {m.dso === null ? "no sales" : `${m.dso} days`}
                </span>
                {n === insights.dso.length - 1 && m.dso !== null && <span className="mb-1 text-center text-xs tabular-nums text-muted">{m.dso}</span>}
                <div className="mx-auto w-full max-w-6 rounded-t-[4px] bg-brand" style={{ height: `${m.dso === null ? 0 : Math.max((m.dso / top) * 100, 2)}%` }} />
              </div>
            ))}
          </div>
          <div className="flex gap-0.5 text-[11px] text-muted">
            {insights.dso.map((m) => (
              <span key={m.monthKey} className="flex-1 truncate text-center">
                {m.label.split(" ")[0]}
              </span>
            ))}
          </div>
          <details className="text-sm">
            <summary className="cursor-pointer text-muted">The figures</summary>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-muted">
                    <th className="py-1.5 pr-3 font-medium">Month end</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Owed then</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Invoiced in 3 months</th>
                    <th className="py-1.5 text-right font-medium">DSO</th>
                  </tr>
                </thead>
                <tbody>
                  {insights.dso.map((m) => (
                    <tr key={m.monthKey} className="border-b border-line last:border-0">
                      <td className="py-1.5 pr-3 text-text">{m.label}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-muted">{formatCurrency(m.owed)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-muted">{formatCurrency(m.invoiced)}</td>
                      <td className="py-1.5 text-right tabular-nums text-text">{m.dso === null ? "—" : `${m.dso} days`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">Expected in the next eight weeks — {formatCurrency(weeksTotal)}</CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th className="px-4 py-2 font-medium">Week of</th>
                  <th className="px-4 py-2 text-right font-medium">Promised</th>
                  <th className="px-4 py-2 text-right font-medium">Falling due, no promise</th>
                  <th className="px-4 py-2 text-right font-medium">In all</th>
                </tr>
              </thead>
              <tbody>
                {insights.weeks.map((w) => (
                  <tr key={w.start.toISOString()} className="border-b border-line last:border-0">
                    <td className="whitespace-nowrap px-4 py-2 text-text">{formatCalendarDay(w.start)}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-muted">{w.promised ? formatCurrency(w.promised) : "—"}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-muted">{w.due ? formatCurrency(w.due) : "—"}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-text">{w.promised + w.due ? formatCurrency(w.promised + w.due) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="px-4 py-3 text-sm text-muted">
            {insights.overdueUnpromised.invoices > 0
              ? `Besides these, ${formatCurrency(insights.overdueUnpromised.amount)} on ${insights.overdueUnpromised.invoices} invoice${insights.overdueUnpromised.invoices === 1 ? " is" : "s are"} already overdue with no promise to pay — nobody can say when that comes in.`
              : "Nothing is overdue without a promise to pay."}{" "}
            A promise counts in the week it&apos;s for; an invoice with none, in the week it falls due.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

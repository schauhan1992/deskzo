import Link from "next/link";
import type { Waterfall, WaterfallRow } from "@/lib/revenue/reports";
import { monthLabel } from "@/lib/revenue/periods";
import { Card } from "@/components/ui/card";
import { Amount } from "@/components/accounting/report-chrome";

/**
 * The waterfall (spec §3.8): revenue still to be recognised, a row per customer or item and a column
 * per month from this one, with what is overdue before the first column, what falls after the last,
 * and milestone revenue that has no month until its delivery is done. The last column is each row's
 * total deferred, and the bottom-right figure is the remaining performance obligation.
 *
 * Many columns, so the table scrolls sideways inside its card, with the name column kept in view.
 */
export function WaterfallTable({ wf }: { wf: Waterfall }) {
  const showPastDue = wf.totals.pastDue !== 0;
  const showUnscheduled = wf.totals.unscheduled !== 0;
  const cells = (r: WaterfallRow, bold?: boolean) => (
    <>
      {showPastDue && (
        <td className="px-3 py-1.5 text-right">
          <Amount value={r.pastDue} bold={bold} />
        </td>
      )}
      {r.byMonth.map((v, i) => (
        <td key={wf.months[i]} className="px-3 py-1.5 text-right">
          <Amount value={v} bold={bold} />
        </td>
      ))}
      <td className="px-3 py-1.5 text-right">
        <Amount value={r.later} bold={bold} />
      </td>
      {showUnscheduled && (
        <td className="px-3 py-1.5 text-right">
          <Amount value={r.unscheduled} bold={bold} />
        </td>
      )}
      <td className="bg-surface-sunken/60 px-4 py-1.5 text-right">
        <Amount value={r.total} bold />
      </td>
    </>
  );

  if (wf.rows.length === 0) {
    return (
      <Card className="px-6 py-10 text-center text-sm text-muted">
        Nothing is waiting to be recognised. Revenue appears here when an invoice line with a service period running past
        its month is issued, or when deferred revenue is opened for older invoices on the Revenue page.
      </Card>
    );
  }

  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full text-sm">
        <caption className="sr-only">Revenue waterfall by {wf.by}</caption>
        <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th scope="col" className="sticky left-0 z-10 min-w-44 bg-surface-sunken px-4 py-2.5">
              {wf.by === "customer" ? "Customer" : "Item"}
            </th>
            {showPastDue && (
              <th scope="col" className="whitespace-nowrap px-3 py-2.5 text-right" title="Due before this month and not yet posted — the next recognition run posts it">
                Past due
              </th>
            )}
            {wf.months.map((m) => (
              <th key={m} scope="col" className="whitespace-nowrap px-3 py-2.5 text-right">
                {monthLabel(m)}
              </th>
            ))}
            <th scope="col" className="whitespace-nowrap px-3 py-2.5 text-right">Later</th>
            {showUnscheduled && (
              <th scope="col" className="whitespace-nowrap px-3 py-2.5 text-right" title="Milestone revenue: recognised in the month its delivery is done">
                On delivery
              </th>
            )}
            <th scope="col" className="whitespace-nowrap px-4 py-2.5 text-right">Total deferred</th>
          </tr>
        </thead>
        <tbody>
          {wf.rows.map((r) => (
            <tr key={r.key} className="border-b border-line hover:bg-surface-sunken">
              <th scope="row" className="sticky left-0 z-10 bg-surface px-4 py-1.5 text-left font-normal">
                {wf.by === "customer" ? (
                  <Link href={`/accounting/revenue?customer=${encodeURIComponent(r.key)}`} className="text-text hover:underline">
                    {r.label}
                  </Link>
                ) : r.key !== "none" ? (
                  <Link href={`/accounting/revenue?item=${encodeURIComponent(r.key)}`} className="text-text hover:underline">
                    {r.label}
                  </Link>
                ) : (
                  <span className="text-text">{r.label}</span>
                )}
                <div className="text-xs text-subtle">
                  {r.schedules} schedule{r.schedules === 1 ? "" : "s"}
                  {r.pending > 0 ? ` · ${r.pending} pending approval` : ""}
                </div>
              </th>
              {cells(r)}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-line-strong">
            <th scope="row" className="sticky left-0 z-10 bg-surface px-4 py-2 text-left font-semibold text-text">
              Total
              <div className="text-xs font-normal text-subtle">Remaining performance obligation</div>
            </th>
            {cells(wf.totals, true)}
          </tr>
        </tfoot>
      </table>
    </Card>
  );
}

import Link from "next/link";
import type { RollForward } from "@/lib/revenue/reports";
import { dayLabel, firstDay, lastDay, monthLabel } from "@/lib/revenue/periods";
import { formatCurrency } from "@/lib/utils";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

type TieOut = { schedules: number; ledger: number; difference: number };

/**
 * The deferred revenue roll-forward for a month (spec §3.8): where Deferred Revenue started, what
 * invoices added, what was recognised, credited, opened and cancelled, and where it ended — beside the
 * ledger's own balance at the month end.
 *
 * The two are built from the same ledger lines, so they differ only when something posted to Deferred
 * Revenue that is not the engine's — almost always a hand-written journal. That is said in red, in
 * words, with the account's ledger a click away, because a difference nobody can find is one nobody
 * clears.
 */
export function RollForwardPanel({
  roll,
  deferredAccountId,
}: {
  roll: RollForward & { tieOut: TieOut };
  deferredAccountId: string | null;
}) {
  const start = dayLabel(firstDay(roll.month));
  const end = dayLabel(lastDay(roll.month));
  const lines: { label: string; hint: string; value: number; strong?: boolean }[] = [
    { label: `Opening balance, ${start}`, hint: "What the schedules held when the month began", value: roll.opening, strong: true },
    { label: "+ Deferred from invoices", hint: `Invoices issued in ${monthLabel(roll.month)} with revenue still to earn`, value: roll.deferredFromInvoices },
    { label: "− Recognised", hint: "Moved into Sales by recognition runs, and schedules cancelled or re-measured by hand", value: roll.recognised },
    { label: "− Credited", hint: "Taken off by credit notes, net of credit notes cancelled", value: roll.credited },
    { label: "± Opening adjustments", hint: "Put in by “Open deferred revenue”", value: roll.openingAdjustments },
    { label: "− Invoices cancelled", hint: "What cancelled invoices still held", value: roll.cancelled },
  ];
  const ledgerHref = deferredAccountId
    ? `/accounting/ledger/${deferredAccountId}?${roll.unexplained.inMonth !== 0 ? `from=${firstDay(roll.month)}&` : ""}to=${lastDay(roll.month)}`
    : null;
  const agrees = roll.difference === 0;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
      <Card className="overflow-x-auto p-0 lg:col-span-3">
        <table className="w-full min-w-[320px] text-sm">
          <caption className="sr-only">Deferred revenue roll-forward for {monthLabel(roll.month)}</caption>
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th scope="col" className="px-4 py-2.5">{monthLabel(roll.month)}</th>
              <th scope="col" className="px-4 py-2.5 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.label} className="border-b border-line">
                <td className="px-4 py-2">
                  <div className={line.strong ? "font-medium text-text" : "text-text"}>{line.label}</div>
                  <div className="text-xs text-subtle">{line.hint}</div>
                </td>
                <td className={`whitespace-nowrap px-4 py-2 text-right tabular-nums ${line.strong ? "font-semibold text-text" : "text-text"}`}>
                  {formatCurrency(line.value)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-line-strong">
              <td className="px-4 py-2.5 font-semibold text-text">= Closing balance, {end}</td>
              <td className="whitespace-nowrap px-4 py-2.5 text-right font-semibold tabular-nums text-text">{formatCurrency(roll.closing)}</td>
            </tr>
          </tfoot>
        </table>
      </Card>

      <div className="space-y-4 lg:col-span-2">
        <Card>
          <CardHeader className="text-sm font-medium text-text">The ledger</CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-muted">Deferred Revenue at {end}</span>
              <span className="font-semibold tabular-nums text-text">{formatCurrency(roll.ledger)}</span>
            </div>
            {agrees ? (
              <p className="rounded-lg border border-success/40 bg-success-bg px-3 py-2 text-success">
                The roll-forward agrees with the ledger to the paisa.
              </p>
            ) : (
              <div role="alert" className="rounded-lg border border-danger/40 bg-danger-bg px-3 py-2 text-danger">
                <p className="font-medium">
                  Difference {formatCurrency(roll.difference)}
                </p>
                <p className="mt-1">
                  The ledger holds {formatCurrency(roll.ledger)} in Deferred Revenue, but the revenue schedules&apos; own entries
                  account for {formatCurrency(roll.closing)}. Something else was posted to Deferred Revenue — usually a
                  journal written by hand — and the schedules know nothing about it.
                  {roll.unexplained.inMonth !== 0 && ` ${formatCurrency(roll.unexplained.inMonth)} of it was posted in ${monthLabel(roll.month)}`}
                  {roll.unexplained.inMonth !== 0 && roll.unexplained.before !== 0 ? " and" : roll.unexplained.inMonth !== 0 ? "." : ""}
                  {roll.unexplained.before !== 0 && ` ${formatCurrency(roll.unexplained.before)} before ${start}.`}
                </p>
                <p className="mt-1">
                  Find the entry and reverse it, or post it through a schedule instead.
                  {ledgerHref && (
                    <>
                      {" "}
                      <Link href={ledgerHref} className="font-medium underline">
                        Open the Deferred Revenue ledger
                      </Link>
                    </>
                  )}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="text-sm font-medium text-text">Today</CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-muted">Live schedules still to recognise</span>
              <span className="tabular-nums text-text">{formatCurrency(roll.tieOut.schedules)}</span>
            </div>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-muted">Deferred Revenue in the ledger</span>
              <span className="tabular-nums text-text">{formatCurrency(roll.tieOut.ledger)}</span>
            </div>
            {roll.tieOut.difference === 0 ? (
              <p className="text-xs text-success">They agree.</p>
            ) : (
              <p className="text-xs font-medium text-danger">Out by {formatCurrency(roll.tieOut.difference)} — see the difference above.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

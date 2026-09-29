"use client";

import { useId, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { revenueRun } from "@/actions/revenue";
import type { RecognitionResult } from "@/lib/revenue/run";
import { monthLabel } from "@/lib/revenue/periods";
import { formatCurrency } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Select } from "@/components/ui/input";

/**
 * "Recognise through <month>" (spec §3.5): posts every due month of every active schedule up to the
 * month chosen — one entry per month, a closed month's revenue caught up in the first open one — and
 * says what it posted, or why it posted nothing.
 *
 * Only completed months are offered: revenue for a month still under way isn't earned yet. The
 * nightly job does the same on its own when automatic posting is on; running it here as well is safe,
 * because a month is never posted twice.
 */
export function RecogniseThrough({ months }: { months: { value: string; label: string }[] }) {
  const router = useRouter();
  const selectId = useId();
  const [through, setThrough] = useState(months[0]?.value ?? "");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ through: string; data: RecognitionResult } | null>(null);

  function run() {
    setError(null);
    setResult(null);
    startTransition(async () => {
      const outcome = await revenueRun({ throughMonth: through });
      if (!outcome.ok) {
        setError(outcome.error);
        return;
      }
      setResult({ through, data: outcome.data });
      router.refresh();
    });
  }

  const posted = result?.data.months ?? [];
  const total = posted.reduce((t, m) => t + m.amount, 0);

  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Recognise revenue</CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted">
          Moves every month that has come due from Deferred Revenue to Sales, one journal entry per month. A month
          whose books are closed is caught up in the first open month. Running it twice posts nothing twice.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <label htmlFor={selectId} className="text-[13px] font-medium text-muted">
              Recognise through
            </label>
            <Select id={selectId} value={through} onChange={(e) => setThrough(e.target.value)} className="w-36">
              {months.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </Select>
          </div>
          <Button type="button" disabled={pending || !through} onClick={run}>
            {pending ? "Recognising…" : `Recognise through ${through ? monthLabel(through) : "…"}`}
          </Button>
        </div>

        {error && (
          <p role="alert" className="rounded-lg border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}

        {result && (
          <div role="status" className="space-y-2">
            {posted.length > 0 ? (
              <>
                <p className="text-sm text-success">
                  Posted {formatCurrency(total)} in {posted.length} entr{posted.length === 1 ? "y" : "ies"} through{" "}
                  {monthLabel(result.through)}
                  {result.data.completed > 0 ? ` — ${result.data.completed} schedule${result.data.completed === 1 ? "" : "s"} now complete` : ""}.
                </p>
                <div className="overflow-x-auto rounded-base border border-line">
                  <table className="w-full min-w-[420px] text-sm">
                    <thead className="bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                      <tr>
                        <th scope="col" className="px-3 py-2">Month</th>
                        <th scope="col" className="px-3 py-2">Entry</th>
                        <th scope="col" className="px-3 py-2 text-right">Schedules</th>
                        <th scope="col" className="px-3 py-2 text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {posted.map((m) => (
                        <tr key={m.entryId} className="border-t border-line">
                          <td className="px-3 py-1.5 text-text">
                            {monthLabel(m.month)}
                            {m.catchUpFrom.length > 0 && (
                              <div className="text-xs text-warning">Catch-up for {m.catchUpFrom.map(monthLabel).join(", ")}</div>
                            )}
                          </td>
                          <td className="px-3 py-1.5">
                            <Link href={`/accounting/journal?q=${encodeURIComponent(m.entryNumber)}`} className="font-mono text-xs text-brand hover:underline">
                              {m.entryNumber}
                            </Link>
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-muted">{m.schedules}</td>
                          <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-text">{formatCurrency(m.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted">
                Nothing was due through {monthLabel(result.through)}: every active schedule&apos;s months up to then are
                already posted.
              </p>
            )}
            {result.data.skipped.length > 0 && (
              <div className="rounded-lg border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-warning">
                <div className="font-medium">Left for later</div>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  {result.data.skipped.map((s, i) => (
                    <li key={`${s.scheduleId ?? ""}-${s.month ?? ""}-${i}`}>
                      {s.month ? `${monthLabel(s.month)}: ` : ""}
                      {s.reason}
                      {s.scheduleId && (
                        <>
                          {" "}
                          <Link href={`/accounting/revenue/${s.scheduleId}`} className="underline">
                            Schedule
                          </Link>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Play } from "lucide-react";
import type { listPayrollRuns } from "@/actions/payroll";
import { runPayroll } from "@/actions/payroll";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { MONTH_NAMES, monthLabel } from "@/lib/hr/calendar";
import { indiaClock } from "@/lib/time/zone";

type Run = Awaited<ReturnType<typeof listPayrollRuns>>[number];

const STATUS_TONE: Record<string, "default" | "green" | "amber" | "blue"> = {
  DRAFT: "amber",
  LOCKED: "blue",
  PAID: "green",
};

export function PayrollRuns({ runs }: { runs: Run[] }) {
  const router = useRouter();
  // Payroll is India's (statutory), so this month is India's in every workspace. UTC's calendar kept
  // last month until 05:30 on the 1st.
  const now = indiaClock.parts(new Date());
  const [month, setMonth] = useState(now.month + 1);
  const [year, setYear] = useState(now.year);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ count: number; skipped: string[] } | null>(null);

  function run() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await runPayroll({ month, year });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice({ count: result.data.count, skipped: result.data.skipped });
      router.refresh();
      router.push(`/people/payroll/${result.data.id}`);
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="text-sm font-medium text-text">Run a month</CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            {/* The card heading says "Run a month"; neither dropdown has a caption of its own. */}
            <Select
              aria-label="Month"
              value={String(month)}
              onChange={(e) => setMonth(Number(e.target.value))}
              className="w-40"
            >
              {MONTH_NAMES.map((m, i) => (
                <option key={m} value={i + 1}>
                  {m}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Year"
              value={String(year)}
              onChange={(e) => setYear(Number(e.target.value))}
              className="w-28"
            >
              {[year - 1, year, year + 1].map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </Select>
            <Button disabled={pending} onClick={run}>
              <Play className="mr-1.5 h-3.5 w-3.5" />
              {pending ? "Calculating…" : "Calculate"}
            </Button>
          </div>

          <p className="text-xs text-subtle">
            Reads each person&apos;s salary structure and their unpaid days from attendance. Safe to re-run while the
            month is a draft — locking is what makes it final.
          </p>

          {error && <p className="text-sm text-danger">{error}</p>}
          {notice && (
            <div className="rounded-base border border-line bg-surface-sunken px-3 py-2 text-sm">
              <span className="text-text">{notice.count} payslip(s) calculated.</span>
              {notice.skipped.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-xs text-warning">
                  {notice.skipped.map((s) => (
                    <li key={s}>Skipped: {s}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="overflow-hidden p-0">
        <CardHeader className="text-sm font-medium text-text">Runs</CardHeader>
        <table className="w-full text-sm">
          <thead className="border-y border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">Month</th>
              <th className="px-4 py-2.5 text-right">Payslips</th>
              <th className="px-4 py-2.5">Status</th>
              <th className="px-4 py-2.5">Locked</th>
              <th className="px-4 py-2.5">Paid</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                <td className="px-4 py-2.5">
                  <Link href={`/people/payroll/${r.id}`} className="font-medium text-text hover:underline">
                    {monthLabel(r.month, r.year)}
                  </Link>
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-muted">{r._count.payslips}</td>
                <td className="px-4 py-2.5">
                  <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
                </td>
                <td className="px-4 py-2.5 text-xs text-muted">{r.lockedAt ? indiaClock.date(r.lockedAt) : "—"}</td>
                <td className="px-4 py-2.5 text-xs text-muted">{r.paidAt ? indiaClock.date(r.paidAt) : "—"}</td>
              </tr>
            ))}
            {runs.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-subtle">
                  No payroll has been run yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

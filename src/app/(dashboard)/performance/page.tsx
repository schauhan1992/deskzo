import Link from "next/link";
import { Trophy } from "lucide-react";
import { getUserPerformance, canViewPerformance } from "@/actions/performance";
import { Card, Badge } from "@/components/ui/card";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { formatCurrency } from "@/lib/utils";

function formatActiveTime(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (hours === 0 && minutes === 0) return "—";
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

export default async function PerformancePage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const allowed = await canViewPerformance();
  if (!allowed) {
    return (
      <div className="max-w-md">
        <h1 className="text-xl font-semibold text-text">Performance</h1>
        <p className="mt-2 text-sm text-muted">You don&apos;t have permission to view team performance.</p>
        <Link href="/wins/most-active" className="mt-3 inline-flex items-center gap-1.5 text-sm text-brand hover:underline">
          <Trophy className="h-4 w-4" aria-hidden /> Most active of the fortnight
        </Link>
      </div>
    );
  }

  const params = await searchParams;
  const rows = await getUserPerformance({ from: params.from, to: params.to });
  // Shown where the workspace has orders: what each purchaser saved against sales's distributor prices.
  const showSavings = rows.some((r) => r.purchaseSavings !== null);

  return (
    <div>
      <div>
        <h1 className="text-xl font-semibold text-text">Performance</h1>
        <p className="mt-1 text-sm text-muted">
          Active time, records created/edited, and ticket resolution speed, per user. Tickets open is always a
          live snapshot; everything else is scoped to the date range below.
        </p>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <DateRangePicker fromParam="from" toParam="to" label="Period" />
        <Link
          href="/wins/most-active"
          className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm text-text hover:bg-surface-sunken"
        >
          <Trophy className="h-4 w-4" style={{ color: "#f59e0b" }} aria-hidden /> Most active of the fortnight
        </Link>
      </div>

      <Card className="mt-6 overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">User</th>
              <th className="px-4 py-2.5">Role</th>
              <th className="px-4 py-2.5">Active time</th>
              <th className="px-4 py-2.5">Records created</th>
              <th className="px-4 py-2.5">Records edited</th>
              <th className="px-4 py-2.5">Leads won</th>
              <th className="px-4 py-2.5">Tickets open</th>
              <th className="px-4 py-2.5">Tickets resolved</th>
              <th className="px-4 py-2.5">Avg resolution</th>
              <th className="px-4 py-2.5">SLA met</th>
              {showSavings && (
                <th className="px-4 py-2.5">
                  <Link href="/orders/savings" className="hover:underline">
                    Purchase savings
                  </Link>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.userId} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                <td className="px-4 py-2.5">
                  <span className="font-medium text-text">{r.name}</span>
                  {!r.active && (
                    <Badge tone="default" className="ml-2">
                      Inactive
                    </Badge>
                  )}
                </td>
                <td className="px-4 py-2.5 text-muted">{r.role}</td>
                <td className="px-4 py-2.5 text-muted">{formatActiveTime(r.activeSeconds)}</td>
                <td className="px-4 py-2.5 text-muted">{r.recordsCreated}</td>
                <td className="px-4 py-2.5 text-muted">{r.recordsEdited}</td>
                <td className="px-4 py-2.5 text-muted">{r.leadsWon}</td>
                <td className="px-4 py-2.5 text-muted">{r.ticketsOpen}</td>
                <td className="px-4 py-2.5 text-muted">{r.ticketsResolved}</td>
                <td className="px-4 py-2.5 text-muted">
                  {r.avgResolutionHours !== null ? `${r.avgResolutionHours.toFixed(1)}h` : "—"}
                </td>
                <td className="px-4 py-2.5">
                  {r.slaMetPercent !== null ? (
                    <Badge tone={r.slaMetPercent >= 90 ? "green" : r.slaMetPercent >= 70 ? "amber" : "red"}>
                      {r.slaMetPercent}%
                    </Badge>
                  ) : (
                    <span className="text-subtle">—</span>
                  )}
                </td>
                {showSavings && (
                  <td className={`px-4 py-2.5 ${(r.purchaseSavings ?? 0) < 0 ? "text-danger" : "text-muted"}`}>
                    {r.purchaseSavings ? formatCurrency(r.purchaseSavings) : "—"}
                  </td>
                )}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={showSavings ? 11 : 10} className="px-4 py-8 text-center text-subtle">
                  No users found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

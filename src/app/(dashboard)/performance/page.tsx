import Link from "next/link";
import { notFound } from "next/navigation";
import { Trophy } from "lucide-react";
import { getUserPerformance, canViewPerformance } from "@/actions/performance";
import { Card, Badge } from "@/components/ui/card";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { formatCurrency } from "@/lib/utils";
import { Avatar } from "@/components/ui/avatar";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { workspaceClock } from "@/lib/time/workspace";
import { taskXpLeaders } from "@/lib/tasks/leaderboard";

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
  if (!allowed) notFound();

  const params = await searchParams;
  const rows = await getUserPerformance({ from: params.from, to: params.to });
  // Shown where the workspace has orders: what each purchaser saved against sales's distributor prices.
  const showSavings = rows.some((r) => r.purchaseSavings !== null);
  // Task XP (owner, 16 Oct 2026): borrowed from Tasks, so only where the plan has it and it's on.
  const leaders = (await moduleAvailableForTenant("tasks"))
    ? await taskXpLeaders((await workspaceClock()).dayRange(params.from, params.to))
    : null;

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

      {leaders && (
        <Card className="mt-6 p-4">
          <div className="mb-3 flex items-center gap-2">
            <Trophy className="h-4 w-4 text-warning" aria-hidden />
            <h2 className="text-sm font-medium text-text">Task XP</h2>
            <span className="text-xs text-muted">Earned by finishing tasks on time, in this period.</span>
          </div>
          {leaders.length === 0 ? (
            <p className="text-sm text-subtle">No XP earned yet — set XP on tasks, and it&apos;s earned when they&apos;re done by their due date.</p>
          ) : (
            <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {leaders.map((l, i) => (
                <li key={l.userId} className="flex items-center gap-3 rounded-base border border-line px-3 py-2">
                  <span className={`w-6 text-center text-sm font-semibold ${i === 0 ? "text-warning" : "text-muted"}`}>{i + 1}</span>
                  <Avatar user={{ id: l.userId, name: l.name, photoUpdatedAt: l.photoUpdatedAt }} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-text">{l.name}</span>
                    <span className="block text-xs text-muted">
                      {l.tasks} task{l.tasks === 1 ? "" : "s"} on time
                      {l.badges.length > 0 && ` · ${l.badges.slice(0, 3).join(", ")}${l.badges.length > 3 ? "…" : ""}`}
                    </span>
                  </span>
                  <span className="text-sm font-semibold tabular-nums text-success">{l.xp} XP</span>
                </li>
              ))}
            </ol>
          )}
        </Card>
      )}

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

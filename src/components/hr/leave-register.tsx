import Link from "next/link";
import type { allLeaveRequests } from "@/actions/leave";
import { Badge, Card } from "@/components/ui/card";
import { formatDate } from "@/lib/utils";
import { leaveStatusTone } from "@/lib/validation/hr";

type Row = Awaited<ReturnType<typeof allLeaveRequests>>["rows"][number];

/**
 * Everybody's leave, filterable.
 *
 * The view that was missing: until now leave could only be read one person at a time or as an
 * approval queue, so "who was off in August" and "how much sick leave are we losing" had no
 * answer at all.
 */
export function LeaveRegister({ rows, total }: { rows: Row[]; total: number }) {
  if (rows.length === 0) {
    return (
      <Card className="px-4 py-12 text-center text-sm text-subtle">
        No leave matches this filter.
      </Card>
    );
  }

  const days = rows.reduce((a, r) => a + Number(r.days), 0);

  return (
    <Card className="overflow-hidden p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-xs text-muted">
        <span>
          {rows.length === total ? `${total} request(s)` : `${rows.length} of ${total} request(s)`} ·{" "}
          {days} day(s) on this page
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-y border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">Who</th>
              <th className="px-4 py-2.5">Type</th>
              <th className="px-4 py-2.5">From</th>
              <th className="px-4 py-2.5">To</th>
              <th className="px-4 py-2.5 text-right">Days</th>
              <th className="px-4 py-2.5">Reason</th>
              <th className="px-4 py-2.5">Status</th>
              <th className="px-4 py-2.5">Decided by</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                <td className="px-4 py-2.5">
                  <Link href={`/people/${r.user.id}`} className="text-text hover:underline">
                    {r.user.name}
                  </Link>
                </td>
                <td className="px-4 py-2.5">
                  <Badge tone={r.type.paid ? "default" : "amber"}>{r.type.code}</Badge>
                </td>
                <td className="px-4 py-2.5 text-muted">{formatDate(r.fromDate)}</td>
                <td className="px-4 py-2.5 text-muted">{formatDate(r.toDate)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-text">{Number(r.days)}</td>
                <td className="max-w-xs truncate px-4 py-2.5 text-muted" title={r.reason}>
                  {r.reason}
                </td>
                <td className="px-4 py-2.5">
                  <Badge tone={leaveStatusTone[r.status]}>{r.status}</Badge>
                </td>
                <td className="px-4 py-2.5 text-xs text-subtle">{r.approver?.name ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

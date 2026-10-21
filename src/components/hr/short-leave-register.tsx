import Link from "next/link";
import type { allShortLeaves } from "@/actions/short-leave";
import { Badge, Card } from "@/components/ui/card";
import { formatCalendarDay } from "@/lib/time/zone";
import { leaveStatusTone } from "@/lib/validation/hr";
import { durationWords, spanWords } from "@/lib/hr/short-leave-rules";
import { personPath } from "@/lib/record-links";

type Row = NonNullable<Awaited<ReturnType<typeof allShortLeaves>>>["rows"][number];

/**
 * Everybody's short leave the viewer may see, filterable (owner, 21 Oct 2026) — the register leave by
 * the day already had, so "who stepped out this month, and for how long" has an answer.
 */
export function ShortLeaveRegister({ rows, total }: { rows: Row[]; total: number }) {
  if (rows.length === 0) {
    return <Card className="px-4 py-12 text-center text-sm text-subtle">No short leave matches this filter.</Card>;
  }
  const minutes = rows.filter((r) => r.status === "APPROVED").reduce((a, r) => a + (r.toMinute - r.fromMinute), 0);

  return (
    <Card className="overflow-hidden p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-xs text-muted">
        <span>
          {rows.length === total ? `${total} request(s)` : `${rows.length} of ${total} request(s)`} · {durationWords(minutes)} approved on this page
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-y border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">Who</th>
              <th className="px-4 py-2.5">Day</th>
              <th className="px-4 py-2.5">Time</th>
              <th className="px-4 py-2.5">Reason</th>
              <th className="px-4 py-2.5">Status</th>
              <th className="px-4 py-2.5">Decided by</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-line align-top last:border-0">
                <td className="px-4 py-2.5">
                  <Link href={personPath(r.user.userSeq)} className="text-text hover:underline">
                    {r.user.name}
                  </Link>
                </td>
                {/* The day it is for, held as a calendar date. */}
                <td className="px-4 py-2.5 text-muted">{formatCalendarDay(r.date)}</td>
                <td className="px-4 py-2.5 text-muted">
                  {spanWords(r)}
                  <div className="text-xs text-subtle">{durationWords(r.toMinute - r.fromMinute)}</div>
                </td>
                <td className="max-w-xs px-4 py-2.5 text-muted">{r.reason}</td>
                <td className="px-4 py-2.5">
                  <Badge tone={leaveStatusTone[r.status] ?? "default"}>{r.status.charAt(0) + r.status.slice(1).toLowerCase()}</Badge>
                  {r.decisionNote && <div className="mt-0.5 max-w-[14rem] text-xs text-subtle">{r.decisionNote}</div>}
                </td>
                <td className="px-4 py-2.5 text-muted">{r.approver?.name ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

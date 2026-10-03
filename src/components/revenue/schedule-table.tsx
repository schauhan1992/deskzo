import Link from "next/link";
import type { ScheduleListRow } from "@/lib/revenue/reports";
import type { ScheduleApprovalVerdict } from "@/lib/revenue/schedules";
import { monthLabel } from "@/lib/revenue/periods";
import { formatCurrency } from "@/lib/utils";
import { companyPath } from "@/lib/record-links";
import { Badge, Card } from "@/components/ui/card";
import { Amount } from "@/components/accounting/report-chrome";
import { ApproveButton } from "@/components/revenue/approve-button";
import { KIND_LABELS, STATUS_LABELS, STATUS_TONES, periodText } from "@/components/revenue/labels";

/** Why somebody sees a pending schedule without an Approve button. */
const WAITING: Record<string, string> = {
  "own-schedule": "Yours — somebody else approves it",
  "no-permission": "Waiting for a manager",
  "not-pending": "—",
};

/**
 * The schedule list (spec §3.8): one row per deferring invoice line, what it is worth, what has been
 * recognised and what is still in Deferred Revenue, and the month it recognises next.
 *
 * Wide, so it scrolls sideways inside its card on a phone rather than pushing the page.
 * With `review`, a last column approves each pending schedule for whoever the rule allows.
 */
export function ScheduleTable({
  rows,
  next,
  review,
  empty,
}: {
  rows: ScheduleListRow[];
  /** Each row's next unposted month and its amount. */
  next: Record<string, { month: string; amount: number }>;
  /** What the viewer may do with each pending schedule, by id — the review queue. */
  review?: Record<string, ScheduleApprovalVerdict>;
  /** What to say when there are no rows. */
  empty: React.ReactNode;
}) {
  // Said in a card of its own: inside a table this wide it would sit off-screen on a phone.
  if (rows.length === 0) {
    return <Card className="px-6 py-10 text-center text-sm text-muted">{empty}</Card>;
  }
  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full min-w-[1040px] text-sm">
        <caption className="sr-only">Revenue schedules</caption>
        <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th scope="col" className="px-4 py-2.5">Customer</th>
            <th scope="col" className="px-3 py-2.5">Document</th>
            <th scope="col" className="px-3 py-2.5">Line</th>
            <th scope="col" className="px-3 py-2.5">Kind</th>
            <th scope="col" className="px-3 py-2.5">Period</th>
            <th scope="col" className="px-3 py-2.5 text-right">Amount</th>
            <th scope="col" className="px-3 py-2.5 text-right">Recognised</th>
            <th scope="col" className="px-3 py-2.5 text-right">Remaining</th>
            <th scope="col" className="px-3 py-2.5">Next</th>
            <th scope="col" className="px-3 py-2.5">Status</th>
            {review && <th scope="col" className="px-4 py-2.5">Approval</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const upcoming = next[row.id];
            const verdict = review?.[row.id];
            return (
              <tr key={row.id} className="border-b border-line align-top last:border-0 hover:bg-surface-sunken">
                <td className="px-4 py-2">
                  <Link href={companyPath(row.companySeq)} className="text-text hover:underline">
                    {row.companyName}
                  </Link>
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {row.documentId ? (
                    <Link href={`/documents/${row.documentId}`} className="font-mono text-xs text-brand hover:underline">
                      {row.docNumber}
                    </Link>
                  ) : (
                    <span className="text-subtle">—</span>
                  )}
                  {row.opening && (
                    <Badge tone="default" className="ml-1.5">
                      Opening
                    </Badge>
                  )}
                </td>
                <td className="px-3 py-2">
                  <Link href={`/accounting/revenue/${row.id}`} className="font-medium text-text hover:underline">
                    {row.lineName ?? row.itemName ?? "Schedule"}
                  </Link>
                  {row.itemName && row.lineName && row.itemName !== row.lineName && (
                    <div className="text-xs text-subtle">{row.itemName}</div>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-muted">{KIND_LABELS[row.kind]}</td>
                <td className="whitespace-nowrap px-3 py-2 text-muted">{periodText(row.startDate, row.endDate)}</td>
                <td className="px-3 py-2 text-right">
                  <Amount value={row.amount} />
                  {row.credited > 0 && (
                    <div className="whitespace-nowrap text-xs text-subtle">{formatCurrency(row.credited)} credited</div>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <Amount value={row.recognised} muted />
                </td>
                <td className="px-3 py-2 text-right">
                  <Amount value={row.remaining} />
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {upcoming ? (
                    <>
                      <div className="text-text">{monthLabel(upcoming.month)}</div>
                      <div className="text-xs tabular-nums text-muted">{formatCurrency(upcoming.amount)}</div>
                    </>
                  ) : row.kind === "MILESTONE" && row.remaining > 0 ? (
                    <span className="text-xs text-muted">On delivery</span>
                  ) : (
                    <span className="text-subtle">—</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  <Badge tone={STATUS_TONES[row.status]}>{STATUS_LABELS[row.status]}</Badge>
                </td>
                {review && (
                  <td className="px-4 py-2">
                    {verdict?.may ? (
                      <ApproveButton id={row.id} own={verdict.reason === "super-admin-own"} />
                    ) : (
                      <span className="text-xs text-muted">{WAITING[verdict?.reason ?? "no-permission"] ?? "—"}</span>
                    )}
                    <div className="mt-1 text-xs text-subtle">Made by {row.createdByName}</div>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

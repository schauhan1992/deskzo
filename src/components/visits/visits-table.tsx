import Link from "next/link";
import type { VisitPurpose, VisitStatus } from "@prisma/client";
import { Badge, Card } from "@/components/ui/card";
import { formatIstDate, formatIstTime } from "@/lib/india-time";
import { formatVisitId, visitPurposeLabels, visitStatusLabels, visitStatusTone, visitDuration, formatDuration } from "@/lib/visits";

type VisitRow = {
  id: string;
  visitSeq: number;
  purpose: VisitPurpose;
  status: VisitStatus;
  scheduledFor: Date | string;
  checkInAt: Date | string | null;
  checkOutAt: Date | string | null;
  agenda: string | null;
  company: { id: string; name: string };
  contact: { id: string; name: string } | null;
  user: { id: string; name: string };
  _count: { expenses: number };
};

/** Read-only like the Orders table: a visit is worked from its own page, not ticked off in bulk. */
export function VisitsTable({ visits }: { visits: VisitRow[] }) {
  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full text-sm">
        <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="px-4 py-2.5">Visit</th>
            <th className="px-4 py-2.5">Status</th>
            <th className="px-4 py-2.5">Company</th>
            <th className="px-4 py-2.5">Purpose</th>
            <th className="px-4 py-2.5">Scheduled</th>
            <th className="px-4 py-2.5">On site</th>
            <th className="px-4 py-2.5">Expenses</th>
            <th className="px-4 py-2.5">Rep</th>
          </tr>
        </thead>
        <tbody>
          {visits.map((v) => (
            <tr key={v.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
              <td className="px-4 py-2.5 font-mono text-xs">
                <Link href={`/visits/${v.id}`} className="text-text hover:underline">
                  {formatVisitId(v.visitSeq)}
                </Link>
              </td>
              <td className="px-4 py-2.5">
                <Badge tone={visitStatusTone[v.status]}>{visitStatusLabels[v.status]}</Badge>
              </td>
              <td className="px-4 py-2.5">
                <Link href={`/companies/${v.company.id}`} className="text-text hover:underline">
                  {v.company.name}
                </Link>
                {v.contact && <div className="text-xs text-subtle">{v.contact.name}</div>}
              </td>
              <td className="px-4 py-2.5 text-muted">
                {visitPurposeLabels[v.purpose]}
                {v.agenda && <div className="max-w-xs truncate text-xs text-subtle">{v.agenda}</div>}
              </td>
              <td className="px-4 py-2.5 text-muted">
                {formatIstDate(v.scheduledFor)}
                <div className="text-xs text-subtle">{formatIstTime(v.scheduledFor)}</div>
              </td>
              <td className="px-4 py-2.5 text-muted">{formatDuration(visitDuration(v.checkInAt, v.checkOutAt))}</td>
              <td className="px-4 py-2.5 text-muted">
                {v._count.expenses > 0 ? <Badge tone="brand">{v._count.expenses}</Badge> : <span className="text-subtle">—</span>}
              </td>
              <td className="px-4 py-2.5 text-muted">{v.user.name}</td>
            </tr>
          ))}
          {visits.length === 0 && (
            <tr>
              <td colSpan={8} className="px-4 py-10 text-center text-subtle">
                No visits match this filter.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Card>
  );
}

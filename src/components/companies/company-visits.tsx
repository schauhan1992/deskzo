import Link from "next/link";
import { listCompanyVisits } from "@/actions/visit";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import {
  formatVisitId,
  visitPurposeLabels,
  visitStatusLabels,
  visitStatusTone,
  visitDuration,
  formatDuration,
} from "@/lib/visits";
import { formatIstDate } from "@/lib/india-time";

type Visit = Awaited<ReturnType<typeof listCompanyVisits>>[number];

export function CompanyVisits({
  companyId,
  visits,
  expenseTotal,
}: {
  companyId: string;
  visits: Visit[];
  /** Everything claimed against this account, so the tab answers "what did it cost to call on them". */
  expenseTotal: number;
}) {
  const completed = visits.filter((v) => v.status === "COMPLETED").length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {visits.length === 0
            ? "Nobody has visited this company yet."
            : `${visits.length} visit(s) · ${completed} completed · ${formatCurrency(expenseTotal)} claimed`}
        </p>
        <Link href={`/visits/new?companyId=${companyId}`}>
          <Button size="sm">Plan visit</Button>
        </Link>
      </div>

      {visits.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2">Visit</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Purpose</th>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">On site</th>
                <th className="px-3 py-2">Rep</th>
              </tr>
            </thead>
            <tbody>
              {visits.map((v) => (
                <tr key={v.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                  <td className="px-3 py-2 font-mono text-xs">
                    <Link href={`/visits/${v.id}`} className="text-text hover:underline">
                      {formatVisitId(v.visitSeq)}
                    </Link>
                    {v.contact && <div className="font-sans text-xs text-subtle">{v.contact.name}</div>}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={visitStatusTone[v.status]}>{visitStatusLabels[v.status]}</Badge>
                  </td>
                  <td className="px-3 py-2 text-muted">{visitPurposeLabels[v.purpose]}</td>
                  <td className="px-3 py-2 text-muted">{formatIstDate(v.scheduledFor)}</td>
                  <td className="px-3 py-2 text-muted">{formatDuration(visitDuration(v.checkInAt, v.checkOutAt))}</td>
                  <td className="px-3 py-2 text-muted">{v.user.name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

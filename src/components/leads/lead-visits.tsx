import Link from "next/link";
import { MapPin } from "lucide-react";
import type { listLeadVisits } from "@/actions/visit";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  formatDuration,
  formatVisitId,
  visitDuration,
  visitPurposeLabels,
  visitStatusLabels,
  visitStatusTone,
} from "@/lib/visits";
import { workspaceClock } from "@/lib/time/workspace";
import { visitPath } from "@/lib/record-links";

type Visit = Awaited<ReturnType<typeof listLeadVisits>>[number];

/**
 * The visits made for this deal specifically.
 *
 * Narrower than the company's visit tab on purpose: an account may have been called on for years,
 * but what matters when you open a lead is who went out for *this* requirement and what came back.
 * The outcome is shown inline because a visit with no write-up is the common failure, and a blank
 * line where the outcome should be is the clearest way to say so.
 */
export async function LeadVisits({
  visits,
  leadId,
  companyId,
}: {
  visits: Visit[];
  leadId: string;
  companyId: string;
}) {
  const planHref = `/visits/new?companyId=${companyId}&leadId=${leadId}`;
  const clock = await workspaceClock();

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-text">
          Field visits
          {visits.length > 0 && <span className="ml-1.5 text-xs font-normal text-subtle">{visits.length}</span>}
        </span>
        {visits.length > 0 && (
          <Link href={planHref}>
            <Button size="sm" variant="secondary">
              + Visit
            </Button>
          </Link>
        )}
      </CardHeader>

      <CardContent className={visits.length === 0 ? undefined : "space-y-3"}>
        {visits.length === 0 ? (
          <div className="py-6 text-center">
            <MapPin className="mx-auto h-6 w-6 text-subtle" />
            <p className="mt-2 text-sm text-muted">No visits planned for this deal.</p>
            <Link href={planHref} className="mt-3 inline-block">
              <Button size="sm">Plan a visit</Button>
            </Link>
          </div>
        ) : (
          visits.map((v) => (
            <div key={v.id} className="border-b border-line pb-3 last:border-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={visitPath(v.visitSeq)} className="font-mono text-xs text-text hover:underline">
                  {formatVisitId(v.visitSeq)}
                </Link>
                <Badge tone={visitStatusTone[v.status]}>{visitStatusLabels[v.status]}</Badge>
                <span className="text-xs text-subtle">
                  {visitPurposeLabels[v.purpose]} · {clock.date(v.scheduledFor)} · {v.user.name}
                </span>
              </div>
              {v.checkInAt && (
                <p className="mt-1 text-xs text-subtle">
                  On site {formatDuration(visitDuration(v.checkInAt, v.checkOutAt))}
                </p>
              )}
              <p className="mt-1 text-sm text-text">
                {v.outcome ?? <span className="text-subtle">No write-up yet.</span>}
              </p>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

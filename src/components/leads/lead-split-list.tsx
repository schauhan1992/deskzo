"use client";

import { usePathname, useSearchParams } from "next/navigation";
import type { LeadStatus } from "@prisma/client";
import { SplitRow } from "@/components/ui/split-list";
import { SELECTED_PARAM } from "@/lib/view-mode";
import { formatCurrency, formatDate } from "@/lib/utils";
import { LeadStatusBadge } from "@/components/leads/lead-status-badge";
import type { LeadStageDef } from "@/lib/pipeline/rules";

type LeadRow = {
  id: string;
  title: string;
  status: LeadStatus;
  /** The workspace's own stage it is at (src/lib/pipeline), where the page has it. */
  stage?: LeadStageDef;
  /** Why a lost or disqualified deal died — shown on hover, never set for an open one. */
  lostReason: string | null;
  estimatedValue: string | null;
  expectedCloseDate: Date | string | null;
  company: { id: string; name: string };
  owner: { id: string; name: string } | null;
};

/**
 * The narrow pane beside an open lead. A lead is identified by what it's for and who it's with, so
 * the title leads and the company sits under it — the reverse of the company lists.
 */
export function LeadSplitList({ leads, selectedId }: { leads: LeadRow[]; selectedId: string | null }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function hrefFor(id: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(SELECTED_PARAM, id);
    return `${pathname}?${params.toString()}`;
  }

  return (
    <div className="divide-y divide-line">
      {leads.map((lead) => (
        <SplitRow
          key={lead.id}
          href={hrefFor(lead.id)}
          active={lead.id === selectedId}
          title={lead.title}
          trailing={lead.estimatedValue ? formatCurrency(Number(lead.estimatedValue)) : undefined}
          subtitle={lead.company.name}
          badges={
            <>
              <LeadStatusBadge status={lead.status} stage={lead.stage} lostReason={lead.lostReason} />
              {lead.expectedCloseDate && (
                <span className="text-xs text-subtle">Closes {formatDate(lead.expectedCloseDate)}</span>
              )}
              {lead.owner && <span className="text-xs text-subtle">{lead.owner.name}</span>}
            </>
          }
        />
      ))}
      {leads.length === 0 && <p className="px-4 py-8 text-center text-sm text-subtle">Nothing here yet.</p>}
    </div>
  );
}

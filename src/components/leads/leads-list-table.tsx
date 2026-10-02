"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { LeadSource, LeadStatus } from "@prisma/client";
import { bulkUpdateLeads } from "@/actions/lead";
import type { LeadStageDef } from "@/lib/pipeline/rules";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { BulkBar, Checkbox, useRowSelection } from "@/components/ui/bulk-select";
import { formatCurrency, formatDate } from "@/lib/utils";
import { formatLeadId } from "@/lib/order-id";
import { LeadStatusBadge } from "@/components/leads/lead-status-badge";
import { useColumns } from "@/components/ui/table-columns";
import { LeadScoreBadge } from "@/components/leads/lead-score";
import { LEAD_SOURCE_LABELS } from "@/lib/leads/source";
import { CustomFieldBodyCells, CustomFieldHeaderCells, type CustomColumn } from "@/components/custom-fields/custom-field-cells";

type LeadRow = {
  id: string;
  /** The short reference — LEAD-000123. Stable while the title, which is free text, is not. */
  leadSeq: number;
  title: string;
  status: LeadStatus;
  /** The workspace's own stage it is at (`stageOfLead`, src/lib/pipeline). */
  stage: LeadStageDef;
  /** Why a lost or disqualified deal died — shown on hover, never set for an open one. */
  lostReason: string | null;
  estimatedValue: string | null;
  expectedCloseDate: Date | string | null;
  updatedAt: Date | string;
  company: { id: string; name: string };
  owner: { id: string; name: string } | null;
  /** 0–100, or null for a closed lead — see src/lib/leads/score.ts. */
  score: number | null;
  source: LeadSource;
  sourceDetail: string | null;
};

export function LeadsListTable({
  leads,
  stages,
  assignableUsers,
  reassign,
  customColumns = { columns: [], texts: {} },
}: {
  leads: LeadRow[];
  /** The workspace's stages still in use (Settings → Pipeline) — what the bulk bar can move leads to. */
  stages: LeadStageDef[];
  assignableUsers: { id: string; name: string; role: string }[];
  /** Whether this person may change lead owners at all — see src/lib/authz/reassign.ts. */
  reassign: { show: boolean; canUnassign: boolean };
  /**
   * The workspace's own fields this person may see (src/lib/custom-fields/server.ts `listColumns`):
   * the ones they show in the column picker, or each field's default.
   */
  customColumns?: { columns: CustomColumn[]; texts: Record<string, Record<string, string>> };
}) {
  const cols = useColumns("leads");
  // The fields this person shows, worked out once: the header and every row draw this one list.
  const fieldColumns = customColumns.columns.filter((c) => cols.showCustom(c.key, c.default));
  const router = useRouter();
  const selection = useRowSelection(leads);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ownerUserId, setOwnerUserId] = useState("");
  const [stageId, setStageId] = useState("");
  const [lostReason, setLostReason] = useState("");

  const chosenStage = stages.find((s) => s.id === stageId);
  const needsReason = chosenStage?.status === "LOST" || chosenStage?.status === "DISQUALIFIED";

  function apply() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await bulkUpdateLeads({ leadIds: selection.ids, ownerUserId, stageId, lostReason });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice(`Updated ${result.data.count} lead(s).`);
      setOwnerUserId("");
      setStageId("");
      setLostReason("");
      selection.clear();
      router.refresh();
    });
  }

  return (
    <div>
      <BulkBar count={selection.count} onClear={selection.clear} error={error} notice={notice}>
        {/* Bulk-bar controls have no captions; the "no change" option is a placeholder, not a name. */}
        {reassign.show && (
          <Select
            value={ownerUserId}
            onChange={(e) => setOwnerUserId(e.target.value)}
            className="h-9 w-52"
            aria-label="Owner"
          >
            <option value="">Owner — no change</option>
            {reassign.canUnassign && <option value="unassign">Unassign</option>}
            {assignableUsers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.role})
              </option>
            ))}
          </Select>
        )}
        <Select value={stageId} onChange={(e) => setStageId(e.target.value)} className="h-9 w-48" aria-label="Stage">
          <option value="">Stage — no change</option>
          {stages.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </Select>
        {needsReason && (
          <Input
            value={lostReason}
            onChange={(e) => setLostReason(e.target.value)}
            placeholder="Reason (required)"
            className="h-9 w-56"
            aria-label="Reason"
          />
        )}
        <Button size="sm" disabled={isPending || (!ownerUserId && !stageId)} onClick={apply}>
          {isPending ? "Applying…" : "Apply"}
        </Button>
      </BulkBar>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                {cols.show("select") && (
                  <th className="w-10 px-4 py-2.5">
                    <Checkbox checked={selection.allSelected} onChange={selection.toggleAll} aria-label="Select all leads" />
                  </th>
                )}
                {cols.show("id") && <th className="px-4 py-2.5">ID</th>}
                {cols.show("title") && <th className="px-4 py-2.5">Title</th>}
                {cols.show("company") && <th className="px-4 py-2.5">Company</th>}
                {cols.show("status") && <th className="px-4 py-2.5">Status</th>}
                {cols.show("score") && <th className="px-4 py-2.5">Score</th>}
                {cols.show("source") && <th className="px-4 py-2.5">Source</th>}
                {cols.show("owner") && <th className="px-4 py-2.5">Owner</th>}
                {cols.show("value") && <th className="px-4 py-2.5">Value</th>}
                {cols.show("expectedClose") && <th className="px-4 py-2.5">Expected close</th>}
                {cols.show("updated") && <th className="px-4 py-2.5">Updated</th>}
                <CustomFieldHeaderCells columns={fieldColumns} className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
                <tr key={lead.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                  {cols.show("select") && (
                    <td className="px-4 py-2.5">
                      <Checkbox
                        checked={selection.isSelected(lead.id)}
                        onChange={() => selection.toggle(lead.id)}
                        aria-label={`Select ${lead.title}`}
                      />
                    </td>
                  )}
                  {/* The title is mutable free text that changes as a deal evolves — this is the
                      reference that does not. */}
                  {cols.show("id") && (
                    <td className="px-4 py-2.5 font-mono text-xs text-muted">{formatLeadId(lead.leadSeq)}</td>
                  )}
                  {cols.show("title") && (
                    <td className="px-4 py-2.5">
                      <Link href={`/leads/${lead.id}`} className="font-medium text-text hover:underline">
                        {lead.title}
                      </Link>
                    </td>
                  )}
                  {cols.show("company") && (
                    <td className="px-4 py-2.5">
                      <Link href={`/companies/${lead.company.id}`} className="text-muted hover:underline">
                        {lead.company.name}
                      </Link>
                    </td>
                  )}
                  {cols.show("status") && (
                    <td className="px-4 py-2.5">
                      <LeadStatusBadge status={lead.status} stage={lead.stage} lostReason={lead.lostReason} />
                    </td>
                  )}
                  {cols.show("score") && (
                    <td className="px-4 py-2.5">
                      {lead.score === null ? <span className="text-subtle">—</span> : <LeadScoreBadge score={lead.score} />}
                    </td>
                  )}
                  {cols.show("source") && (
                    <td className="px-4 py-2.5 text-muted" title={lead.sourceDetail ?? undefined}>
                      {LEAD_SOURCE_LABELS[lead.source]}
                    </td>
                  )}
                  {cols.show("owner") && (
                    <td className="px-4 py-2.5 text-muted">{lead.owner?.name ?? "Unassigned"}</td>
                  )}
                  {cols.show("value") && (
                    <td className="px-4 py-2.5 text-muted">{formatCurrency(lead.estimatedValue?.toString())}</td>
                  )}
                  {cols.show("expectedClose") && (
                    <td className="px-4 py-2.5 text-muted">{formatDate(lead.expectedCloseDate)}</td>
                  )}
                  {cols.show("updated") && (
                    <td className="px-4 py-2.5 text-muted">{formatDate(lead.updatedAt)}</td>
                  )}
                  <CustomFieldBodyCells columns={fieldColumns} texts={customColumns.texts[lead.id]} className="px-4 py-2.5 text-muted" />
                </tr>
              ))}
              {leads.length === 0 && (
                <tr>
                  <td colSpan={cols.count + fieldColumns.length} className="px-4 py-8 text-center text-subtle">
                    No leads yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

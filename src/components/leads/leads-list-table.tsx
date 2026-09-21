"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { LeadStatus } from "@prisma/client";
import { bulkUpdateLeads } from "@/actions/lead";
import { leadStatusValues } from "@/lib/validation/lead";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { BulkBar, Checkbox, useRowSelection } from "@/components/ui/bulk-select";
import { formatCurrency, formatDate } from "@/lib/utils";
import { LeadStatusBadge } from "@/components/leads/lead-status-badge";
import { useColumns } from "@/components/ui/table-columns";

type LeadRow = {
  id: string;
  title: string;
  status: LeadStatus;
  /** Why a lost or disqualified deal died — shown on hover, never set for an open one. */
  lostReason: string | null;
  estimatedValue: string | null;
  expectedCloseDate: Date | string | null;
  updatedAt: Date | string;
  company: { id: string; name: string };
  owner: { id: string; name: string } | null;
};

export function LeadsListTable({
  leads,
  assignableUsers,
}: {
  leads: LeadRow[];
  assignableUsers: { id: string; name: string; role: string }[];
}) {
  const cols = useColumns("leads");
  const router = useRouter();
  const selection = useRowSelection(leads);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ownerUserId, setOwnerUserId] = useState("");
  const [status, setStatus] = useState("");
  const [lostReason, setLostReason] = useState("");

  const needsReason = status === "LOST" || status === "DISQUALIFIED";

  function apply() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await bulkUpdateLeads({ leadIds: selection.ids, ownerUserId, status, lostReason });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice(`Updated ${result.data.count} lead(s).`);
      setOwnerUserId("");
      setStatus("");
      setLostReason("");
      selection.clear();
      router.refresh();
    });
  }

  return (
    <div>
      <BulkBar count={selection.count} onClear={selection.clear} error={error} notice={notice}>
        {/* Bulk-bar controls have no captions; the "no change" option is a placeholder, not a name. */}
        <Select
          value={ownerUserId}
          onChange={(e) => setOwnerUserId(e.target.value)}
          className="h-9 w-52"
          aria-label="Owner"
        >
          <option value="">Owner — no change</option>
          <option value="unassign">Unassign</option>
          {assignableUsers.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name} ({u.role})
            </option>
          ))}
        </Select>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="h-9 w-48" aria-label="Status">
          <option value="">Status — no change</option>
          {leadStatusValues.map((s) => (
            <option key={s} value={s}>
              {s.replaceAll("_", " ")}
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
        <Button size="sm" disabled={isPending || (!ownerUserId && !status)} onClick={apply}>
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
                {cols.show("title") && <th className="px-4 py-2.5">Title</th>}
                {cols.show("company") && <th className="px-4 py-2.5">Company</th>}
                {cols.show("status") && <th className="px-4 py-2.5">Status</th>}
                {cols.show("owner") && <th className="px-4 py-2.5">Owner</th>}
                {cols.show("value") && <th className="px-4 py-2.5">Value</th>}
                {cols.show("expectedClose") && <th className="px-4 py-2.5">Expected close</th>}
                {cols.show("updated") && <th className="px-4 py-2.5">Updated</th>}
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
                      <LeadStatusBadge status={lead.status} lostReason={lead.lostReason} />
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
                </tr>
              ))}
              {leads.length === 0 && (
                <tr>
                  <td colSpan={cols.count} className="px-4 py-8 text-center text-subtle">
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

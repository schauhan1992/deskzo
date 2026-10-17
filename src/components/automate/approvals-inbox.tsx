"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/input";
import { decideApproval } from "@/actions/automate";
import { cancelCopilotProposal, confirmCopilotProposal } from "@/actions/copilot";

export type InboxRow = {
  id: string;
  source: "workflow" | "copilot";
  title: string;
  summary: string | null;
  from: string;
  asked: string;
  until: string | null;
  status: string;
  decidedBy: string | null;
  decided: string | null;
  comment: string | null;
};

const STATUS: Record<string, { label: string; tone: "green" | "red" | "amber" | "default" }> = {
  APPROVED: { label: "Approved", tone: "green" },
  REJECTED: { label: "Rejected", tone: "red" },
  TIMED_OUT: { label: "Nobody decided in time", tone: "amber" },
  CANCELLED: { label: "The run was stopped", tone: "default" },
};

/**
 * The approvals inbox (Deskzo Automate, Phase 6): what waits on this person — a workflow's approval,
 * a draft the AI copilot made for them — to approve or reject, with an optional word for the record,
 * and what they decided lately.
 */
export function ApprovalsInbox({ waiting, decided }: { waiting: InboxRow[]; decided: InboxRow[] }) {
  const router = useRouter();
  const [comments, setComments] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const act = async (row: InboxRow, yes: boolean) => {
    setBusy(row.id);
    setErrors((e) => ({ ...e, [row.id]: "" }));
    const result =
      row.source === "workflow" ? await decideApproval(row.id, yes ? "approved" : "rejected", comments[row.id] ?? null) : yes ? await confirmCopilotProposal(row.id) : await cancelCopilotProposal(row.id);
    setBusy(null);
    if (!result.ok) return setErrors((e) => ({ ...e, [row.id]: result.error }));
    router.refresh();
  };

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-text">Waiting for you</h2>
        {waiting.length === 0 ? (
          <Card className="p-6 text-sm text-muted">Nothing is waiting for you to decide.</Card>
        ) : (
          waiting.map((row) => (
            <Card key={row.id} className="space-y-2 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium text-text">{row.title}</p>
                  <p className="text-xs text-muted">
                    {row.from} · asked {row.asked}
                    {row.until ? ` · decide by ${row.until}` : ""}
                  </p>
                </div>
                {row.source === "copilot" && <Badge tone="blue">From the copilot</Badge>}
              </div>
              {row.summary && <p className="whitespace-pre-line text-sm text-text">{row.summary}</p>}
              {row.source === "workflow" && (
                <Textarea rows={2} maxLength={1000} placeholder="A word for the record (optional)" value={comments[row.id] ?? ""} onChange={(e) => setComments((c) => ({ ...c, [row.id]: e.target.value }))} />
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" disabled={busy === row.id} onClick={() => act(row, true)}>
                  {row.source === "workflow" ? "Approve" : "Do it"}
                </Button>
                <Button size="sm" variant="secondary" disabled={busy === row.id} onClick={() => act(row, false)}>
                  {row.source === "workflow" ? "Reject" : "Don't"}
                </Button>
                {errors[row.id] && <span className="text-xs text-danger">{errors[row.id]}</span>}
              </div>
            </Card>
          ))
        )}
      </section>

      {decided.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-text">Decided lately</h2>
          <Card className="divide-y divide-line p-0">
            {decided.map((row) => (
              <div key={row.id} className="flex flex-wrap items-start justify-between gap-2 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm text-text">{row.title}</p>
                  <p className="text-xs text-muted">
                    {row.from}
                    {row.decidedBy ? ` · ${row.decidedBy}` : ""}
                    {row.decided ? `, ${row.decided}` : ""}
                    {row.comment ? ` — “${row.comment}”` : ""}
                  </p>
                </div>
                <Badge tone={STATUS[row.status]?.tone ?? "default"}>{STATUS[row.status]?.label ?? row.status}</Badge>
              </div>
            ))}
          </Card>
        </section>
      )}
    </div>
  );
}

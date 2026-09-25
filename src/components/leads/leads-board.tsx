"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { LeadStatusBadge } from "@/components/leads/lead-status-badge";
import { updateLeadStatus } from "@/actions/lead";
import type { LeadStatus } from "@prisma/client";
import { LeadScoreBadge } from "@/components/leads/lead-score";

const COLUMNS: { status: LeadStatus; label: string }[] = [
  { status: "NEW", label: "New" },
  { status: "CONTACTED", label: "Contacted" },
  { status: "QUALIFYING", label: "Qualifying" },
  { status: "QUALIFIED", label: "Qualified" },
  { status: "PROPOSAL_SENT", label: "Proposal sent" },
  { status: "NEGOTIATION", label: "Negotiation" },
  { status: "WON", label: "Won" },
  { status: "LOST", label: "Lost" },
];

const NEEDS_REASON: LeadStatus[] = ["LOST", "DISQUALIFIED"];

type BoardLead = {
  id: string;
  title: string;
  status: LeadStatus;
  /** Why a lost or disqualified deal died — shown on hover, never set for an open one. */
  lostReason: string | null;
  estimatedValue: string | null;
  company: { id: string; name: string };
  owner: { id: string; name: string } | null;
  score: number | null;
};

export function LeadsBoard({ leads }: { leads: BoardLead[] }) {
  const router = useRouter();
  const [items, setItems] = useState(leads);
  const [syncedLeads, setSyncedLeads] = useState(leads);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverStatus, setDragOverStatus] = useState<LeadStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // Re-sync local optimistic state when the server hands back fresh leads (e.g. after
  // router.refresh()) — adjusted during render rather than in an effect, per React's
  // guidance, to avoid an extra render pass.
  if (leads !== syncedLeads) {
    setSyncedLeads(leads);
    setItems(leads);
  }

  function handleDrop(newStatus: LeadStatus) {
    const id = draggedId;
    setDraggedId(null);
    setDragOverStatus(null);
    if (!id) return;

    const lead = items.find((l) => l.id === id);
    if (!lead || lead.status === newStatus) return;

    let lostReason: string | undefined;
    if (NEEDS_REASON.includes(newStatus)) {
      const input = window.prompt(`Reason for marking this lead "${newStatus}":`);
      if (!input) return;
      lostReason = input;
    }

    setError(null);
    const previousItems = items;
    setItems((prev) => prev.map((l) => (l.id === id ? { ...l, status: newStatus } : l)));

    startTransition(async () => {
      const result = await updateLeadStatus({ leadId: id, status: newStatus, lostReason });
      if (!result.ok) {
        setItems(previousItems);
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div>
      {error && (
        <div className="mb-3 rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{error}</div>
      )}
      <div className="flex gap-4 overflow-x-auto pb-4">
        {COLUMNS.map((col) => {
          const columnLeads = items.filter((l) => l.status === col.status);
          const isDragOver = dragOverStatus === col.status;
          return (
            <div
              key={col.status}
              className="w-64 flex-shrink-0"
              onDragOver={(e) => {
                e.preventDefault();
                if (dragOverStatus !== col.status) setDragOverStatus(col.status);
              }}
              onDragLeave={() => setDragOverStatus((prev) => (prev === col.status ? null : prev))}
              onDrop={(e) => {
                e.preventDefault();
                handleDrop(col.status);
              }}
            >
              <div className="mb-2 flex items-center justify-between px-1">
                <h2 className="text-sm font-medium text-text">{col.label}</h2>
                <span className="text-xs text-subtle">{columnLeads.length}</span>
              </div>
              <div
                className={`min-h-16 space-y-2 rounded-md ${
                  isDragOver ? "bg-brand-subtle ring-2 ring-brand" : ""
                }`}
              >
                {columnLeads.map((lead) => (
                  <div
                    key={lead.id}
                    draggable
                    onDragStart={(e) => {
                      setDraggedId(lead.id);
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", lead.id);
                    }}
                    onDragEnd={() => {
                      setDraggedId(null);
                      setDragOverStatus(null);
                    }}
                  >
                    <Link href={`/leads/${lead.id}`}>
                      <Card
                        className={`cursor-grab p-3 hover:border-line-strong active:cursor-grabbing ${
                          draggedId === lead.id ? "opacity-40" : ""
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="text-sm font-medium text-text">{lead.title}</div>
                          <LeadScoreBadge score={lead.score} />
                        </div>
                        <div className="mt-0.5 text-xs text-muted">{lead.company.name}</div>
                        {/* The column already names the status, so the badge is only worth its
                            space on a dead deal — where it carries the reason on hover. */}
                        {lead.lostReason && (
                          <div className="mt-1.5">
                            <LeadStatusBadge status={lead.status} lostReason={lead.lostReason} />
                          </div>
                        )}
                        <div className="mt-2 flex items-center justify-between text-xs text-muted">
                          <span>{lead.owner?.name ?? "Unassigned"}</span>
                          {lead.estimatedValue !== null && (
                            <span>{formatCurrency(String(lead.estimatedValue))}</span>
                          )}
                        </div>
                      </Card>
                    </Link>
                  </div>
                ))}
                {columnLeads.length === 0 && (
                  <div className="rounded-md border border-dashed border-line p-3 text-center text-xs text-subtle">
                    Empty
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

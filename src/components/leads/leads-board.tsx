"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarDays, MessageSquare, ShoppingCart, SquareCheck } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { LeadStatusBadge } from "@/components/leads/lead-status-badge";
import { updateLeadStatus } from "@/actions/lead";
import type { LeadStatus } from "@prisma/client";
import { LeadScoreBadge } from "@/components/leads/lead-score";
import type { LeadStageDef, StageColor } from "@/lib/pipeline/rules";
import { leadPath } from "@/lib/record-links";
import { AvatarStack } from "@/components/ui/avatar";
import { useClock } from "@/components/time/clock-provider";
import { formatCalendarDay } from "@/lib/time/zone";
import type { LeadBoardExtras } from "@/lib/leads/board-extras";

const NEEDS_REASON: LeadStatus[] = ["LOST", "DISQUALIFIED"];

type BoardLead = {
  id: string;
  leadSeq: number;
  title: string;
  status: LeadStatus;
  /** The workspace's own stage it is at (`stageOfLead`): which column it sits in. */
  stage: LeadStageDef;
  /** Why a lost or disqualified deal died — shown on hover, never set for an open one. */
  lostReason: string | null;
  estimatedValue: string | null;
  expectedCloseDate?: Date | string | null;
  company: { id: string; name: string };
  owner: { id: string; name: string } | null;
  score: number | null;
};

/**
 * Each stage's column in its own colour (Settings → Pipeline): a tinted panel, the stage's name and
 * count in the colour, white cards on it. "default" is grey.
 */
const COLUMN: Record<StageColor, { panel: string; title: string; pill: string }> = {
  default: { panel: "bg-surface-sunken", title: "text-muted", pill: "bg-surface text-muted" },
  blue: { panel: "bg-info-bg", title: "text-info", pill: "bg-surface text-info" },
  amber: { panel: "bg-warning-bg", title: "text-warning", pill: "bg-surface text-warning" },
  brand: { panel: "bg-brand-subtle", title: "text-brand", pill: "bg-surface text-brand" },
  green: { panel: "bg-success-bg", title: "text-success", pill: "bg-surface text-success" },
  red: { panel: "bg-danger-bg", title: "text-danger", pill: "bg-surface text-danger" },
};

/** A stored date as the day it holds — `expectedCloseDate` is a typed day, kept as its midnight UTC. */
const dayOf = (value: Date | string) => (typeof value === "string" ? value : value.toISOString()).slice(0, 10);

/**
 * The pipeline as columns — the workspace's own stages in its order (Settings → Pipeline), each lead in
 * the one it is at. Dropping a lead on a column moves it there; a stage that counts as lost or
 * disqualified asks why first.
 *
 * A card (owner, 16 Oct 2026): the lead and its company, its tasks done of all, products asked for,
 * calls and notes logged, the people on it, and when it's expected to close — red once that's passed
 * on a deal still open.
 */
export function LeadsBoard({
  leads,
  stages,
  extras = {},
}: {
  leads: BoardLead[];
  stages: LeadStageDef[];
  extras?: Record<string, LeadBoardExtras>;
}) {
  const router = useRouter();
  const clock = useClock();
  const today = clock.today();
  const [items, setItems] = useState(leads);
  const [syncedLeads, setSyncedLeads] = useState(leads);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverStage, setDragOverStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // Re-sync local optimistic state when the server hands back fresh leads (e.g. after
  // router.refresh()) — adjusted during render rather than in an effect, per React's
  // guidance, to avoid an extra render pass.
  if (leads !== syncedLeads) {
    setSyncedLeads(leads);
    setItems(leads);
  }

  function handleDrop(target: LeadStageDef) {
    const id = draggedId;
    setDraggedId(null);
    setDragOverStage(null);
    if (!id) return;

    const lead = items.find((l) => l.id === id);
    if (!lead || lead.stage.id === target.id) return;

    let lostReason: string | undefined;
    if (NEEDS_REASON.includes(target.status)) {
      const input = window.prompt(`Reason for moving this lead to "${target.label}":`);
      if (!input) return;
      lostReason = input;
    }

    setError(null);
    const previousItems = items;
    setItems((prev) => prev.map((l) => (l.id === id ? { ...l, status: target.status, stage: target, lostReason: lostReason ?? null } : l)));

    startTransition(async () => {
      const result = await updateLeadStatus({ leadId: id, stageId: target.id, lostReason });
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
      {error && <div className="mb-3 rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{error}</div>}
      <div className="flex gap-4 overflow-x-auto pb-4">
        {stages.map((col) => {
          const columnLeads = items.filter((l) => l.stage.id === col.id);
          const isDragOver = dragOverStage === col.id;
          const tone = COLUMN[col.color] ?? COLUMN.default;
          return (
            <section
              key={col.id}
              aria-label={col.label}
              className={`flex min-h-[60vh] w-72 flex-shrink-0 flex-col rounded-xl ${tone.panel} ${isDragOver ? "ring-2 ring-brand" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                if (dragOverStage !== col.id) setDragOverStage(col.id);
              }}
              onDragLeave={() => setDragOverStage((prev) => (prev === col.id ? null : prev))}
              onDrop={(e) => {
                e.preventDefault();
                handleDrop(col);
              }}
            >
              <header className="flex items-center gap-2 px-3 pb-2 pt-3">
                <h2 className={`text-sm font-medium ${tone.title}`}>{col.label}</h2>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${tone.pill}`}>{columnLeads.length}</span>
              </header>
              <div className="flex-1 space-y-2.5 px-2 pb-3">
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
                      setDragOverStage(null);
                    }}
                  >
                    <LeadCard lead={lead} extra={extras[lead.id]} today={today} dragging={draggedId === lead.id} />
                  </div>
                ))}
                {columnLeads.length === 0 && (
                  <div className="rounded-lg border border-dashed border-line-strong/60 p-3 text-center text-xs text-subtle">Drop a lead here</div>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** A small counter on a card: an icon and a number, in a tint. */
function Chip({ icon: Icon, value, label, className }: { icon: typeof ShoppingCart; value: string; label: string; className: string }) {
  return (
    <span title={label} className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium tabular-nums ${className}`}>
      <Icon className="h-3 w-3" aria-hidden />
      {value}
      <span className="sr-only"> {label}</span>
    </span>
  );
}

function LeadCard({ lead, extra, today, dragging }: { lead: BoardLead; extra: LeadBoardExtras | undefined; today: string; dragging: boolean }) {
  const closeDay = lead.expectedCloseDate ? dayOf(lead.expectedCloseDate) : null;
  const open = lead.status !== "WON" && lead.status !== "LOST" && lead.status !== "DISQUALIFIED";
  const overdue = !!closeDay && open && closeDay < today;
  const people = extra?.people.length ? extra.people : lead.owner ? [lead.owner] : [];

  return (
    <Link
      href={leadPath(lead.leadSeq)}
      className={`block cursor-grab rounded-lg border border-line bg-surface p-3 shadow-sm transition-colors hover:border-line-strong active:cursor-grabbing ${dragging ? "opacity-40" : ""}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 text-sm font-medium text-text">{lead.title}</div>
        <LeadScoreBadge score={lead.score} />
      </div>
      <div className="mt-1 truncate text-xs text-muted">
        {lead.company.name}
        {lead.estimatedValue !== null && <span className="text-subtle"> · {formatCurrency(String(lead.estimatedValue))}</span>}
      </div>
      {/* The column already names the status, so the badge is only worth its space on a dead deal —
          where it carries the reason on hover. */}
      {lead.lostReason && (
        <div className="mt-1.5">
          <LeadStatusBadge status={lead.status} stage={lead.stage} lostReason={lead.lostReason} />
        </div>
      )}

      {extra && (extra.tasksTotal > 0 || extra.products > 0 || extra.touches > 0) && (
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-1.5">
          {extra.tasksTotal > 0 ? (
            <Chip icon={SquareCheck} value={`${extra.tasksDone}/${extra.tasksTotal}`} label="tasks done" className="bg-surface-sunken text-muted" />
          ) : (
            <span />
          )}
          <span className="flex items-center gap-1.5">
            {extra.products > 0 && <Chip icon={ShoppingCart} value={String(extra.products)} label="products asked for" className="bg-info-bg text-info" />}
            {extra.touches > 0 && <Chip icon={MessageSquare} value={String(extra.touches)} label="calls and notes" className="bg-brand-subtle text-brand" />}
          </span>
        </div>
      )}

      <div className="mt-2.5 flex items-center justify-between gap-2">
        {people.length > 0 ? <AvatarStack users={people} size="sm" max={3} /> : <span className="text-xs text-subtle">Unassigned</span>}
        {closeDay && (
          <span
            title={overdue ? "Expected to close by now" : "Expected to close"}
            className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs tabular-nums ${overdue ? "bg-danger-bg text-danger" : "bg-surface-sunken text-muted"}`}
          >
            <CalendarDays className="h-3 w-3" aria-hidden />
            {formatCalendarDay(closeDay)}
          </span>
        )}
      </div>
    </Link>
  );
}

"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarDays, MessageSquare, ShoppingCart, SquareCheck } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { LeadStatusBadge } from "@/components/leads/lead-status-badge";
import { listLeadBoardColumn, updateLeadStatus, type LeadListParams } from "@/actions/lead";
import { BOARD_COLUMN_SIZE } from "@/lib/leads/board";
import type { LeadStatus } from "@prisma/client";
import { LeadScoreBadge } from "@/components/leads/lead-score";
import type { LeadStageDef, StageColor } from "@/lib/pipeline/rules";
import { leadPath } from "@/lib/record-links";
import { AvatarStack } from "@/components/ui/avatar";
import { useClock } from "@/components/time/clock-provider";
import { formatCalendarDay } from "@/lib/time/zone";
import type { LeadBoardExtras } from "@/lib/leads/board-extras";
import { quoteBadge, type LeadQuote } from "@/lib/leads/quotes";
import { LeadQuoteChip } from "@/components/leads/lead-quote-badge";
import { useWording } from "@/components/terms/wording-provider";
import { slot } from "@/lib/terms/dictionary";

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
 * on a deal still open. And its quotation (owner, 19 Oct 2026), for somebody who sees sales documents:
 * the furthest sent, or "No quote" on a deal at Proposal sent or past it without one.
 */
export function LeadsBoard({
  leads,
  counts,
  stages,
  extras = {},
  quotes = null,
  filters,
}: {
  /** Each column's first cards (src/actions/lead.ts `listLeadBoard`). */
  leads: BoardLead[];
  /** How many leads each column holds in all, by stage id — what its header says. */
  counts: Record<string, number>;
  stages: LeadStageDef[];
  extras?: Record<string, LeadBoardExtras>;
  /** Each lead's quotation, or null where this person doesn't see them (src/lib/leads/quote-status.ts). */
  quotes?: Record<string, LeadQuote | null> | null;
  /** The page's filters, for a column's next cards. */
  filters: LeadListParams;
}) {
  const router = useRouter();
  const clock = useClock();
  const w = useWording();
  const today = clock.today();
  const [items, setItems] = useState(leads);
  const [totals, setTotals] = useState(counts);
  const [cardExtras, setCardExtras] = useState(extras);
  const [cardQuotes, setCardQuotes] = useState(quotes);
  // Cards brought by "Show more", kept when the server hands back each column's first cards again.
  const [more, setMore] = useState<BoardLead[]>([]);
  const [loading, setLoading] = useState<string | null>(null);
  const [syncedLeads, setSyncedLeads] = useState(leads);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverStage, setDragOverStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // Re-sync local optimistic state when the server hands back fresh leads (e.g. after
  // router.refresh()) — adjusted during render rather than in an effect, per React's
  // guidance, to avoid an extra render pass. The server's own copy of a card wins.
  if (leads !== syncedLeads) {
    const fresh = new Set(leads.map((l) => l.id));
    setSyncedLeads(leads);
    setItems([...leads, ...more.filter((l) => !fresh.has(l.id))]);
    setTotals(counts);
    setCardExtras((prev) => ({ ...prev, ...extras }));
    setCardQuotes((prev) => (quotes ? { ...(prev ?? {}), ...quotes } : prev));
  }

  async function showMore(stage: LeadStageDef, shown: number) {
    setLoading(stage.id);
    setError(null);
    try {
      const next = await listLeadBoardColumn(filters, stage.id, shown);
      const known = new Set(items.map((l) => l.id));
      const added = next.cards.filter((l) => !known.has(l.id));
      setItems((prev) => [...prev, ...added]);
      setMore((prev) => [...prev, ...added]);
      setCardExtras((prev) => ({ ...prev, ...next.extras }));
      if (next.quotes) setCardQuotes((prev) => ({ ...(prev ?? {}), ...next.quotes }));
    } catch {
      setError(slot(w, "Couldn't load more leads — try again.", "lead", "Couldn't load more {many:lower} — try again."));
    } finally {
      setLoading(null);
    }
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
      const input = window.prompt(`${slot(w, "Reason for moving this lead to", "lead", "Reason for moving this {one:lower} to")} "${target.label}":`);
      if (!input) return;
      lostReason = input;
    }

    setError(null);
    const previousItems = items;
    const previousTotals = totals;
    const from = lead.stage.id;
    const moved = (l: BoardLead) => (l.id === id ? { ...l, status: target.status, stage: target, lostReason: lostReason ?? null } : l);
    setItems((prev) => prev.map(moved));
    setMore((prev) => prev.map(moved));
    setTotals((prev) => ({ ...prev, [from]: Math.max(0, (prev[from] ?? 1) - 1), [target.id]: (prev[target.id] ?? 0) + 1 }));

    startTransition(async () => {
      const result = await updateLeadStatus({ leadId: id, stageId: target.id, lostReason });
      if (!result.ok) {
        setItems(previousItems);
        setTotals(previousTotals);
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
          const total = Math.max(totals[col.id] ?? 0, columnLeads.length);
          const left = total - columnLeads.length;
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
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${tone.pill}`}>{total.toLocaleString("en-IN")}</span>
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
                    <LeadCard lead={lead} extra={cardExtras[lead.id]} quote={cardQuotes ? (cardQuotes[lead.id] ?? null) : undefined} today={today} dragging={draggedId === lead.id} />
                  </div>
                ))}
                {columnLeads.length === 0 && (
                  <div className="rounded-lg border border-dashed border-line-strong/60 p-3 text-center text-xs text-subtle">{slot(w, "Drop a lead here", "lead", "Drop {a} here")}</div>
                )}
                {left > 0 && (
                  <button
                    type="button"
                    onClick={() => showMore(col, columnLeads.length)}
                    disabled={loading !== null}
                    className={`w-full rounded-lg bg-surface/70 px-3 py-2 text-xs font-medium ${tone.title} hover:bg-surface disabled:opacity-60`}
                  >
                    {loading === col.id ? "Loading…" : `Show ${Math.min(BOARD_COLUMN_SIZE, left).toLocaleString("en-IN")} more · ${left.toLocaleString("en-IN")} not shown`}
                  </button>
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

/** `quote` undefined: this person doesn't see quotations, so the card says nothing of them. */
function LeadCard({ lead, extra, quote, today, dragging }: { lead: BoardLead; extra: LeadBoardExtras | undefined; quote: LeadQuote | null | undefined; today: string; dragging: boolean }) {
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
      {/* Its quotation — or "No quote" on a deal at Proposal sent or past it with none (src/lib/leads/quotes.ts). */}
      {quote !== undefined && quoteBadge(quote, lead.status) && (
        <div className="mt-1.5">
          <LeadQuoteChip quote={quote} status={lead.status} />
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

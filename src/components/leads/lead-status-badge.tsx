"use client";

import { useRef, useState } from "react";
import type { LeadStatus } from "@prisma/client";
import { Badge } from "@/components/ui/card";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { cn } from "@/lib/utils";
import type { StageColor } from "@/lib/pipeline/rules";

/**
 * The one definition of what a lead's status looks like.
 *
 * Previously copied into the list table and the split list, which is how two views of the same
 * pipeline start disagreeing about which colour "qualified" is.
 */
export const leadStatusTone: Record<LeadStatus, "default" | "green" | "blue" | "red" | "amber"> = {
  NEW: "default",
  CONTACTED: "blue",
  QUALIFYING: "blue",
  QUALIFIED: "amber",
  PROPOSAL_SENT: "amber",
  NEGOTIATION: "amber",
  WON: "green",
  LOST: "red",
  DISQUALIFIED: "red",
};

export function leadStatusLabel(status: LeadStatus) {
  return status.replaceAll("_", " ");
}

/**
 * A lead's status, and — for a lost or disqualified one — why, on hover.
 *
 * The reason is the most useful thing about a closed-lost lead and the hardest to get at: it is
 * captured at the moment the deal dies, then buried on the lead's own page where nobody scanning a
 * pipeline will go looking. Putting it behind a hover means a manager reading a list of fifteen
 * losses can see "price" against four of them without opening anything.
 *
 * It uses `AnchoredPopover` rather than an absolutely-positioned bubble because these badges live
 * inside tables with `overflow-x-auto`, which clips a positioned child — the exact problem that
 * component exists to solve. A native `title` would also avoid clipping, but waits about a second
 * before appearing, which is too slow to be worth scanning with.
 */
export function LeadStatusBadge({
  status,
  stage,
  lostReason,
  className,
}: {
  status: LeadStatus;
  /**
   * The workspace's own stage the lead is at (Settings → Pipeline, src/lib/pipeline) — its name and
   * colour. Without it, the status as the app always showed it.
   */
  stage?: { label: string; color: StageColor } | null;
  lostReason?: string | null;
  className?: string;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);

  const label = stage?.label ?? leadStatusLabel(status);
  const tone = stage?.color ?? leadStatusTone[status];
  const closed = status === "LOST" || status === "DISQUALIFIED";
  const reason = closed ? lostReason?.trim() || null : null;

  // Nothing to explain: stay a plain badge rather than a control that does nothing when hovered.
  if (!reason) {
    return (
      <Badge tone={tone} className={className}>
        {label}
      </Badge>
    );
  }

  return (
    <>
      <span
        ref={anchorRef}
        tabIndex={0}
        // Focus as well as hover, so the reason isn't keyboard-inaccessible — and the label carries
        // it for a screen reader, which gets no hover at all.
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        aria-label={`${label} — ${reason}`}
        className={cn("inline-flex cursor-help rounded-full outline-none focus-visible:ring-2 focus-visible:ring-focus", className)}
      >
        <Badge tone={tone} className="underline decoration-dotted underline-offset-2">
          {label}
        </Badge>
      </span>

      <AnchoredPopover anchorRef={anchorRef} open={open} width={260}>
        <div className="rounded-lg border border-line bg-surface px-3 py-2 shadow-lg">
          <div className="text-[11px] uppercase tracking-wide text-subtle">
            Why it was {status === "LOST" ? "lost" : "disqualified"}
          </div>
          <p className="mt-0.5 text-sm text-text">{reason}</p>
        </div>
      </AnchoredPopover>
    </>
  );
}

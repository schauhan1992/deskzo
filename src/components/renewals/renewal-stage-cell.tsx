"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, Pin, RotateCcw } from "lucide-react";
import { setRenewalStage } from "@/actions/renewal-stage";
import { SETTABLE_RENEWAL_STAGES, type RenewalStageKey, type RenewalStageTone } from "@/lib/renewals";
import { Badge } from "@/components/ui/card";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Input } from "@/components/ui/input";
import { formatDate } from "@/lib/utils";

export type RenewalStageCellData = {
  key: RenewalStageKey;
  label: string;
  tone: RenewalStageTone;
  source: "auto" | "manual";
  /** Set when a pinned stage was overtaken by the renewal actually being punched. */
  supersededManual?: RenewalStageKey;
  note: string | null;
  setAt: Date | string | null;
  setBy: { id: string; name: string } | null;
  quote: { id: string; docNumber: string; docType: string; status: string } | null;
};

/**
 * How far this renewal has got, and the one control that can change it.
 *
 * Most of what it shows is derived, so the usual state of this cell is read-only information. The
 * picker exists for the three stages nothing can infer — Negotiating, On hold, Lost — and for
 * taking a pin back off again.
 *
 * The distinction is on the face of it rather than buried in a tooltip: a pinned stage carries a pin
 * and says who set it. Somebody looking down this column needs to know which entries are the system
 * reporting and which are a colleague asserting, because only one of those is evidence.
 */
export function RenewalStageCell({
  companyProductId,
  stage,
  canEdit,
}: {
  companyProductId: string;
  stage: RenewalStageCellData;
  canEdit: boolean;
}) {
  const router = useRouter();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState(stage.note ?? "");
  const [error, setError] = useState<string | null>(null);

  /**
   * Clicking away, or Escape, puts it away — the same pattern the other pickers use.
   *
   * The panel is portalled to `<body>`, so it is not inside the anchor: without the
   * `[data-menu-panel]` check, a mousedown on an option would close the picker before the click
   * reached its handler, and the note field could never be clicked into at all.
   */
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (anchorRef.current?.contains(target)) return;
      if (target?.closest?.("[data-menu-panel]")) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const apply = (next: RenewalStageKey | null) => {
    setError(null);
    startTransition(async () => {
      const result = await setRenewalStage({ companyProductId, stage: next, note });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  };

  const badge = (
    <span className="inline-flex items-center gap-1">
      {stage.source === "manual" && <Pin aria-hidden className="h-2.5 w-2.5" />}
      {stage.label}
      {canEdit && <ChevronDown aria-hidden className="h-3 w-3 opacity-60" />}
    </span>
  );

  return (
    <div className="min-w-0">
      {canEdit ? (
        <button
          ref={anchorRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={pending}
          className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          title={stage.source === "manual" ? "Set by hand — click to change or clear" : "Worked out from what's happened — click to pin a different stage"}
        >
          <Badge tone={stage.tone}>{badge}</Badge>
        </button>
      ) : (
        <Badge tone={stage.tone}>{badge}</Badge>
      )}

      {/* The evidence behind the stage, where there is a document to point at. Turning "Quoted" into
          a link is most of this column's value — the next question after "has it been quoted?" is
          always "what did we quote?". */}
      {stage.quote && stage.key === "QUOTED" && (
        <Link
          href={`/documents/${stage.quote.id}`}
          className="mt-0.5 block truncate font-mono text-[11px] text-muted hover:text-text hover:underline"
        >
          {stage.quote.docNumber}
        </Link>
      )}

      {stage.source === "manual" && stage.setBy && (
        <span className="mt-0.5 block truncate text-[11px] text-subtle" title={stage.note ?? undefined}>
          {stage.setBy.name}
          {stage.setAt ? `, ${formatDate(stage.setAt)}` : ""}
          {stage.note ? ` — ${stage.note}` : ""}
        </span>
      )}

      {/**
        * A pin that has been overtaken.
        *
        * Said out loud rather than dropped: somebody typed "Lost" and the column is now showing
        * something else, and the person reading it is usually not the person who typed it.
        */}
      {stage.supersededManual && (
        <span className="mt-0.5 block text-[11px] text-subtle">
          was marked {stage.supersededManual.toLowerCase().replace("_", " ")}
        </span>
      )}

      <AnchoredPopover anchorRef={anchorRef} open={open} width={260} align="end">
        <div data-menu-panel className="space-y-1 p-1">
          <p className="px-2 pt-1 text-[11px] uppercase tracking-wide text-subtle">Set the stage by hand</p>
          {SETTABLE_RENEWAL_STAGES.map((s) => (
            <button
              key={s.key}
              type="button"
              disabled={pending}
              onClick={() => apply(s.key)}
              title={s.hint}
              className={`block w-full rounded px-2 py-1.5 text-left text-sm transition-colors disabled:opacity-50 ${
                stage.source === "manual" && stage.key === s.key
                  ? "bg-surface-sunken font-medium text-text"
                  : "text-text hover:bg-surface-sunken"
              }`}
            >
              {s.label}
            </button>
          ))}

          <div className="px-2 pb-1 pt-1.5">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why — e.g. lost on price"
              aria-label="Why this stage"
              autoComplete="off"
              className="h-8 text-xs"
            />
            <p className="mt-1 text-[11px] text-subtle">
              Saved with whichever stage you pick above. On a lost renewal this is the part worth reading back.
            </p>
          </div>

          {stage.source === "manual" && (
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setNote("");
                apply(null);
              }}
              className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-sm text-muted transition-colors hover:bg-surface-sunken disabled:opacity-50"
            >
              <RotateCcw aria-hidden className="h-3.5 w-3.5" />
              Clear — go back to what the record says
            </button>
          )}

          {error && <p className="px-2 pb-1 text-xs text-danger">{error}</p>}
        </div>
      </AnchoredPopover>
    </div>
  );
}

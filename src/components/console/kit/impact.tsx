import type { ReactNode } from "react";
import { Minus, Plus } from "lucide-react";
import type { Tone } from "@/lib/console-shared/types";
import { cn } from "@/lib/utils";
import { StatusPill, TONE_DOT, TONE_TEXT } from "./status";

/**
 * What a confirmation is about to change, shown before anybody presses the button (spec §1.12, T2):
 * a few label/value lines, the modules gained and lost, and the rows it will touch. Server-safe — a
 * dialog renders these, and so can a page that previews an edit in place.
 */

const INTEGER = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

/** "Seats  10 → 15", "Billed by  Stripe" — one line per consequence, the value right-aligned. */
export function ImpactList({ items }: { items: { label: string; value: ReactNode; tone?: Tone }[] }) {
  if (items.length === 0) return null;
  return (
    <dl className="divide-y divide-line rounded-lg border border-line bg-surface-sunken">
      {items.map((item, i) => (
        <div key={`${i}-${item.label}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-3 py-2">
          <dt className="text-xs text-muted">{item.label}</dt>
          <dd className={cn("min-w-0 text-right text-sm font-medium tabular-nums break-words", item.tone ? TONE_TEXT[item.tone] : "text-text")}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Modules (or anything else) gained and lost. Each side is labelled in words as well as colour, and
 * a side with nothing on it is left out; when neither side has anything the change is said to be
 * none, rather than drawing two empty headings.
 */
export function DiffChips({
  added,
  removed,
  addedLabel = "Gained",
  removedLabel = "Lost",
}: {
  added: string[];
  removed: string[];
  addedLabel?: string;
  removedLabel?: string;
}) {
  if (added.length === 0 && removed.length === 0) return <p className="text-xs text-muted">No change.</p>;
  return (
    <div className="space-y-2">
      {added.length > 0 && <ChipRow label={addedLabel} names={added} tone="success" icon={<Plus className="h-3 w-3" />} />}
      {removed.length > 0 && <ChipRow label={removedLabel} names={removed} tone="danger" icon={<Minus className="h-3 w-3" />} />}
    </div>
  );
}

function ChipRow({ label, names, tone, icon }: { label: string; names: string[]; tone: Tone; icon: ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium text-muted">
        {label} <span className="tabular-nums">({INTEGER.format(names.length)})</span>
      </p>
      <ul className="mt-1 flex flex-wrap gap-1.5">
        {names.map((name, i) => (
          <li key={`${i}-${name}`}>
            <StatusPill tone={tone} icon={icon}>
              {name}
            </StatusPill>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The rows an action will touch — the first `max` of them, then "and N more". Enough to recognise
 * the selection without a fifty-line list pushing the confirm button off the screen.
 */
export function AffectedList({ rows, max = 10 }: { rows: { key: string; label: string; note?: string; tone?: Tone }[]; max?: number }) {
  const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 10;
  if (rows.length === 0) return <p className="text-xs text-muted">Nothing selected.</p>;
  const shown = rows.slice(0, limit);
  const more = rows.length - shown.length;
  return (
    <div className="rounded-lg border border-line">
      {shown.length > 0 && (
        <ul className="divide-y divide-line">
          {shown.map((row) => (
            <li key={row.key} className="flex items-center justify-between gap-3 px-3 py-1.5 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                {row.tone && <span aria-hidden="true" className={cn("h-1.5 w-1.5 shrink-0 rounded-full", TONE_DOT[row.tone])} />}
                <span className="min-w-0 truncate text-text" title={row.label}>
                  {row.label}
                </span>
              </span>
              {row.note && <span className={cn("shrink-0 text-xs", row.tone ? TONE_TEXT[row.tone] : "text-muted")}>{row.note}</span>}
            </li>
          ))}
        </ul>
      )}
      {more > 0 && <p className={cn("px-3 py-1.5 text-xs text-muted", shown.length > 0 && "border-t border-line")}>and {INTEGER.format(more)} more</p>}
    </div>
  );
}

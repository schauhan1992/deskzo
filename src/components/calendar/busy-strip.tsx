"use client";

import { useClock } from "@/components/time/clock-provider";
import { cn } from "@/lib/utils";

export type BusyRow = { key: string; label: string; blocks: { startsAt: string; endsAt: string }[]; note?: string | null };

const FIRST_HOUR = 7;
const LAST_HOUR = 21;

/**
 * A day from 7 am to 9 pm on the workspace's clock, one line a person: when they are busy, and the
 * time being proposed laid across all of them. Busy times only — what a colleague's time is taken by
 * is never sent here.
 */
export function BusyStrip({ dayKey, rows, proposal }: { dayKey: string; rows: BusyRow[]; proposal: { startsAt: Date; endsAt: Date } | null }) {
  const clock = useClock();
  const dayStart = clock.parseInput(`${dayKey}T${String(FIRST_HOUR).padStart(2, "0")}:00`);
  const dayEnd = clock.parseInput(`${dayKey}T${LAST_HOUR}:00`);
  if (!dayStart || !dayEnd) return null;
  const span = dayEnd.getTime() - dayStart.getTime();
  const place = (from: number, to: number) => {
    const left = Math.max(0, (from - dayStart.getTime()) / span);
    const right = Math.min(1, (to - dayStart.getTime()) / span);
    return right <= left ? null : { left: `${left * 100}%`, width: `${(right - left) * 100}%` };
  };
  const hours = Array.from({ length: LAST_HOUR - FIRST_HOUR + 1 }, (_, i) => FIRST_HOUR + i);
  const proposed = proposal ? place(proposal.startsAt.getTime(), proposal.endsAt.getTime()) : null;
  const clash = (row: BusyRow) =>
    !!proposal && row.blocks.some((b) => new Date(b.startsAt).getTime() < proposal.endsAt.getTime() && new Date(b.endsAt).getTime() > proposal.startsAt.getTime());

  return (
    <div className="space-y-1.5" aria-label="Busy times that day">
      <div className="ml-28 flex justify-between text-[10px] text-subtle" aria-hidden>
        {hours.filter((h) => h % 2 === 1).map((h) => (
          <span key={h}>{h <= 12 ? `${h === 12 ? 12 : h} ${h < 12 ? "am" : "pm"}` : `${h - 12} pm`}</span>
        ))}
      </div>
      {rows.map((row) => (
        <div key={row.key} className="flex items-center gap-2">
          <div className="w-26 shrink-0 truncate text-xs text-muted" title={row.label}>
            {row.label}
            {clash(row) && <span className="ml-1 text-warning">· busy</span>}
          </div>
          <div className="relative h-6 flex-1 overflow-hidden rounded-md border border-line bg-surface-sunken">
            {hours.slice(1, -1).map((h) => (
              <span key={h} className="absolute inset-y-0 w-px bg-line" style={{ left: `${((h - FIRST_HOUR) / (LAST_HOUR - FIRST_HOUR)) * 100}%` }} aria-hidden />
            ))}
            {row.note ? (
              <span className="absolute inset-0 flex items-center px-2 text-[11px] text-subtle">{row.note}</span>
            ) : (
              row.blocks.map((b, i) => {
                const at = place(new Date(b.startsAt).getTime(), new Date(b.endsAt).getTime());
                return at ? (
                  <span key={i} className="absolute inset-y-0.5 rounded bg-muted/40" style={at} title={`Busy ${clock.time(b.startsAt)} – ${clock.time(b.endsAt)}`} />
                ) : null;
              })
            )}
            {proposed && <span className={cn("absolute inset-y-0 rounded border-2", clash(row) ? "border-warning bg-warning/15" : "border-brand bg-brand/15")} style={proposed} aria-hidden />}
          </div>
        </div>
      ))}
    </div>
  );
}

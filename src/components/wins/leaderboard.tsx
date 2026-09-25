import { Award, Building2, Crown, Target, Trophy } from "lucide-react";
import { inrSpoken } from "@/lib/wins/copy";
import { cn } from "@/lib/utils";

export type LeaderRow = { rank: number; userId: string; name: string; booked: number | null; target: number | null; percent: number | null; isYou: boolean };
export type WinRow = { id: string; source: string; title: string; message: string | null; amount: number | null; ago: string; fresh: boolean; subject: { name: string } | null };

const MEDAL = ["#f59e0b", "#94a3b8", "#b45309"];
const SOURCE_ICON: Record<string, typeof Trophy> = { DEAL_WON: Trophy, TARGET_HIT: Target, FIRST_ORDER: Building2, TOP_PERFORMER: Crown };
const SOURCE_TONE: Record<string, string> = { DEAL_WON: "#10b981", TARGET_HIT: "#6366f1", FIRST_ORDER: "#06b6d4", TOP_PERFORMER: "#f59e0b" };

/**
 * This month, ranked by what was booked — with each person's progress to their own target, because
 * a salesperson at 140% of a small target has had a better month than the ranking alone says.
 *
 * `tv` is the same list at a size readable from across the room.
 */
export function Leaderboard({ rows, tv = false }: { rows: LeaderRow[]; tv?: boolean }) {
  if (rows.length === 0) {
    return <p className={cn("py-8 text-center text-subtle", tv ? "text-2xl" : "text-sm")}>Nothing booked yet this month. First one on the board gets the top spot.</p>;
  }
  return (
    <ol className={cn("divide-y", tv ? "divide-white/10" : "divide-line")}>
      {rows.map((row) => {
        const medal = MEDAL[row.rank - 1];
        return (
          <li key={row.userId} className={cn("flex items-center gap-3", tv ? "py-4" : "py-2.5", row.isYou && !tv && "rounded-lg bg-brand-subtle/40 px-2")}>
            <span
              className={cn("grid shrink-0 place-items-center rounded-full font-bold tabular-nums", tv ? "h-14 w-14 text-2xl" : "h-8 w-8 text-sm")}
              style={medal ? { backgroundColor: `${medal}26`, color: medal } : undefined}
            >
              {medal ? <Award className={tv ? "h-7 w-7" : "h-4 w-4"} aria-label={`Rank ${row.rank}`} /> : row.rank}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <span className={cn("truncate font-semibold", tv ? "text-3xl" : "text-sm text-text")}>
                  {row.name}
                  {row.isYou && !tv && <span className="ml-1.5 text-xs font-normal text-muted">you</span>}
                </span>
                <span className={cn("shrink-0 tabular-nums", tv ? "text-3xl font-bold" : "text-sm font-semibold text-text")}>
                  {row.booked !== null ? inrSpoken(row.booked) : row.percent !== null ? `${row.percent}%` : ""}
                </span>
              </div>
              {row.percent !== null && (
                <div className={cn("mt-1.5 flex items-center gap-2", tv ? "text-lg" : "text-[11px]")}>
                  <div className={cn("h-1.5 flex-1 overflow-hidden rounded-full", tv ? "h-3 bg-white/10" : "bg-surface-sunken")}>
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${Math.min(100, row.percent)}%`, backgroundColor: row.percent >= 100 ? "#10b981" : "#6366f1" }}
                    />
                  </div>
                  <span className={cn("tabular-nums", tv ? "text-white/70" : "text-muted")}>
                    {row.percent}% of {row.target !== null ? inrSpoken(row.target) : "target"}
                  </span>
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** The wins as they were announced, newest first. */
export function WinFeed({ wins, tv = false }: { wins: WinRow[]; tv?: boolean }) {
  if (wins.length === 0) {
    return <p className={cn("py-8 text-center text-subtle", tv ? "text-2xl" : "text-sm")}>No wins announced in the last 30 days — yet.</p>;
  }
  return (
    <ul className={cn("space-y-3", tv && "space-y-5")}>
      {wins.map((w) => {
        const Icon = SOURCE_ICON[w.source] ?? Trophy;
        const tone = SOURCE_TONE[w.source] ?? "#10b981";
        return (
          <li key={w.id} className="flex items-start gap-3">
            <span className={cn("grid shrink-0 place-items-center rounded-full", tv ? "h-12 w-12" : "h-8 w-8")} style={{ backgroundColor: `${tone}26`, color: tone }}>
              <Icon className={tv ? "h-6 w-6" : "h-4 w-4"} aria-hidden />
            </span>
            <div className="min-w-0">
              <div className={cn("font-semibold", tv ? "text-2xl" : "text-sm text-text")}>{w.title}</div>
              {w.message && <div className={cn(tv ? "text-lg text-white/70" : "text-xs text-muted")}>{w.message}</div>}
              <div className={cn(tv ? "text-base text-white/50" : "text-[11px] text-subtle")}>{w.ago}</div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

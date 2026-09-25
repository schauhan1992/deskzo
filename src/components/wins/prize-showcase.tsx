import { Gift } from "lucide-react";
import type { ShowcaseRace } from "@/actions/prizes";
import { cn } from "@/lib/utils";

/** Gold, silver, bronze — the same as the leaderboard. */
const MEDAL: Record<string, string> = { "1": "#f59e0b", "2": "#94a3b8", "3": "#b45309" };

/**
 * What is up for grabs, with pictures — flaunted beside the race for it, on the wall and on the TV.
 * Renders nothing when no prize is set.
 */
export function PrizeShowcase({ races, tv = false }: { races: ShowcaseRace[]; tv?: boolean }) {
  if (races.length === 0) return null;
  return (
    <section
      aria-label="Up for grabs"
      className={cn(
        "overflow-hidden rounded-2xl border",
        tv ? "border-amber-300/20 bg-gradient-to-br from-amber-500/15 to-fuchsia-500/10 p-6" : "border-line bg-gradient-to-br from-amber-500/10 via-surface to-surface p-4",
      )}
    >
      <div className={cn("flex items-center gap-2 font-semibold", tv ? "mb-4 text-2xl text-amber-300" : "mb-3 text-sm text-text")}>
        <Gift className={tv ? "h-7 w-7" : "h-4 w-4"} style={{ color: MEDAL["1"] }} aria-hidden />
        Up for grabs
      </div>
      <div className={cn("grid gap-4", races.length > 1 && !tv ? "lg:grid-cols-2" : "", tv && races.length > 1 ? "grid-cols-2" : "")}>
        {races.map((r) => (
          <div key={r.race}>
            <div className={cn(tv ? "mb-3 text-lg text-white/60" : "mb-2 text-xs text-muted")}>
              {r.label} · <span className={tv ? "text-white/80" : "text-text"}>{r.periodLabel}</span>
            </div>
            <ul className={cn("grid gap-3", tv ? "grid-cols-3" : "grid-cols-2 sm:grid-cols-3")}>
              {r.items.map((item) => (
                <li key={item.slot} className={cn("overflow-hidden rounded-xl", tv ? "bg-white/5" : "border border-line bg-surface")}>
                  <div className={cn("relative grid aspect-[4/3] place-items-center", tv ? "bg-white/5" : "bg-surface-sunken")}>
                    {item.imageDataUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- a data URL; next/image has nothing to optimise
                      <img src={item.imageDataUrl} alt={item.name} className="h-full w-full object-cover" />
                    ) : (
                      <Gift className={cn(tv ? "h-12 w-12 text-white/30" : "h-8 w-8 text-subtle")} aria-hidden />
                    )}
                    <span
                      className={cn("absolute left-2 top-2 rounded-full px-2 py-0.5 font-semibold text-white shadow", tv ? "text-sm" : "text-[10px]")}
                      style={{ backgroundColor: MEDAL[item.slot] ?? "#6366f1" }}
                    >
                      {item.slotLabel}
                    </span>
                  </div>
                  <div className={tv ? "p-3" : "p-2.5"}>
                    <div className={cn("font-semibold leading-snug", tv ? "text-xl" : "text-sm text-text")}>{item.name}</div>
                    {item.note && <div className={cn(tv ? "mt-1 text-base text-white/60" : "mt-0.5 text-xs text-subtle")}>{item.note}</div>}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

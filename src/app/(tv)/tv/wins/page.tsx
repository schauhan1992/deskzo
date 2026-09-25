import type { Metadata } from "next";
import { Crown, Target, Trophy, Building2 } from "lucide-react";
import { isModuleEnabled } from "@/actions/module";
import { getWinsWall } from "@/actions/wins";
import { getPrizeShowcase } from "@/actions/prizes";
import { PrizeShowcase } from "@/components/wins/prize-showcase";
import { getOrganisation } from "@/lib/organisation";
import { Leaderboard, WinFeed } from "@/components/wins/leaderboard";
import { TvRefresh } from "@/components/wins/tv-refresh";
import { Confetti } from "@/components/layout/celebration-splash";
import { inrSpoken } from "@/lib/wins/copy";

export const metadata: Metadata = { title: "Wins" };

const ICON: Record<string, typeof Trophy> = { DEAL_WON: Trophy, TARGET_HIT: Target, FIRST_ORDER: Building2, TOP_PERFORMER: Crown };

/**
 * The sales floor's screen: the prizes up for grabs, the leaderboard, the latest win large, and the
 * month so far. Refreshes itself every minute. A win from the last two hours takes the top of the
 * right-hand side, with confetti — keyed on the win, so a new one sets it off again.
 */
export default async function WinsTvPage() {
  if (!(await isModuleEnabled("wins"))) {
    return <p className="grid min-h-screen place-items-center text-2xl text-white/60">The wins board is switched off.</p>;
  }
  const [wall, org, showcase] = await Promise.all([getWinsWall(), getOrganisation(), getPrizeShowcase()]);
  if (!wall) return <p className="grid min-h-screen place-items-center text-2xl text-white/60">The wins board is switched off.</p>;
  const latest = wall.wins.find((w) => w.fresh) ?? null;
  const LatestIcon = latest ? (ICON[latest.source] ?? Trophy) : Trophy;
  const c = wall.counts;

  return (
    <div className="relative flex min-h-screen flex-col gap-6 overflow-hidden p-8">
      {latest && <Confetti key={latest.id} accent="#f59e0b" pieces={120} />}

      <header className="flex items-baseline justify-between gap-6">
        <div>
          <div className="text-lg uppercase tracking-widest text-white/50">{org.tradeName || org.legalName || "Sales"}</div>
          <h1 className="text-5xl font-bold">Wins — {wall.monthLabel}</h1>
        </div>
        <div className="text-5xl font-light text-white/80">
          <TvRefresh />
        </div>
      </header>

      <section className="grid grid-cols-4 gap-4">
        <Tile label="Booked this month" value={c.booked !== null ? inrSpoken(c.booked) : "—"} hint={c.target ? `of ${inrSpoken(c.target)}` : undefined} />
        <Tile label="Deals won" value={String(c.dealsWon)} />
        <Tile label="New customers" value={String(c.newCustomers)} />
        <Tile label="Targets reached" value={String(c.targetsHit)} />
      </section>

      {/* What they are playing for, in pictures — the reason to look up at the screen. */}
      <PrizeShowcase races={showcase} tv />

      <main className="grid flex-1 grid-cols-5 gap-6">
        <section className="col-span-3 rounded-2xl bg-white/5 p-6">
          <h2 className="mb-2 text-2xl font-semibold text-white/70">Leaderboard</h2>
          <Leaderboard rows={wall.leaderboard.slice(0, 8)} tv />
        </section>
        <section className="col-span-2 flex flex-col gap-6">
          {latest && (
            <div className="rounded-2xl bg-gradient-to-br from-amber-500/30 to-emerald-500/20 p-6">
              <div className="flex items-center gap-3 text-xl uppercase tracking-widest text-amber-300">
                <LatestIcon className="h-7 w-7" aria-hidden />
                Just now
              </div>
              <div className="mt-3 text-4xl font-bold leading-tight">{latest.title}</div>
              {latest.message && <div className="mt-2 text-2xl text-white/80">{latest.message}</div>}
            </div>
          )}
          <div className="flex-1 rounded-2xl bg-white/5 p-6">
            <h2 className="mb-4 text-2xl font-semibold text-white/70">Recent wins</h2>
            <WinFeed wins={wall.wins.filter((w) => w.id !== latest?.id).slice(0, 5)} tv />
          </div>
        </section>
      </main>
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl bg-white/5 px-6 py-4">
      <div className="text-lg text-white/60">{label}</div>
      <div className="text-4xl font-bold tabular-nums">{value}</div>
      {hint && <div className="text-lg text-white/50">{hint}</div>}
    </div>
  );
}

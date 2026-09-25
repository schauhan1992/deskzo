import Link from "next/link";
import { MonitorPlay } from "lucide-react";
import { isModuleEnabled } from "@/actions/module";
import { getWinsWall } from "@/actions/wins";
import { getPrizeShowcase } from "@/actions/prizes";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Leaderboard, WinFeed } from "@/components/wins/leaderboard";
import { PrizeShowcase } from "@/components/wins/prize-showcase";
import { inrSpoken } from "@/lib/wins/copy";

/**
 * The wins wall: what is up for grabs, this month's leaderboard, and the wins as they were announced.
 * The settings behind it are on their own tab — see ./settings.
 */
export default async function WinsPage() {
  if (!(await isModuleEnabled("wins"))) return <ModuleDisabledNotice moduleKey="wins" />;
  const [wall, showcase] = await Promise.all([getWinsWall(), getPrizeShowcase()]);
  if (!wall) return <ModuleDisabledNotice moduleKey="wins" />;
  const c = wall.counts;

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Wins — {wall.monthLabel}</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            Big deals, targets reached and new customers celebrate themselves the moment they happen, and the month&apos;s top
            performer is announced on the 1st. This is the board everybody sees.
          </p>
        </div>
        <Link href="/tv/wins" target="_blank">
          <Button variant="secondary" size="sm">
            <MonitorPlay className="h-3.5 w-3.5" />
            Open the TV screen
          </Button>
        </Link>
      </div>

      {showcase.length > 0 && (
        <div className="mt-4">
          <PrizeShowcase races={showcase} />
        </div>
      )}

      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Booked this month" value={c.booked !== null ? inrSpoken(c.booked) : "—"} hint={c.target ? `of ${inrSpoken(c.target)} targeted` : undefined} />
        <Stat label="Deals won" value={String(c.dealsWon)} />
        <Stat label="New customers" value={String(c.newCustomers)} />
        <Stat label="Targets reached" value={String(c.targetsHit)} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <h2 className="text-sm font-semibold text-text">Leaderboard</h2>
            <p className="text-xs text-subtle">Orders booked this month at the selling price, before GST — the order value target&apos;s own measure.</p>
          </CardHeader>
          <CardContent>
            <Leaderboard rows={wall.leaderboard} />
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <h2 className="text-sm font-semibold text-text">Recent wins</h2>
          </CardHeader>
          <CardContent>
            <WinFeed wins={wall.wins} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-0.5 text-2xl font-semibold tabular-nums text-text">{value}</div>
      {hint && <div className="text-[11px] text-subtle">{hint}</div>}
    </Card>
  );
}

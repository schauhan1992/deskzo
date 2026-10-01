import { isModuleEnabled } from "@/actions/module";
import { getWinsSettings } from "@/actions/wins";
import { getPrizesAdmin } from "@/actions/prizes";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { WinsSettings } from "@/components/wins/wins-settings";
import { AwardSettings } from "@/components/wins/award-settings";
import { PrizesManager } from "@/components/wins/prizes-manager";
import { awardSettings } from "@/lib/performance/award-settings";
import { METRICS } from "@/lib/targets/metrics";
import type { TargetMetric } from "@prisma/client";
import { RACE_LABEL, SLOTS } from "@/lib/wins/prizes";

export const metadata = { title: "Prizes & settings" };

/**
 * Everything behind the wins wall, for whoever holds "wins.manage": the prizes, what celebrates
 * itself, and the most-active awards.
 */
export default async function WinsSettingsPage() {
  if (!(await isModuleEnabled("wins"))) return <ModuleDisabledNotice moduleKey="wins" />;
  const [settings, admin] = await Promise.all([getWinsSettings(), getPrizesAdmin()]);
  if (!settings || !admin) {
    return (
      <div className="max-w-md">
        <h1 className="text-xl font-semibold text-text">Prizes & settings</h1>
        <p className="mt-2 text-sm text-muted">You can&apos;t change how wins are celebrated or what the prizes are.</p>
      </div>
    );
  }
  const awards = await awardSettings();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-text">Prizes & settings</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Set a standing prize for each place, or plan a special one for a particular month or fortnight. Everybody sees them on the wall
          and the TV, hears about them as each period opens, and the winners&apos; announcement names what they won.
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <PrizesManager
          race="TOP_SELLERS"
          title={`Prizes — ${RACE_LABEL.TOP_SELLERS.toLowerCase()}`}
          blurb="For the top three on the leaderboard, by order value booked. Announced with the month's top performer on the 1st."
          slots={SLOTS.TOP_SELLERS}
          periods={admin.periods.TOP_SELLERS}
          prizes={admin.prizes.filter((p) => p.race === "TOP_SELLERS")}
          isPublic={admin.isPublic.TOP_SELLERS}
          lastAnnounced={admin.lastAnnounced.TOP_SELLERS}
        />
        <PrizesManager
          race="MOST_ACTIVE"
          title={`Prizes — ${RACE_LABEL.MOST_ACTIVE.toLowerCase()}`}
          blurb="For the three most active, and the most active in sales and in support. Announced on the 1st and the 16th."
          slots={SLOTS.MOST_ACTIVE}
          periods={admin.periods.MOST_ACTIVE}
          prizes={admin.prizes.filter((p) => p.race === "MOST_ACTIVE")}
          isPublic={admin.isPublic.MOST_ACTIVE}
          lastAnnounced={admin.lastAnnounced.MOST_ACTIVE}
        />
      </div>

      {/* `as TargetMetric`: PURCHASE_SAVINGS is in METRICS ahead of the enum (see MetricKey in src/lib/targets/metrics.ts). */}
      <WinsSettings initial={settings} metrics={METRICS.map((m) => ({ key: m.key as TargetMetric, label: m.label }))} />

      <div>
        <h2 className="mb-2 text-sm font-semibold text-text">Most active of the fortnight</h2>
        <AwardSettings initial={awards} />
      </div>
    </div>
  );
}

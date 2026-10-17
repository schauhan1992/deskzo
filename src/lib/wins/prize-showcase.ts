import type { PrizeRace } from "@prisma/client";
import { toPlain } from "@/lib/serialize";
import { awardSettings } from "@/lib/performance/award-settings";
import { winsSettings } from "@/lib/wins/detect";
import { prizesForPeriod } from "@/lib/wins/prize-store";
import { raceIsPublic, RACES } from "@/lib/wins/prize-announce";
import { currentPeriod, RACE_LABEL, SLOTS } from "@/lib/wins/prizes";
import { workspaceClock } from "@/lib/time/workspace";

export type ShowcaseItem = { slot: string; slotLabel: string; name: string; note: string | null; imageDataUrl: string | null };
export type ShowcaseRace = { race: PrizeRace; label: string; periodLabel: string; items: ShowcaseItem[] };

/**
 * The prizes up for grabs right now, for every race run where everybody can see it — for the Wins page
 * (src/actions/prizes.ts) and the office TV (src/app/(tv)/tv/wins). Not a "use server" module: the callers
 * decide who may see it.
 */
export async function prizeShowcase(): Promise<ShowcaseRace[]> {
  const [awards, wins, clock] = await Promise.all([awardSettings(), winsSettings(), workspaceClock()]);
  const now = new Date();
  const out: ShowcaseRace[] = [];
  for (const race of RACES) {
    if (!raceIsPublic(race, awards, wins)) continue;
    const period = currentPeriod(race, now, clock);
    const prizes = await prizesForPeriod(race, period.key);
    const items = SLOTS[race].flatMap(({ slot, label }) => {
      const p = prizes.get(slot);
      return p ? [{ slot, slotLabel: label, name: p.name, note: p.note, imageDataUrl: p.imageDataUrl }] : [];
    });
    if (items.length) out.push({ race, label: RACE_LABEL[race], periodLabel: period.label, items });
  }
  return toPlain(out);
}

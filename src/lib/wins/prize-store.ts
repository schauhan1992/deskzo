import type { AwardAudience, Prize, PrizeRace } from "@prisma/client";
import { db } from "@/lib/db";
import { prizesFor, type Slot } from "@/lib/wins/prizes";
import { moduleAvailableForTenant } from "@/lib/modules-access";

/**
 * Prizes from the database — read for a period, and copied onto the winners' lines when a result is
 * announced. Used by both races' announcers, which is why it imports neither.
 */

export async function prizesForPeriod(race: PrizeRace, period: string): Promise<Map<Slot, Prize>> {
  const rows = await db.prize.findMany({ where: { race, period: { in: ["", period] } } });
  return prizesFor(race, period, rows);
}

/** The prize names by slot, as the announcement wording takes them. */
export function prizeNames(prizes: Map<Slot, Prize>): Partial<Record<string, string>> {
  return Object.fromEntries([...prizes].map(([slot, p]) => [slot, p.name]));
}

/** Whether the wins module is on: in the workspace's plan, and not switched off. */
export async function winsModuleOn(): Promise<boolean> {
  return moduleAvailableForTenant("wins");
}

/**
 * Winners onto the hall of fame, each with the prize their slot carried at the moment of announcing.
 * One line per race, period and slot — a second announcement of the same result adds nothing.
 */
export async function recordWinners(input: {
  race: PrizeRace;
  period: string;
  periodLabel: string;
  audience: AwardAudience;
  prizes: Map<Slot, Prize>;
  /** A slot is "1", "2"… for places — past third they carry no prize — or "sales" / "support". */
  winners: { slot: string; userId: string; score: number }[];
}): Promise<void> {
  if (input.winners.length === 0) return;
  await db.prizeWinner.createMany({
    data: input.winners.map((w) => {
      const prize = input.prizes.get(w.slot as Slot);
      return {
        race: input.race,
        period: input.period,
        periodLabel: input.periodLabel,
        slot: w.slot,
        userId: w.userId,
        score: Math.round(w.score * 100) / 100,
        prizeName: prize?.name ?? null,
        prizeNote: prize?.note ?? null,
        prizeImage: prize?.imageDataUrl ?? null,
        audience: input.audience,
      };
    }),
    skipDuplicates: true,
  });
}

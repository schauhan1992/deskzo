import type { Prize, PrizeRace, SplashScope } from "@prisma/client";
import { db } from "@/lib/db";
import { notifyUser } from "@/lib/notify";
import { addDays } from "@/lib/hr/calendar";
import { workspaceClock } from "@/lib/time/workspace";
import { awardSettings, type AwardSettings } from "@/lib/performance/award-settings";
import { winsSettings, type WinsSettings } from "@/lib/wins/detect";
import { prizesForPeriod, winsModuleOn } from "@/lib/wins/prize-store";
import { tenantKey } from "@/lib/tenancy/cache";
import { prizeAnnouncementDue, upForGrabsCopy, type PrizePeriod, type Slot } from "@/lib/wins/prizes";

/**
 * Telling everybody what is up for grabs.
 *
 * Automatically, once, as a month (top sellers) or a fortnight (the most active) opens — claimed by a
 * unique key, like every other announcement here, so the tick and a dashboard load can race and it
 * still goes once. And by hand, whenever somebody who runs the prizes changes them mid-period.
 *
 * A race is only advertised while it is run for everybody to see: the top sellers while the monthly
 * top performer is on, the most active while its awards are on and told to more than the managers. A
 * prize nobody is allowed to hear the result of is not something to put on a splash.
 */

export const RACES: PrizeRace[] = ["TOP_SELLERS", "MOST_ACTIVE"];

export const PRIZES_LINK: Record<PrizeRace, string> = { TOP_SELLERS: "/wins", MOST_ACTIVE: "/wins/most-active" };

export function raceIsPublic(race: PrizeRace, awards: AwardSettings, wins: WinsSettings): boolean {
  return race === "TOP_SELLERS" ? wins.topPerformer : awards.enabled && awards.audience !== "MANAGERS";
}

/** "Everybody" is the full-screen splash; otherwise a line in everybody's greeting strip. */
function splashFor(race: PrizeRace, awards: AwardSettings, wins: WinsSettings): SplashScope {
  if (race === "TOP_SELLERS") return wins.topPerformerSplash;
  return awards.splash ? "EVERYONE" : "SUBJECT";
}

/** The notification to everybody, and the splash — for an announcement already claimed. */
export async function tellEverybody(input: {
  race: PrizeRace;
  period: PrizePeriod;
  prizes: Map<Slot, Prize>;
  announcementId: string;
  splash: SplashScope;
  now: Date;
}): Promise<void> {
  const copy = upForGrabsCopy(input.race, input.period.label, input.prizes);
  const people = await db.user.findMany({ where: { active: true }, select: { id: true } });
  for (const p of people) await notifyUser({ userId: p.id, type: "ACTIVITY_AWARD", link: PRIZES_LINK[input.race], ...copy });
  // Today on the workspace's calendar, as the date columns hold a day (dateOnly was UTC's day).
  const today = (await workspaceClock()).calendarDate(input.now);
  try {
    await db.celebration.create({
      data: {
        kind: "ACHIEVEMENT",
        audience: "EVERYONE",
        source: "PRIZES",
        occasionKey: `prizes:${input.announcementId}`,
        ...copy,
        imageDataUrl: input.prizes.get("1")?.imageDataUrl ?? [...input.prizes.values()].find((p) => p.imageDataUrl)?.imageDataUrl ?? null,
        // Nobody is the subject of a prize list, so "the winner" gets nobody the splash — the strip.
        splashFor: input.splash,
        subjectUserId: null,
        startsOn: today,
        endsOn: addDays(today, 1),
        createdById: null,
        details: { race: input.race, period: input.period.key },
      },
    });
  } catch {
    // The key is the announcement's own id — a clash would mean it was already put up.
  }
}

/** The automatic announcements, for whichever periods have just opened. */
export async function announcePrizes(now: Date = new Date()): Promise<{ announced: string[] }> {
  if (!(await winsModuleOn())) return { announced: [] };
  const [awards, wins, clock] = await Promise.all([awardSettings(), winsSettings(), workspaceClock()]);
  const announced: string[] = [];
  for (const race of RACES) {
    if (!raceIsPublic(race, awards, wins)) continue;
    const period = prizeAnnouncementDue(race, now, clock);
    if (!period) continue;
    const prizes = await prizesForPeriod(race, period.key);
    if (prizes.size === 0) continue;
    let announcementId: string;
    try {
      const row = await db.prizeAnnouncement.create({ data: { race, period: period.key, autoKey: `auto:${race}:${period.key}` } });
      announcementId = row.id;
    } catch {
      continue; // Announced already, by this run's twin.
    }
    await tellEverybody({ race, period, prizes, announcementId, splash: splashFor(race, awards, wins), now });
    announced.push(`${race}:${period.key}`);
  }
  return { announced };
}

/** For the button: the settings decide how loud it is, exactly as for the automatic one. */
export async function prizeSplashFor(race: PrizeRace): Promise<SplashScope> {
  const [awards, wins] = await Promise.all([awardSettings(), winsSettings()]);
  return splashFor(race, awards, wins);
}

export async function raceIsPublicNow(race: PrizeRace): Promise<boolean> {
  const [awards, wins] = await Promise.all([awardSettings(), winsSettings()]);
  return raceIsPublic(race, awards, wins);
}

/** When each workspace last had its turn — one workspace's dashboard must not use up another's. */
const lastLazyRun = new Map<string, number>();

/** From the dashboard, at most every five minutes per workspace. Never throws. */
export async function announcePrizesLazily(now: Date = new Date()): Promise<void> {
  const key = await tenantKey();
  if (now.getTime() - (lastLazyRun.get(key) ?? 0) < 5 * 60_000) return;
  lastLazyRun.set(key, now.getTime());
  await announcePrizes(now).catch((err) => console.error("prizes could not be announced", err));
}

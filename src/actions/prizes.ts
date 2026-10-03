"use server";

import { revalidatePath } from "next/cache";
import type { AwardAudience, PrizeRace } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { toPlain } from "@/lib/serialize";
import { isModuleEnabled } from "@/actions/module";
import { awardSettings } from "@/lib/performance/award-settings";
import { winsSettings } from "@/lib/wins/detect";
import { prizesForPeriod } from "@/lib/wins/prize-store";
import { prizeSplashFor, raceIsPublic, raceIsPublicNow, RACES, tellEverybody } from "@/lib/wins/prize-announce";
import { checkPrizeImage, currentPeriod, isSlot, periodByKey, RACE_LABEL, SLOTS, slotLabel, upcomingPeriods } from "@/lib/wins/prizes";
import { workspaceClock } from "@/lib/time/workspace";
import type { ActionResult } from "@/actions/company";

/**
 * Prizes: what is up for grabs (everybody), setting them and announcing them (wins.manage), and the
 * hall of fame of who won what.
 */

export type ShowcaseItem = { slot: string; slotLabel: string; name: string; note: string | null; imageDataUrl: string | null };
export type ShowcaseRace = { race: PrizeRace; label: string; periodLabel: string; items: ShowcaseItem[] };

/** The prizes up for grabs right now, for every race run where everybody can see it. */
export async function getPrizeShowcase(): Promise<ShowcaseRace[]> {
  await requireModuleUser("wins");
  if (!(await isModuleEnabled("wins"))) return [];
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

export type PrizeRow = { race: PrizeRace; period: string; slot: string; name: string; note: string | null; imageDataUrl: string | null };

export async function getPrizesAdmin(): Promise<{
  prizes: PrizeRow[];
  periods: Record<PrizeRace, { key: string; label: string }[]>;
  isPublic: Record<PrizeRace, boolean>;
  lastAnnounced: Record<PrizeRace, Date | null>;
} | null> {
  const user = await requireModuleUser("wins");
  if (!(await isModuleEnabled("wins")) || !(await can(user.id, "wins.manage"))) return null;
  const now = new Date();
  const clock = await workspaceClock();
  const periods = {
    TOP_SELLERS: upcomingPeriods("TOP_SELLERS", now, clock).map(({ key, label }) => ({ key, label })),
    MOST_ACTIVE: upcomingPeriods("MOST_ACTIVE", now, clock).map(({ key, label }) => ({ key, label })),
  };
  const [rows, awards, wins, lastSellers, lastActive] = await Promise.all([
    db.prize.findMany({
      where: { OR: [{ period: "" }, ...RACES.map((race) => ({ race, period: { in: periods[race].map((p) => p.key) } }))] },
      select: { race: true, period: true, slot: true, name: true, note: true, imageDataUrl: true },
    }),
    awardSettings(),
    winsSettings(),
    db.prizeAnnouncement.findFirst({ where: { race: "TOP_SELLERS" }, orderBy: { announcedAt: "desc" }, select: { announcedAt: true } }),
    db.prizeAnnouncement.findFirst({ where: { race: "MOST_ACTIVE" }, orderBy: { announcedAt: "desc" }, select: { announcedAt: true } }),
  ]);
  return toPlain({
    prizes: rows,
    periods,
    isPublic: { TOP_SELLERS: raceIsPublic("TOP_SELLERS", awards, wins), MOST_ACTIVE: raceIsPublic("MOST_ACTIVE", awards, wins) },
    lastAnnounced: { TOP_SELLERS: lastSellers?.announcedAt ?? null, MOST_ACTIVE: lastActive?.announcedAt ?? null },
  });
}

const MAX_NAME = 80;
const MAX_NOTE = 160;

/**
 * Sets one slot's prize — standing ("" period) or for one month or fortnight. `image` undefined keeps
 * the picture, null removes it, a string replaces it.
 */
export async function savePrize(input: {
  race: PrizeRace;
  period: string;
  slot: string;
  name: string;
  note?: string | null;
  image?: string | null;
}): Promise<ActionResult<null>> {
  const user = await requireModuleUser("wins");
  if (!(await can(user.id, "wins.manage"))) return { ok: false, error: "You can't set the prizes." };
  if (!RACES.includes(input.race)) return { ok: false, error: "Pick which prizes these are." };
  if (!isSlot(input.race, input.slot)) return { ok: false, error: "That place doesn't carry a prize." };
  const period = input.period ?? "";
  const clock = await workspaceClock();
  if (period !== "") {
    const p = periodByKey(input.race, period, clock);
    if (!p) return { ok: false, error: input.race === "TOP_SELLERS" ? "Plan prizes for a month." : "Plan prizes for a fortnight." };
    if (p.to.getTime() <= Date.now()) return { ok: false, error: `${p.label} is over — its prizes can't change now.` };
  }
  const name = input.name?.trim() ?? "";
  if (!name) return { ok: false, error: "Say what the prize is." };
  if (name.length > MAX_NAME) return { ok: false, error: `Keep the prize to ${MAX_NAME} characters — the rest can go in the note.` };
  const note = input.note?.trim() || null;
  if (note && note.length > MAX_NOTE) return { ok: false, error: `Keep the note to ${MAX_NOTE} characters.` };
  if (typeof input.image === "string") {
    const check = checkPrizeImage(input.image);
    if (!check.ok) return { ok: false, error: check.error };
  }

  const data = {
    name,
    note,
    ...(input.image !== undefined ? { imageDataUrl: input.image } : {}),
    updatedById: user.id,
  };
  await db.prize.upsert({
    where: { race_period_slot: { race: input.race, period, slot: input.slot } },
    create: { race: input.race, period, slot: input.slot, ...data },
    update: data,
  });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Prize",
    entityId: `${input.race}:${period || "standing"}:${input.slot}`,
    entityLabel: `${slotLabel(input.race, input.slot)} prize${period ? `, ${periodByKey(input.race, period, clock)!.label}` : ""}: ${name}`,
  });
  revalidatePath("/wins", "layout");
  return { ok: true, data: null };
}

export async function deletePrize(input: { race: PrizeRace; period: string; slot: string }): Promise<ActionResult<null>> {
  const user = await requireModuleUser("wins");
  if (!(await can(user.id, "wins.manage"))) return { ok: false, error: "You can't set the prizes." };
  const removed = await db.prize.deleteMany({ where: { race: input.race, period: input.period ?? "", slot: input.slot } });
  if (removed.count) {
    await recordAudit({
      userId: user.id,
      action: "DELETE",
      entityType: "Prize",
      entityId: `${input.race}:${input.period || "standing"}:${input.slot}`,
      entityLabel: `${slotLabel(input.race, input.slot)} prize removed`,
    });
  }
  revalidatePath("/wins", "layout");
  return { ok: true, data: null };
}

/** Pressing it twice in a row is almost always a double click, not a second announcement. */
const ANNOUNCE_GAP_MS = 10 * 60_000;

export async function announcePrizesNow(race: PrizeRace): Promise<ActionResult<{ period: string }>> {
  const user = await requireModuleUser("wins");
  if (!(await can(user.id, "wins.manage"))) return { ok: false, error: "You can't announce the prizes." };
  if (!RACES.includes(race)) return { ok: false, error: "Pick which prizes to announce." };
  if (!(await isModuleEnabled("wins"))) return { ok: false, error: "The wins module is switched off." };
  if (!(await raceIsPublicNow(race))) {
    return {
      ok: false,
      error:
        race === "TOP_SELLERS"
          ? "The month's top performer is switched off, so there is nothing for these prizes to be won in."
          : "The most-active awards are off, or told to managers only — so their prizes aren't announced to everybody.",
    };
  }
  const now = new Date();
  const period = currentPeriod(race, now, await workspaceClock());
  const prizes = await prizesForPeriod(race, period.key);
  if (prizes.size === 0) return { ok: false, error: `No prizes are set for ${period.label} yet.` };
  const recent = await db.prizeAnnouncement.findFirst({
    where: { race, period: period.key, announcedAt: { gte: new Date(now.getTime() - ANNOUNCE_GAP_MS) } },
    select: { id: true },
  });
  if (recent) return { ok: false, error: "They were announced a few minutes ago." };

  const row = await db.prizeAnnouncement.create({ data: { race, period: period.key, announcedById: user.id } });
  await tellEverybody({ race, period, prizes, announcementId: row.id, splash: await prizeSplashFor(race), now });
  await recordAudit({ userId: user.id, action: "CREATE", entityType: "PrizeAnnouncement", entityId: row.id, entityLabel: `Prizes announced: ${RACE_LABEL[race]}, ${period.label}` });
  revalidatePath("/wins", "layout");
  return { ok: true, data: { period: period.label } };
}

export async function setPrizeHandedOver(id: string, handedOver: boolean): Promise<ActionResult<null>> {
  const user = await requireModuleUser("wins");
  if (!(await can(user.id, "wins.manage"))) return { ok: false, error: "You can't mark prizes as handed over." };
  const winner = await db.prizeWinner.findUnique({ where: { id }, select: { id: true, prizeName: true, periodLabel: true } });
  if (!winner) return { ok: false, error: "That win isn't there any more." };
  await db.prizeWinner.update({
    where: { id },
    data: handedOver ? { handedOverAt: new Date(), handedOverById: user.id } : { handedOverAt: null, handedOverById: null },
  });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "PrizeWinner",
    entityId: id,
    entityLabel: `${winner.prizeName ?? "Prize"}, ${winner.periodLabel}: ${handedOver ? "handed over" : "not handed over yet"}`,
  });
  revalidatePath("/wins/hall-of-fame");
  return { ok: true, data: null };
}

export type HallOfFameRow = {
  id: string;
  race: PrizeRace;
  period: string;
  periodLabel: string;
  slot: string;
  slotLabel: string;
  userId: string;
  name: string;
  score: number;
  prizeName: string | null;
  prizeNote: string | null;
  prizeImage: string | null;
  audience: AwardAudience;
  handedOverAt: Date | null;
  isYou: boolean;
};

/**
 * Who won what. Told to everybody, everybody sees it; told only to the winners, each winner sees their
 * own; told to the managers, the managers. Whoever runs the prizes, and whoever can see team
 * performance, sees all of it — they are the ones handing the prizes over.
 */
export async function getHallOfFame(): Promise<{ canManage: boolean; rows: HallOfFameRow[] } | null> {
  const user = await requireModuleUser("wins");
  if (!(await isModuleEnabled("wins"))) return null;
  const [canManage, canSeeAll] = await Promise.all([can(user.id, "wins.manage"), can(user.id, "performance.view")]);
  const rows = await db.prizeWinner.findMany({
    orderBy: [{ announcedAt: "desc" }, { race: "asc" }],
    take: 300,
    include: { user: { select: { name: true } } },
  });
  const visible = rows.filter((r) => canManage || canSeeAll || r.audience === "EVERYONE" || (r.audience === "WINNERS" && r.userId === user.id));
  return toPlain({
    canManage,
    rows: visible.map((r) => ({
      id: r.id,
      race: r.race,
      period: r.period,
      periodLabel: r.periodLabel,
      slot: r.slot,
      slotLabel: isSlot(r.race, r.slot) ? slotLabel(r.race, r.slot) : `Number ${r.slot}`,
      userId: r.userId,
      name: r.user.name,
      score: Number(r.score),
      prizeName: r.prizeName,
      prizeNote: r.prizeNote,
      prizeImage: r.prizeImage,
      audience: r.audience,
      handedOverAt: r.handedOverAt,
      isYou: r.userId === user.id,
    })),
  });
}

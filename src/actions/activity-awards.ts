"use server";

import { revalidatePath } from "next/cache";
import type { AwardAudience } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { isModuleEnabled } from "@/actions/module";
import { toPlain } from "@/lib/serialize";
import {
  ANNOUNCE_FROM_HOUR,
  entryOf,
  fortnightContaining,
  type AwardEntry,
  type Standing,
} from "@/lib/performance/awards";
import { awardSettings, standingsFor, type AwardSettings, type StoredAreas, type StoredAward } from "@/lib/performance/announce";
import type { ActionResult } from "@/actions/company";

/**
 * The most-active awards, as each person is allowed to see them.
 *
 * The audience chosen when a fortnight was announced still governs who can read it afterwards —
 * changing the setting to "everybody" does not publish a ranking that was only ever given to the
 * managers. People who can see team performance see everything, as they already can on /performance.
 */

export type AwardView = {
  period: string;
  label: string;
  announcedAt: Date;
  audience: AwardAudience;
  winners: AwardEntry[];
  sales: AwardEntry | null;
  support: AwardEntry | null;
  /** The ranking behind it — only for people who can see team performance. */
  ranking: Standing[] | null;
  /** Whether the person looking is among the winners. */
  mine: boolean;
};

const AUDIENCES: AwardAudience[] = ["EVERYONE", "MANAGERS", "WINNERS"];

export async function getActivityAwards(): Promise<{
  canSeeStandings: boolean;
  canManage: boolean;
  settings: AwardSettings;
  current: { label: string; announcesOn: string; standings: Standing[] | null; mine: Standing | null };
  history: AwardView[];
} | null> {
  const user = await requireModuleUser("wins");
  // Part of the wins wall: switched off with it.
  if (!(await isModuleEnabled("wins"))) return null;
  const now = new Date();
  const [canSeeStandings, canManage, settings, rows] = await Promise.all([
    can(user.id, "performance.view"),
    can(user.id, "wins.manage"),
    awardSettings(),
    db.activityAward.findMany({ orderBy: { from: "desc" }, take: 12 }),
  ]);

  const fortnight = fortnightContaining(now);
  const standings = await standingsFor(fortnight);
  const announcesOn = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "long" }).format(fortnight.to);

  const history = rows.flatMap((row): AwardView[] => {
    const overall = row.overall as unknown as StoredAward;
    const areas = row.areas as unknown as StoredAreas;
    const winners = overall.ranking.slice(0, overall.named).map(entryOf);
    const sales = areas.sales ? entryOf(areas.sales) : null;
    const support = areas.support ? entryOf(areas.support) : null;
    const mine = [...winners, sales, support].some((w) => w?.userId === user.id);
    const base = { period: row.period, label: row.label, announcedAt: row.announcedAt, audience: row.audience, mine };
    if (canSeeStandings) return [{ ...base, winners, sales, support, ranking: overall.ranking }];
    if (row.audience === "EVERYONE") return [{ ...base, winners, sales, support, ranking: null }];
    // Told only to the winners: each of them sees their own line, and nobody else sees anything.
    if (row.audience === "WINNERS" && mine) {
      const own = (e: AwardEntry | null) => (e?.userId === user.id ? e : null);
      return [{ ...base, winners: winners.filter((w) => w.userId === user.id), sales: own(sales), support: own(support), ranking: null }];
    }
    return [];
  });

  return toPlain({
    canSeeStandings,
    canManage,
    settings,
    current: {
      label: fortnight.label,
      announcesOn: `${announcesOn}, ${ANNOUNCE_FROM_HOUR} am`,
      // The live race is for the people who can already see team performance. Everybody else sees
      // their own tally, which is theirs to see.
      standings: canSeeStandings ? standings.slice(0, 20) : null,
      mine: standings.find((s) => s.userId === user.id) ?? null,
    },
    history,
  });
}

export async function saveActivityAwardSettings(input: AwardSettings): Promise<ActionResult<null>> {
  const user = await requireModuleUser("wins");
  if (!(await can(user.id, "wins.manage"))) return { ok: false, error: "You can't change the most-active awards." };
  if (!AUDIENCES.includes(input.audience)) return { ok: false, error: "Pick who hears about the awards." };
  const topCount = Math.round(Number(input.topCount));
  if (!Number.isFinite(topCount) || topCount < 1 || topCount > 10) return { ok: false, error: "Name between 1 and 10 people." };
  const data = {
    enabled: input.enabled === true,
    audience: input.audience,
    topCount,
    splash: input.splash === true,
    updatedById: user.id,
  };
  await db.activityAwardSettings.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "ActivityAwardSettings", entityId: "global", entityLabel: "Most-active award settings" });
  revalidatePath("/wins", "layout");
  return { ok: true, data: null };
}

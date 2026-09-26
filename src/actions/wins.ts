"use server";

import { revalidatePath } from "next/cache";
import type { SplashScope, TargetMetric } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { isModuleEnabled } from "@/actions/module";
import { toPlain } from "@/lib/serialize";
import { periodContaining } from "@/lib/forecast/periods";
import { bookingsByPerson, detectSalesWins, winsSettings, withoutOrphanedWins } from "@/lib/wins/detect";
import type { ActionResult } from "@/actions/company";

/**
 * The wins wall and the office TV: this month's leaderboard, the wins as they happened, and the
 * settings behind the celebrations.
 *
 * Everybody signed in sees the wall — the point of it is that others see it. What it shows is
 * bookings (order value, as the target measures it) and wins already announced to everybody; with
 * `showAmounts` off it shows ranks and progress but no rupees.
 */

const SCOPES: SplashScope[] = ["EVERYONE", "SUBJECT"];

/** "just now", "25 min ago", "3 h ago", "2 days ago" — worked out here, because a page may not read the clock while it renders. */
function agoText(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

export async function getWinsWall() {
  const user = await requireModuleUser("wins");
  if (!(await isModuleEnabled("wins"))) return null;
  const now = new Date();
  const month = periodContaining(now, "month");
  const settings = await winsSettings();

  const [bookings, targets, allWins, wonThisMonth, canManage] = await Promise.all([
    bookingsByPerson(month.from, month.to),
    db.target.findMany({
      where: {
        active: true,
        metric: "ORDER_VALUE",
        scope: "USER",
        period: "MONTH",
        // Date-only columns are compared by calendar day, so the bound is inclusive here and the month
        // is matched exactly below. A strict `lt` at India midnight drops a target that ends on the
        // month's last day.
        fromDate: { gte: new Date(month.from.getTime() - 86_400_000) },
        toDate: { lte: month.to },
      },
      select: { userId: true, value: true, fromDate: true, toDate: true, user: { select: { name: true, active: true } } },
    }),
    db.celebration.findMany({
      where: { source: { notIn: ["MANUAL", "MOST_ACTIVE", "PRIZES"] }, active: true, createdAt: { gte: new Date(now.getTime() - 30 * 86_400_000) } },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: { id: true, source: true, title: true, message: true, amount: true, createdAt: true, details: true, subject: { select: { id: true, name: true } } },
    }),
    db.activity.findMany({
      where: { type: "STAGE_CHANGE", notes: { contains: " to WON" }, occurredAt: { gte: month.from, lt: month.to } },
      distinct: ["leadId"],
      select: { leadId: true },
    }),
    can(user.id, "wins.manage"),
  ]);
  // A win for a customer or deal deleted since is not on the wall — see withoutOrphanedWins.
  const wins = (await withoutOrphanedWins(allWins)).map(({ details, ...w }) => {
    void details; // only needed to find the orphans; the wall has no use for it
    return w;
  });

  // Everybody booking this month, and everybody with a target for it even if they have not booked
  // yet — a target at 0% is part of the picture.
  const people = new Map<string, { userId: string; name: string; booked: number; target: number | null }>();
  for (const b of bookings) people.set(b.userId, { userId: b.userId, name: b.name, booked: b.value, target: null });
  for (const t of targets) {
    if (!t.userId || !t.user?.active) continue;
    // A date column holds the calendar day: it is this month's when its yyyy-mm is this month's.
    if (t.fromDate.toISOString().slice(0, 7) !== month.key || t.toDate.toISOString().slice(0, 7) !== month.key) continue;
    const row = people.get(t.userId) ?? { userId: t.userId, name: t.user.name, booked: 0, target: null };
    row.target = (row.target ?? 0) + Number(t.value);
    people.set(t.userId, row);
  }
  const leaderboard = [...people.values()]
    .sort((a, b) => b.booked - a.booked || (b.target ?? 0) - (a.target ?? 0))
    .map((p, i) => ({
      rank: i + 1,
      userId: p.userId,
      name: p.name,
      booked: settings.showAmounts ? p.booked : null,
      target: settings.showAmounts ? p.target : null,
      percent: p.target ? Math.round((p.booked / p.target) * 100) : null,
      isYou: p.userId === user.id,
    }));

  const counts = {
    booked: settings.showAmounts ? leaderboard.reduce((t, r) => t + (r.booked ?? 0), 0) : null,
    target: settings.showAmounts ? [...people.values()].reduce((t, p) => t + (p.target ?? 0), 0) || null : null,
    dealsWon: wonThisMonth.length,
    newCustomers: wins.filter((w) => w.source === "FIRST_ORDER" && w.createdAt >= month.from).length,
    targetsHit: wins.filter((w) => w.source === "TARGET_HIT" && w.createdAt >= month.from).length,
  };

  return toPlain({
    monthLabel: month.label,
    showAmounts: settings.showAmounts,
    canManage,
    leaderboard,
    counts,
    wins: wins.map((w) => ({ ...w, amount: settings.showAmounts && w.amount !== null ? Number(w.amount) : null, ago: agoText(now.getTime() - w.createdAt.getTime()), fresh: now.getTime() - w.createdAt.getTime() < 2 * 3_600_000 })),
  });
}

export async function getWinsSettings() {
  const user = await requireModuleUser("wins");
  if (!(await can(user.id, "wins.manage"))) return null;
  return toPlain(await winsSettings());
}

export async function saveWinsSettings(input: {
  dealWon: boolean;
  dealWonMinimum: number;
  dealWonSplash: SplashScope;
  targetHit: boolean;
  targetHitSplash: SplashScope;
  targetMetrics: TargetMetric[];
  firstOrder: boolean;
  firstOrderSplash: SplashScope;
  topPerformer: boolean;
  topPerformerSplash: SplashScope;
  topPerformerCount: number;
  showAmounts: boolean;
}): Promise<ActionResult<null>> {
  const user = await requireModuleUser("wins");
  if (!(await can(user.id, "wins.manage"))) return { ok: false, error: "You can't change how wins are celebrated." };
  const minimum = Number(input.dealWonMinimum);
  if (!Number.isFinite(minimum) || minimum < 0) return { ok: false, error: "The deal size is an amount, 0 or more." };
  const count = Math.round(Number(input.topPerformerCount));
  if (!Number.isFinite(count) || count < 1 || count > 10) return { ok: false, error: "Name between 1 and 10 people for the month." };
  if (![input.dealWonSplash, input.targetHitSplash, input.firstOrderSplash, input.topPerformerSplash].every((s) => SCOPES.includes(s))) {
    return { ok: false, error: "Pick who sees each celebration." };
  }
  const metrics = [...new Set(input.targetMetrics ?? [])];
  const data = {
    dealWon: input.dealWon === true,
    dealWonMinimum: minimum,
    dealWonSplash: input.dealWonSplash,
    targetHit: input.targetHit === true,
    targetHitSplash: input.targetHitSplash,
    targetMetrics: metrics,
    firstOrder: input.firstOrder === true,
    firstOrderSplash: input.firstOrderSplash,
    topPerformer: input.topPerformer === true,
    topPerformerSplash: input.topPerformerSplash,
    topPerformerCount: count,
    showAmounts: input.showAmounts === true,
    updatedById: user.id,
  };
  await db.salesCelebrationSettings.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "SalesCelebrationSettings", entityId: "global", entityLabel: "Sales celebration settings" });
  revalidatePath("/wins");
  return { ok: true, data: null };
}

/** Look for wins now rather than at the next tick — after changing a setting, say. */
export async function runWinsDetection(): Promise<ActionResult<{ created: number }>> {
  const user = await requireModuleUser("wins");
  if (!(await can(user.id, "wins.manage"))) return { ok: false, error: "You can't do that." };
  const result = await detectSalesWins();
  revalidatePath("/wins");
  return { ok: true, data: result };
}

"use server";

import { revalidatePath } from "next/cache";
import type { SplashScope, TargetMetric } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { isModuleEnabled } from "@/actions/module";
import { toPlain } from "@/lib/serialize";
import { detectSalesWins, winsSettings } from "@/lib/wins/detect";
import { buildWinsWall } from "@/lib/wins/wall";
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

export async function getWinsWall() {
  const user = await requireModuleUser("wins");
  if (!(await isModuleEnabled("wins"))) return null;
  // The figures are built where the office TV builds them too (src/lib/wins/wall.ts): everybody's, masked
  // as this person's field access says, with them marked on the leaderboard.
  const [wall, canManage] = await Promise.all([buildWinsWall({ viewerId: user.id, maskAs: user.id, branchId: null }), can(user.id, "wins.manage")]);
  return { ...wall, canManage };
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

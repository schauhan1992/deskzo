import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { notifyUser } from "@/lib/notify";
import { LOW_SHARE, MILLI, aiTablesMissing, chargeFor, costFor, creditsText, type AiFeature } from "@/lib/ai/catalogue";
import type { Route } from "@/lib/ai/accounts";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { refreshEntitlements } from "@/lib/platform/entitlements";
import { parseEntitlements } from "@/lib/entitlements";
import { currentTenant } from "@/lib/tenancy/resolve";
import type { Tenant } from "@/lib/tenancy/state";
import { clockOfTenant } from "@/lib/time/workspace";

/**
 * A workspace's Deskzo AI credits (owner, 17 Oct 2026), kept in the control plane.
 *
 *   · Each month on the workspace's own clock its plans allow so many credits (`Plan.copilotTokens`, a
 *     unit's worth times the quantity — per person on per-person plans; a free trial's own number).
 *     What is not used lapses at the month's end.
 *   · Packs bought or given (src/lib/ai/packs.ts) are used after the allowance, the one ending first
 *     first, for twelve months.
 *   · Every model turn is charged after it ends: tokens × the model's rates, in thousandths of a credit,
 *     to a person, a feature and a model (`AiUsage`). A turn is refused before it starts once nothing is
 *     left — the hard stop — so the most a workspace goes past zero is the turns already under way, and
 *     Deskzo absorbs that (`overdraft`).
 *   · Billing managers are told once a month when four fifths are used, and when none are left.
 *
 * The month's row is locked for each charge (`FOR UPDATE`), so two turns finishing together never both
 * take the last of the allowance. A workspace with no control plane (one from the environment, as before
 * workspaces) has no limit and keeps no ledger.
 */

/** The month a day falls in on the workspace's clock: its key, its first day as a `@db.Date`, and its window. */
export function monthOf(tenant: Pick<Tenant, "timezone">, now = new Date()) {
  const clock = clockOfTenant(tenant);
  const key = clock.monthKey(now);
  const window = clock.monthWindow(now);
  return { key, day: `${key}-01`, date: new Date(`${key}-01T00:00:00.000Z`), from: window.from, to: window.to };
}

/**
 * The month's allowance in thousandths, or null for no limit. Entitlements worked out before credits
 * existed counted tokens: those are worked out again first, once, so a deploy never needs a step for it.
 */
async function allowanceOf(tenant: Tenant): Promise<number | null> {
  let entitlements = tenant.entitlements;
  if (entitlements.inCredits !== true && tenant.source === "control") entitlements = await refreshEntitlements(tenant.id);
  return entitlements.copilotTokens === null ? null : entitlements.copilotTokens * MILLI;
}

export type CreditPack = { id: string; source: string; packKey: string | null; credits: number; remaining: number; expiresAt: Date; createdAt: Date };

export type CreditStanding = {
  /** False for a workspace with no ledger (no control plane): no limit. */
  metered: boolean;
  month: string;
  /** When this month's allowance renews: the 1st, at the workspace's midnight. */
  renewsAt: Date;
  /** Thousandths. Null: no limit. */
  allowance: number | null;
  allowanceUsed: number;
  packsUsed: number;
  overdraft: number;
  /** Packs with credits left that haven't ended, the one ending first first. */
  packs: CreditPack[];
  packsRemaining: number;
  /** Credits that can still be used: the allowance left and the packs. Null: no limit. */
  available: number | null;
};

const livePacks = (tenantId: string, now: Date) =>
  controlDb().aiCreditPack.findMany({
    where: { tenantId, remaining: { gt: 0 }, expiresAt: { gt: now } },
    orderBy: [{ expiresAt: "asc" }, { createdAt: "asc" }],
    select: { id: true, source: true, packKey: true, credits: true, remaining: true, expiresAt: true, createdAt: true },
  });

export async function creditStanding(tenant?: Tenant, now = new Date()): Promise<CreditStanding> {
  const t = tenant ?? (await currentTenant());
  const month = monthOf(t, now);
  const unmetered: CreditStanding = { metered: false, month: month.key, renewsAt: month.to, allowance: null, allowanceUsed: 0, packsUsed: 0, overdraft: 0, packs: [], packsRemaining: 0, available: null };
  if (!controlConfigured() || t.source !== "control") return unmetered;
  let read;
  try {
    read = await Promise.all([
      allowanceOf(t),
      controlDb().aiCreditMonth.findUnique({ where: { tenantId_month: { tenantId: t.id, month: month.date } }, select: { allowanceUsed: true, packsUsed: true, overdraft: true } }),
      livePacks(t.id, now),
    ]);
  } catch (err) {
    // Before the control plane's migration: no ledger yet — and no route either, so nothing runs meanwhile.
    if (aiTablesMissing(err)) return unmetered;
    throw err;
  }
  const [allowance, row, packs] = read;
  const allowanceUsed = row?.allowanceUsed ?? 0;
  const packsRemaining = packs.reduce((sum, p) => sum + p.remaining, 0);
  return {
    metered: true,
    month: month.key,
    renewsAt: month.to,
    allowance,
    allowanceUsed,
    packsUsed: row?.packsUsed ?? 0,
    overdraft: row?.overdraft ?? 0,
    packs,
    packsRemaining,
    available: allowance === null ? null : Math.max(0, allowance - allowanceUsed) + packsRemaining,
  };
}

/** Credits a person has used today on the workspace's clock, every feature together, in thousandths. */
export async function usedTodayBy(userId: string, tenant?: Tenant, now = new Date()): Promise<number> {
  const t = tenant ?? (await currentTenant());
  if (!controlConfigured() || t.source !== "control") return 0;
  const clock = clockOfTenant(t);
  const from = clock.startOfDay(clock.dateKey(now))!;
  try {
    const sum = await controlDb().aiUsage.aggregate({ where: { tenantId: t.id, userId, at: { gte: from } }, _sum: { credits: true } });
    return sum._sum.credits ?? 0;
  } catch (err) {
    if (aiTablesMissing(err)) return 0;
    throw err;
  }
}

// ─── Charging a turn ─────────────────────────────────────────────────────────────────────────────

export type Charge = { credits: number; fromAllowance: number; fromPacks: number; overdraft: number; left: number | null };

type MonthRow = { allowance: number | null; allowanceUsed: number; packsUsed: number; overdraft: number; alert80At: Date | null; alert100At: Date | null };

/**
 * Charges one finished turn to the workspace: the allowance first, then packs, then — only when a turn
 * already under way ran past zero — overdraft. Recorded against the person, the feature and the model.
 * Returns what was taken and what is left, and tells billing managers when that crosses four fifths or zero.
 */
export async function chargeTurn(input: { userId: string; feature: AiFeature; route: Pick<Route, "model">; usage: { input: number; output: number }; tenant?: Tenant; now?: Date }): Promise<Charge> {
  const tenant = input.tenant ?? (await currentTenant());
  const now = input.now ?? new Date();
  const credits = chargeFor(input.usage, input.route.model);
  if (!controlConfigured() || tenant.source !== "control") return { credits, fromAllowance: credits, fromPacks: 0, overdraft: 0, left: null };
  const month = monthOf(tenant, now);
  const allowance = await allowanceOf(tenant);
  const cost = costFor(input.usage, input.route.model);

  // Timestamps go to SQL as text read without a zone: Prisma keeps UTC wall times in timestamp(3) columns,
  // and a Date parameter would be shifted by the session's zone.
  const at = now.toISOString();
  const result = await controlDb().$transaction(async (tx) => {
    // The month's row, made when it is first needed, carrying the plans' allowance as it is now — and,
    // by the upsert, locked until this charge is written.
    const [row] = await tx.$queryRaw<MonthRow[]>`
      INSERT INTO "ai_credit_months" ("tenantId", "month", "allowance", "createdAt", "updatedAt")
      VALUES (${tenant.id}, ${month.day}::date, ${allowance}::integer, ${at}::timestamp, ${at}::timestamp)
      ON CONFLICT ("tenantId", "month") DO UPDATE SET "allowance" = EXCLUDED."allowance", "updatedAt" = EXCLUDED."updatedAt"
      RETURNING "allowance", "allowanceUsed", "packsUsed", "overdraft", "alert80At", "alert100At"`;
    const fromAllowance = row!.allowance === null ? credits : Math.min(credits, Math.max(0, row!.allowance - row!.allowanceUsed));
    let rest = credits - fromAllowance;
    let fromPacks = 0;
    const packs = await tx.$queryRaw<{ id: string; remaining: number }[]>`
      SELECT "id", "remaining" FROM "ai_credit_packs"
      WHERE "tenantId" = ${tenant.id} AND "remaining" > 0 AND "expiresAt" > ${at}::timestamp
      ORDER BY "expiresAt" ASC, "createdAt" ASC FOR UPDATE`;
    let packsLeft = 0;
    for (const pack of packs) {
      const take = Math.min(rest, pack.remaining);
      if (take > 0) {
        await tx.aiCreditPack.update({ where: { id: pack.id }, data: { remaining: { decrement: take } }, select: { id: true } });
        rest -= take;
        fromPacks += take;
      }
      packsLeft += pack.remaining - take;
    }
    const overdraft = rest;
    await tx.aiCreditMonth.update({
      where: { tenantId_month: { tenantId: tenant.id, month: month.date } },
      data: { allowanceUsed: { increment: fromAllowance }, packsUsed: { increment: fromPacks }, overdraft: { increment: overdraft } },
      select: { tenantId: true },
    });
    await tx.aiUsage.create({
      data: { tenantId: tenant.id, userId: input.userId, feature: input.feature, modelKey: input.route.model.key, inputTokens: Math.round(input.usage.input), outputTokens: Math.round(input.usage.output), credits, fromAllowance, fromPacks, overdraft, cost, at: now },
      select: { id: true },
    });
    const allowanceLeft = row!.allowance === null ? null : Math.max(0, row!.allowance - row!.allowanceUsed - fromAllowance);
    const used = row!.allowanceUsed + fromAllowance + row!.packsUsed + fromPacks;
    return { fromAllowance, fromPacks, overdraft, left: allowanceLeft === null ? null : allowanceLeft + packsLeft, used, alert80At: row!.alert80At, alert100At: row!.alert100At };
  });

  if (result.left !== null) await maybeAlert(tenant, month, { used: result.used, left: result.left, alert80At: result.alert80At, alert100At: result.alert100At }, now);
  return { credits, fromAllowance: result.fromAllowance, fromPacks: result.fromPacks, overdraft: result.overdraft, left: result.left };
}

// ─── Alerts ──────────────────────────────────────────────────────────────────────────────────────

/** The workspace's people who manage its plan and billing — who is told about credits. */
export async function billingManagers(): Promise<string[]> {
  const people = await db.user.findMany({ where: { active: true, kind: "MEMBER" }, select: { id: true }, take: 2000 });
  const allowed = await Promise.all(people.map(async (p) => ((await can(p.id, "billing.manage")) ? p.id : null)));
  return allowed.filter((id): id is string => id !== null);
}

/**
 * Once a month each: four fifths of the month's credits used (allowance and packs together), and none
 * left. Claimed with a conditional update first, so two charges crossing at once tell people once.
 */
async function maybeAlert(tenant: Tenant, month: ReturnType<typeof monthOf>, state: { used: number; left: number; alert80At: Date | null; alert100At: Date | null }, now: Date) {
  const total = state.used + state.left;
  if (total <= 0) return;
  const which = state.left <= 0 ? (state.alert100At ? null : "alert100At") : state.left <= total * (1 - LOW_SHARE) && !state.alert80At ? "alert80At" : null;
  if (!which) return;
  const where = { tenantId: tenant.id, month: month.date, [which]: null };
  // Crossing zero at once counts as crossing four fifths too.
  const claimed = await controlDb().aiCreditMonth.updateMany({ where, data: which === "alert100At" ? { alert100At: now, alert80At: state.alert80At ?? now } : { alert80At: now } });
  if (!claimed.count) return;
  const renews = clockOfTenant(tenant).date(month.to);
  const title = which === "alert100At" ? "Deskzo AI credits are used up" : "Deskzo AI credits are running low";
  const message =
    which === "alert100At"
      ? `None of this month's credits are left, so the copilot and AI drafting have stopped. They start again on ${renews}, or as soon as a pack is bought.`
      : `Four fifths of this month's credits are used — ${creditsText(state.left)} left. The allowance renews on ${renews}; a pack adds more now.`;
  for (const userId of await billingManagers()) await notifyUser({ userId, type: "AI_CREDITS", title, message, link: "/settings/billing#ai-credits" });
}

// ─── Reading the ledger ──────────────────────────────────────────────────────────────────────────

export type UsageRow = { userId: string; feature: string; modelKey: string; credits: number; inputTokens: number; outputTokens: number; turns: number; cost: number | null };

/** A workspace's charges between two instants, by person, feature and model. */
export async function usageBreakdown(tenantId: string, from: Date, to: Date): Promise<UsageRow[]> {
  const rows = await controlDb().aiUsage.groupBy({
    by: ["userId", "feature", "modelKey"],
    where: { tenantId, at: { gte: from, lt: to } },
    _sum: { credits: true, inputTokens: true, outputTokens: true, cost: true },
    _count: { _all: true },
  });
  return rows
    .map((r) => ({
      userId: r.userId,
      feature: r.feature,
      modelKey: r.modelKey,
      credits: r._sum.credits ?? 0,
      inputTokens: r._sum.inputTokens ?? 0,
      outputTokens: r._sum.outputTokens ?? 0,
      turns: r._count._all,
      cost: r._sum.cost ?? null,
    }))
    .sort((a, b) => b.credits - a.credits);
}

/** Credits a workspace used this month, whole — the daily usage snapshot (src/lib/billing/reconcile.ts). */
export async function creditsUsedThisMonth(tenant?: Tenant, now = new Date()): Promise<number> {
  const s = await creditStanding(tenant, now);
  return Math.floor((s.allowanceUsed + s.packsUsed + s.overdraft) / MILLI);
}

// ─── For the console ─────────────────────────────────────────────────────────────────────────────

export type ConsoleCreditView = {
  month: string;
  renewsAt: Date;
  /** Thousandths; null: no limit. */
  allowance: number | null;
  allowanceUsed: number;
  packsUsed: number;
  overdraft: number;
  packsRemaining: number;
  /** The latest packs, live or not: bought, given, used up, lapsed. */
  packs: (CreditPack & { reason: string | null; grantedBy: string | null })[];
  /** This month by feature and model. */
  byModel: { feature: string; modelKey: string; credits: number; turns: number; cost: number | null }[];
};

/** One workspace's credits as Workspace 360 shows them — read from the control plane alone, on the workspace's clock. */
export async function consoleCreditView(tenantId: string, now = new Date()): Promise<ConsoleCreditView | null> {
  const control = controlDb();
  const tenant = await control.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true, entitlements: true } });
  if (!tenant) return null;
  const month = monthOf(tenant, now);
  const allowanceCredits = parseEntitlements(tenant.entitlements).copilotTokens;
  const [row, packs, usage] = await Promise.all([
    control.aiCreditMonth.findUnique({ where: { tenantId_month: { tenantId, month: month.date } }, select: { allowanceUsed: true, packsUsed: true, overdraft: true } }),
    control.aiCreditPack.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: 12,
      select: { id: true, source: true, packKey: true, credits: true, remaining: true, expiresAt: true, createdAt: true, reason: true, grantedBy: true },
    }),
    usageBreakdown(tenantId, month.from, month.to),
  ]);
  const byModel = new Map<string, ConsoleCreditView["byModel"][number]>();
  for (const u of usage) {
    const key = `${u.feature}|${u.modelKey}`;
    const m = byModel.get(key) ?? { feature: u.feature, modelKey: u.modelKey, credits: 0, turns: 0, cost: null };
    m.credits += u.credits;
    m.turns += u.turns;
    if (u.cost !== null) m.cost = (m.cost ?? 0) + u.cost;
    byModel.set(key, m);
  }
  return {
    month: month.key,
    renewsAt: month.to,
    allowance: allowanceCredits === null ? null : allowanceCredits * MILLI,
    allowanceUsed: row?.allowanceUsed ?? 0,
    packsUsed: row?.packsUsed ?? 0,
    overdraft: row?.overdraft ?? 0,
    packsRemaining: packs.filter((p) => p.expiresAt > now).reduce((s, p) => s + p.remaining, 0),
    packs,
    byModel: [...byModel.values()].sort((a, b) => b.credits - a.credits),
  };
}

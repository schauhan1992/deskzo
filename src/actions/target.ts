"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type TargetMetric, type TargetPeriod, type TargetScope } from "@prisma/client";
import { db, getTenantDb } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { toPlain } from "@/lib/serialize";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { getDownlineUserIds } from "@/lib/org-chart";
import { hasEffectivePermission } from "@/actions/permission";
import { metricByKey, progressOf } from "@/lib/targets/metrics";
import { measure, measureMany, subjectUserIdsMany } from "@/lib/targets/measure";
import type { ActionResult } from "@/actions/company";

/**
 * Targets, and what was actually achieved against them.
 *
 * The measuring is the whole module, and it is deliberately *derived* — every figure below is
 * computed from the underlying records each time it is read, and nothing is stored. A stored number
 * stops being true the moment an invoice is cancelled, an order is voided or a lead is reassigned,
 * and nothing would say so. The cost is a handful of aggregates per person; the alternative is a
 * dashboard that is confidently wrong about somebody's pay.
 */

async function access() {
  const user = await requireUser();
  const manage = await hasEffectivePermission(user.id, "targets.manage");
  const viewAll = manage || (await hasEffectivePermission(user.id, "targets.viewAll"));
  return { user, manage, viewAll };
}

/** Whose targets this person may look at: their own, plus anybody reporting to them. */
async function visibleUserIds(userId: string, viewAll: boolean): Promise<string[] | null> {
  if (viewAll) return null;
  const downline = await getDownlineUserIds(userId);
  return [userId, ...downline];
}

// ─── Measuring ────────────────────────────────────────────────────────────────

const targetSelect = {
  id: true,
  metric: true,
  period: true,
  fromDate: true,
  toDate: true,
  label: true,
  scope: true,
  value: true,
  note: true,
  active: true,
  createdAt: true,
  // What hitting it is worth. Selected so the scheme picker can show what is already attached —
  // without it the control could set a value but never display one.
  incentiveSchemeId: true,
  user: { select: { id: true, name: true } },
  department: { select: { id: true, name: true } },
  createdBy: { select: { name: true } },
} satisfies Prisma.TargetSelect;

/**
 * Targets with their actuals worked out.
 *
 * Measured in a batch rather than one target at a time: a manager's page is a dozen targets that
 * mostly share a metric and a quarter, and asking the same question once per row is how a page that
 * is fine at thirty targets stops being fine at three hundred. The subjects are resolved in the
 * same way — the whole page's departments in one query, and the company-wide list, which is every
 * user there is, at most once.
 */
export async function listTargets(filters?: {
  userId?: string;
  departmentId?: string;
  metric?: string;
  scope?: string;
  /** "current" hides periods that have finished — the default, since those are history. */
  show?: string;
}) {
  const { user, viewAll } = await access();
  const allowed = await visibleUserIds(user.id, viewAll);
  const now = new Date();

  const rows = await db.target.findMany({
    where: {
      active: true,
      ...(filters?.show === "past" ? { toDate: { lt: now } } : {}),
      ...(filters?.show === "all" ? {} : filters?.show === "past" ? {} : { toDate: { gte: now } }),
      ...(filters?.metric ? { metric: filters.metric as TargetMetric } : {}),
      ...(filters?.scope ? { scope: filters.scope as TargetScope } : {}),
      ...(filters?.userId ? { userId: filters.userId } : {}),
      ...(filters?.departmentId ? { departmentId: filters.departmentId } : {}),
      // Somebody without the view-all permission sees their own and their team's, and team or
      // company targets, which are not about any one person.
      ...(allowed
        ? { OR: [{ userId: { in: allowed } }, { scope: { in: ["DEPARTMENT", "COMPANY"] } }] }
        : {}),
    },
    orderBy: [{ toDate: "asc" }, { metric: "asc" }],
    take: 200,
    select: targetSelect,
  });

  const subjects = await subjectUserIdsMany(
    await getTenantDb(),
    rows.map((t) => ({
      scope: t.scope,
      userId: t.user?.id ?? null,
      departmentId: t.department?.id ?? null,
    })),
  );
  const achievements = await measureMany(
    await getTenantDb(),
    rows.map((t, i) => ({ metric: t.metric, from: t.fromDate, to: t.toDate, userIds: subjects[i] })),
  );

  const measured = rows.map((t, i) => {
    const achieved = achievements[i];
    return {
      ...t,
      achieved,
      progress: progressOf({
        target: Number(t.value),
        achieved,
        fromDate: t.fromDate,
        toDate: t.toDate,
        now,
      }),
    };
  });

  return toPlain(measured);
}

/** One person's targets — their own page, and what a manager opens. */
export async function targetsFor(userId: string) {
  const { user, viewAll } = await access();
  const allowed = await visibleUserIds(user.id, viewAll);
  if (allowed && !allowed.includes(userId)) return [];

  const now = new Date();
  const rows = await db.target.findMany({
    where: { active: true, userId, toDate: { gte: new Date(now.getFullYear() - 1, 0, 1) } },
    orderBy: [{ toDate: "desc" }],
    take: 40,
    select: targetSelect,
  });

  // Measured through the same batch as `listTargets`, though it has much less to collapse here: a
  // year of one person's targets is typically one window per month, and windows are never merged,
  // so this is usually still a query per target. It earns its place by being the same code path
  // rather than by being faster — where a person does hold several targets on one metric and
  // period, it costs one query instead of several.
  const achievements = await measureMany(
    await getTenantDb(),
    rows.map((t) => ({ metric: t.metric, from: t.fromDate, to: t.toDate, userIds: [userId] })),
  );

  return toPlain(
    rows.map((t, i) => {
      const achieved = achievements[i];
      return {
        ...t,
        achieved,
        progress: progressOf({ target: Number(t.value), achieved, fromDate: t.fromDate, toDate: t.toDate, now }),
      };
    }),
  );
}

// ─── Setting them ─────────────────────────────────────────────────────────────

export async function saveTarget(input: {
  id?: string;
  metric: TargetMetric;
  period: TargetPeriod;
  fromDate: string;
  toDate: string;
  label: string;
  scope: TargetScope;
  userId?: string;
  departmentId?: string;
  value: number;
  note?: string;
}): Promise<ActionResult<{ id: string }>> {
  const { user, manage } = await access();
  if (!manage) return { ok: false, error: "You can't set targets." };

  const from = new Date(`${input.fromDate}T00:00:00.000Z`);
  const to = new Date(`${input.toDate}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return { ok: false, error: "Those aren't dates." };
  if (to < from) return { ok: false, error: "The period can't end before it starts." };
  if (input.value <= 0) return { ok: false, error: "A target of nothing isn't a target." };

  if (input.scope === "USER" && !input.userId) return { ok: false, error: "Whose target is it?" };
  if (input.scope === "DEPARTMENT" && !input.departmentId) return { ok: false, error: "Which team?" };

  const userId = input.scope === "USER" ? input.userId! : null;
  const departmentId = input.scope === "DEPARTMENT" ? input.departmentId! : null;

  // One target per person per metric per period. Enforced here rather than by a constraint, because
  // Postgres treats NULLs as distinct and the scope columns are nullable by design — two "company"
  // targets for the same metric and month would slip straight past a unique index.
  const clash = await db.target.findFirst({
    where: {
      metric: input.metric,
      scope: input.scope,
      userId,
      departmentId,
      fromDate: from,
      toDate: to,
      active: true,
      ...(input.id ? { id: { not: input.id } } : {}),
    },
    select: { id: true, label: true },
  });
  if (clash) {
    return {
      ok: false,
      error: `There's already a ${metricByKey[input.metric].label.toLowerCase()} target for ${clash.label}. Edit that one rather than adding a second — two targets for the same thing means nobody knows which counts.`,
    };
  }

  const data = {
    metric: input.metric,
    period: input.period,
    fromDate: from,
    toDate: to,
    label: input.label.trim(),
    scope: input.scope,
    userId,
    departmentId,
    value: new Prisma.Decimal(input.value),
    note: input.note?.trim() || null,
  };

  const row = input.id
    ? await db.target.update({ where: { id: input.id }, data, select: { id: true } })
    : await db.target.create({ data: { ...data, createdById: user.id }, select: { id: true } });

  // Being given a number and not being told is how a target becomes a surprise at the review.
  if (userId && userId !== user.id) {
    await notifyUser({
      userId,
      type: "TASK_ASSIGNED",
      title: `${metricByKey[input.metric].label} target for ${data.label}`,
      message: input.id ? "Your target has been changed." : "A new target has been set for you.",
      link: "/targets/mine",
    });
  }

  await recordAudit({
    userId: user.id,
    action: input.id ? "UPDATE" : "CREATE",
    entityType: "Target",
    entityId: row.id,
    entityLabel: `${metricByKey[input.metric].label} · ${data.label} · ${input.value}`,
  });
  revalidatePath("/targets");
  return { ok: true, data: row };
}

/**
 * Retires a target.
 *
 * Deactivated rather than deleted: somebody was measured against it, and a review six months later
 * that cannot find the number they were judged on is worse than one that shows it was withdrawn.
 */
export async function retireTarget(id: string): Promise<ActionResult<null>> {
  const { user, manage } = await access();
  if (!manage) return { ok: false, error: "You can't change targets." };

  const target = await db.target.findUnique({ where: { id }, select: { label: true, metric: true } });
  if (!target) return { ok: false, error: "That target no longer exists." };

  await db.target.update({ where: { id }, data: { active: false } });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Target",
    entityId: id,
    entityLabel: `Withdrew the ${metricByKey[target.metric].label.toLowerCase()} target for ${target.label}`,
  });
  revalidatePath("/targets");
  return { ok: true, data: null };
}

/**
 * Sets the same metric and period for several people at once.
 *
 * Because that is how targets are actually handed out — a sales head sets the month for the whole
 * team in one sitting, and doing it one form at a time guarantees somebody gets missed.
 */
export async function setTeamTargets(input: {
  metric: TargetMetric;
  period: TargetPeriod;
  fromDate: string;
  toDate: string;
  label: string;
  targets: { userId: string; value: number }[];
  note?: string;
}): Promise<ActionResult<{ set: number; skipped: number }>> {
  const { manage } = await access();
  if (!manage) return { ok: false, error: "You can't set targets." };

  let set = 0;
  let skipped = 0;
  for (const row of input.targets) {
    if (!row.value || row.value <= 0) {
      skipped += 1;
      continue;
    }
    const result = await saveTarget({
      metric: input.metric,
      period: input.period,
      fromDate: input.fromDate,
      toDate: input.toDate,
      label: input.label,
      scope: "USER",
      userId: row.userId,
      value: row.value,
      note: input.note,
    });
    if (result.ok) set += 1;
    else skipped += 1;
  }

  revalidatePath("/targets");
  return { ok: true, data: { set, skipped } };
}

/** People and teams a target can be set against. */
export async function targetOptions() {
  const { manage } = await access();
  if (!manage) return { people: [], departments: [] };
  const [people, departments] = await Promise.all([
    db.user.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, role: true, department: { select: { id: true, name: true } } },
    }),
    db.department.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  return { people, departments };
}

/**
 * What a person is achieving right now on a metric, with no target attached.
 *
 * Useful before setting one: a number pulled out of the air is how targets lose credibility, and
 * "they did ₹18L last month" is the only sensible starting point.
 */
export async function recentActual(params: {
  metric: TargetMetric;
  userId: string;
  fromDate: string;
  toDate: string;
}): Promise<number> {
  const { user, viewAll } = await access();
  const allowed = await visibleUserIds(user.id, viewAll);
  if (allowed && !allowed.includes(params.userId)) return 0;
  return measure(await getTenantDb(), params.metric, {
    from: new Date(`${params.fromDate}T00:00:00.000Z`),
    to: new Date(`${params.toDate}T00:00:00.000Z`),
    userIds: [params.userId],
  });
}

/** Whether the signed-in person may set targets — drives what the pages offer. */
export async function targetCapabilities() {
  const { user, manage, viewAll } = await access();
  return { userId: user.id, manage, viewAll };
}

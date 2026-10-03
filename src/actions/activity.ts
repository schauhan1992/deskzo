"use server";

import type { ActivityKind, ActivitySeverity, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { toPlain } from "@/lib/serialize";
import { logActivity } from "@/lib/activity";
import { hasEffectivePermission } from "@/actions/permission";
import { severitiesAtLeast, kindsInGroup, type ActivityGroup } from "@/lib/security/activity-kinds";
import { getSecurityPolicy } from "@/lib/security/store";
import { exportDecision } from "@/lib/security/policy";
import { pageSlice, type Paged } from "@/lib/pagination";
import { sanitizeCsvCell } from "@/lib/csv";
import { workspaceClock } from "@/lib/time/workspace";
import type { Clock } from "@/lib/time/zone";
import type { ActionResult } from "@/actions/company";

/**
 * Reading the activity log.
 *
 * One rule shapes the whole file: **everybody can see their own activity, and only a few people can
 * see everybody's.** A log that is secret from the people in it is a surveillance tool; a log
 * everyone can read about everyone else is a way to settle office arguments about who touched
 * which account. Showing a person their own row is also the fastest way for them to notice a
 * sign-in that was not them.
 */

export type ActivityFilters = {
  userId?: string;
  kinds?: ActivityKind[];
  group?: ActivityGroup;
  minSeverity?: ActivitySeverity;
  from?: string;
  to?: string;
  search?: string;
  entityType?: string;
  entityId?: string;
  /** Only rows made while an admin was viewing as somebody else. */
  impersonatedOnly?: boolean;
};

export async function canViewAllActivity(): Promise<boolean> {
  const user = await requireUser();
  return hasEffectivePermission(user.id, "activity.viewAll");
}

/**
 * Turns the filter object into a Prisma `where`, with the scope decision baked in.
 *
 * `scopeUserId` is applied last and overwrites any `userId` in the filters — so a user without the
 * permission cannot widen their own view by passing somebody else's id, whatever the UI sends.
 */
function buildWhere(filters: ActivityFilters, scopeUserId: string | null, clock: Clock): Prisma.ActivityLogWhereInput {
  const where: Prisma.ActivityLogWhereInput = {};

  if (filters.kinds?.length) where.kind = { in: filters.kinds };
  else if (filters.group) where.kind = { in: kindsInGroup(filters.group) };

  if (filters.minSeverity) where.severity = { in: severitiesAtLeast(filters.minSeverity) };

  // The workspace's days, through the end of the chosen one, not up to its first instant — "to: today"
  // that excludes everything that happened today is the classic off-by-one in a date filter.
  const range = clock.dayRange(filters.from, filters.to);
  if (range) where.createdAt = range;

  if (filters.entityType) where.entityType = filters.entityType;
  if (filters.entityId) where.entityId = filters.entityId;
  if (filters.impersonatedOnly) where.impersonatedByUserId = { not: null };

  if (filters.search?.trim()) {
    const term = filters.search.trim();
    where.OR = [
      { summary: { contains: term, mode: "insensitive" } },
      { userName: { contains: term, mode: "insensitive" } },
      { userEmail: { contains: term, mode: "insensitive" } },
      { path: { contains: term, mode: "insensitive" } },
      { ipAddress: { contains: term, mode: "insensitive" } },
    ];
  }

  if (scopeUserId) where.userId = scopeUserId;
  else if (filters.userId) where.userId = filters.userId;

  return where;
}

const ROW_SELECT = {
  id: true,
  kind: true,
  severity: true,
  summary: true,
  userId: true,
  userName: true,
  userEmail: true,
  entityType: true,
  entityId: true,
  path: true,
  ipAddress: true,
  userAgent: true,
  metadata: true,
  createdAt: true,
  user: { select: { id: true, name: true, role: true } },
  impersonatedBy: { select: { id: true, name: true } },
} satisfies Prisma.ActivityLogSelect;

export type ActivityRow = Prisma.ActivityLogGetPayload<{ select: typeof ROW_SELECT }>;

export async function listActivity(params: {
  filters: ActivityFilters;
  page: number;
  pageSize: number;
}): Promise<Paged<ActivityRow> & { scoped: boolean }> {
  const user = await requireUser();
  const seeAll = await hasEffectivePermission(user.id, "activity.viewAll");
  const where = buildWhere(params.filters, seeAll ? null : user.id, await workspaceClock());

  const [rows, total] = await Promise.all([
    db.activityLog.findMany({
      where,
      select: ROW_SELECT,
      orderBy: { createdAt: "desc" },
      ...pageSlice(params.page, params.pageSize),
    }),
    db.activityLog.count({ where }),
  ]);

  return { rows: toPlain(rows), total, scoped: !seeAll };
}

/** The counts behind the summary strip, over the same filters as the table. */
export async function activitySummary(filters: ActivityFilters) {
  const user = await requireUser();
  const seeAll = await hasEffectivePermission(user.id, "activity.viewAll");
  const where = buildWhere(filters, seeAll ? null : user.id, await workspaceClock());

  const bySeverity = await db.activityLog.groupBy({
    by: ["severity"],
    where,
    _count: { _all: true },
  });

  return {
    total: bySeverity.reduce((sum, r) => sum + r._count._all, 0),
    critical: bySeverity.find((r) => r.severity === "CRITICAL")?._count._all ?? 0,
    warning: bySeverity.find((r) => r.severity === "WARNING")?._count._all ?? 0,
    notice: bySeverity.find((r) => r.severity === "NOTICE")?._count._all ?? 0,
    info: bySeverity.find((r) => r.severity === "INFO")?._count._all ?? 0,
  };
}

/** For the "user" filter — only offered to somebody who can actually filter by it. */
export async function activityUserOptions() {
  const user = await requireUser();
  const seeAll = await hasEffectivePermission(user.id, "activity.viewAll");
  if (!seeAll) return [];
  return db.user.findMany({
    where: { active: true },
    select: { id: true, name: true, role: true },
    orderBy: { name: "asc" },
  });
}

/**
 * Exporting the log.
 *
 * Gated on its own permission and, unavoidably, logged itself — downloading the security log is
 * precisely the event a security log exists to record, and an export that did not appear in the
 * thing it exported would be a gap somebody would eventually use.
 */
export async function exportActivity(
  filters: ActivityFilters,
): Promise<ActionResult<{ csv: string; rows: number }>> {
  const user = await requireUser();
  const allowed = await hasEffectivePermission(user.id, "activity.export");
  if (!allowed) {
    await logActivity({
      kind: "PERMISSION_DENIED",
      summary: `${user.name} tried to export the activity log without permission`,
    });
    return { ok: false, error: "You can't export the activity log." };
  }

  const policy = await getSecurityPolicy();
  const where = buildWhere(filters, null, await workspaceClock());
  const total = await db.activityLog.count({ where });

  const verdict = exportDecision(total, policy);
  if (!verdict.allowed) return { ok: false, error: verdict.reason };

  const rows = await db.activityLog.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: policy.exportRowLimit > 0 ? policy.exportRowLimit : undefined,
    select: {
      createdAt: true,
      kind: true,
      severity: true,
      userName: true,
      userEmail: true,
      summary: true,
      path: true,
      ipAddress: true,
      entityType: true,
      entityId: true,
    },
  });

  const header = ["When", "Kind", "Severity", "User", "Email", "What happened", "Path", "IP", "Entity type", "Entity id"];
  const body = rows.map((r) =>
    [
      r.createdAt.toISOString(),
      r.kind,
      r.severity,
      r.userName ?? "",
      r.userEmail ?? "",
      r.summary,
      r.path ?? "",
      r.ipAddress ?? "",
      r.entityType ?? "",
      r.entityId ?? "",
    ]
      .map((cell) => `"${sanitizeCsvCell(String(cell)).replaceAll('"', '""')}"`)
      .join(","),
  );

  await logActivity({
    kind: "EXPORT",
    severity: "WARNING",
    summary: `${user.name} exported ${rows.length.toLocaleString("en-IN")} activity log rows`,
    metadata: { rows: rows.length, filters: JSON.parse(JSON.stringify(filters)) as Prisma.InputJsonValue },
  });

  return { ok: true, data: { csv: [header.join(","), ...body].join("\n"), rows: rows.length } };
}

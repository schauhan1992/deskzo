"use server";

import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { SLA_HOURS } from "@/lib/tickets";
import { dateRangeFilter } from "@/lib/utils";

export async function canViewPerformance(): Promise<boolean> {
  const user = await requireUser();
  return hasEffectivePermission(user.id, "performance.view");
}

export type UserPerformanceRow = {
  userId: string;
  name: string;
  role: string;
  active: boolean;
  activeSeconds: number;
  recordsCreated: number;
  recordsEdited: number;
  ticketsOpen: number;
  ticketsResolved: number;
  avgResolutionHours: number | null;
  slaMetPercent: number | null;
  leadsWon: number;
};

/**
 * Per-user activity/performance rollup for the `/performance` page. `from`/`to` scope the
 * time-boxed metrics (active time, records created/edited, tickets resolved, leads won) to a
 * date range — `ticketsOpen` is deliberately a live snapshot regardless of range, since "how much
 * is currently on someone's plate" isn't a time-boxed question.
 */
export async function getUserPerformance(params?: { from?: string; to?: string }): Promise<UserPerformanceRow[]> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "performance.view"))) {
    return [];
  }

  const createdAtRange = dateRangeFilter(params?.from, params?.to);

  const [users, activityRows, auditRows, assignedTickets, wonLeads] = await Promise.all([
    db.user.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, role: true, active: true } }),
    db.userDailyActivity.findMany({
      where: createdAtRange ? { date: createdAtRange } : undefined,
      select: { userId: true, activeSeconds: true },
    }),
    db.auditLog.findMany({
      where: createdAtRange ? { createdAt: createdAtRange } : undefined,
      select: { userId: true, action: true },
    }),
    db.ticket.findMany({
      where: { assignedToUserId: { not: null } },
      select: {
        assignedToUserId: true,
        priority: true,
        status: true,
        createdAt: true,
        resolvedAt: true,
      },
    }),
    db.lead.findMany({
      where: { status: "WON", ownerUserId: { not: null }, ...(createdAtRange ? { updatedAt: createdAtRange } : {}) },
      select: { ownerUserId: true },
    }),
  ]);

  return users.map((u) => {
    const activeSeconds = activityRows.filter((r) => r.userId === u.id).reduce((sum, r) => sum + r.activeSeconds, 0);
    const recordsCreated = auditRows.filter((r) => r.userId === u.id && r.action === "CREATE").length;
    const recordsEdited = auditRows.filter((r) => r.userId === u.id && r.action === "UPDATE").length;

    const myTickets = assignedTickets.filter((t) => t.assignedToUserId === u.id);
    const ticketsOpen = myTickets.filter((t) => t.status !== "RESOLVED" && t.status !== "CLOSED").length;

    const resolvedTickets = myTickets.filter((t) => {
      if (!t.resolvedAt) return false;
      if (createdAtRange?.gte && t.resolvedAt < createdAtRange.gte) return false;
      if (createdAtRange?.lte && t.resolvedAt > createdAtRange.lte) return false;
      return true;
    });
    const ticketsResolved = resolvedTickets.length;
    const avgResolutionHours =
      resolvedTickets.length > 0
        ? resolvedTickets.reduce((sum, t) => sum + (t.resolvedAt!.getTime() - t.createdAt.getTime()) / 3600000, 0) / resolvedTickets.length
        : null;
    const slaMet = resolvedTickets.filter((t) => {
      const dueBy = t.createdAt.getTime() + SLA_HOURS[t.priority] * 3600000;
      return t.resolvedAt!.getTime() <= dueBy;
    });
    const slaMetPercent = resolvedTickets.length > 0 ? Math.round((slaMet.length / resolvedTickets.length) * 100) : null;

    const leadsWon = wonLeads.filter((l) => l.ownerUserId === u.id).length;

    return {
      userId: u.id,
      name: u.name,
      role: u.role,
      active: u.active,
      activeSeconds,
      recordsCreated,
      recordsEdited,
      ticketsOpen,
      ticketsResolved,
      avgResolutionHours,
      slaMetPercent,
      leadsWon,
    };
  });
}

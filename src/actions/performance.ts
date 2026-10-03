"use server";

import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { SLA_HOURS } from "@/lib/tickets";
import { workspaceClock } from "@/lib/time/workspace";
import { calendarDayRange } from "@/lib/time/zone";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { byStageDate } from "@/lib/pipeline/server";

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
  /**
   * What they saved as a purchaser against sales's distributor prices, net of increases sales accepted
   * (the PURCHASE_SAVINGS metric). Null when the workspace has no Orders module.
   */
  purchaseSavings: number | null;
};

/**
 * Purchase savings per purchaser over the page's range, by the workspace's day each was recorded on — a
 * `@db.Date`, so the `yyyy-mm-dd` bounds are compared as calendar days. A cancelled order's never counts.
 */
async function purchaseSavingsByUser(from?: string, to?: string): Promise<Map<string, number> | null> {
  if (!(await moduleAvailableForTenant("orders"))) return null;
  const recordedOn = calendarDayRange(from, to);
  const rows = await db.purchaseSaving.groupBy({
    by: ["purchaserId"],
    where: { cancelledAt: null, ...(recordedOn ? { recordedOn } : {}) },
    _sum: { amount: true },
  });
  return new Map(rows.map((r) => [r.purchaserId, Math.round(Number(r._sum.amount ?? 0) * 100) / 100]));
}

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

  // The page's From and To are the workspace's days: half-open instants on its clock for the columns
  // that hold a moment (an audit entry, a stage move, a resolution), and the days themselves for the
  // one that holds a day. They were the server's zone, so on a server in UTC an Indian day began at
  // 05:30 and took in the first hours of the next.
  const clock = await workspaceClock();
  const within = clock.dayRange(params?.from, params?.to);
  const days = calendarDayRange(params?.from, params?.to);

  const [users, activityRows, auditRows, assignedTickets, wonLeads, savings] = await Promise.all([
    db.user.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, role: true, active: true } }),
    db.userDailyActivity.findMany({
      where: days ? { date: days } : undefined,
      select: { userId: true, activeSeconds: true },
    }),
    db.auditLog.findMany({
      where: within ? { createdAt: within } : undefined,
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
    // Won within the window: when they moved to won, not when they last changed (src/lib/pipeline).
    byStageDate((moved) =>
      db.lead.findMany({
        where: { status: "WON", ownerUserId: { not: null }, ...(within ? moved(within) : {}) },
        select: { ownerUserId: true },
      }),
    ),
    purchaseSavingsByUser(params?.from, params?.to),
  ]);

  return users.map((u) => {
    const activeSeconds = activityRows.filter((r) => r.userId === u.id).reduce((sum, r) => sum + r.activeSeconds, 0);
    const recordsCreated = auditRows.filter((r) => r.userId === u.id && r.action === "CREATE").length;
    const recordsEdited = auditRows.filter((r) => r.userId === u.id && r.action === "UPDATE").length;

    const myTickets = assignedTickets.filter((t) => t.assignedToUserId === u.id);
    const ticketsOpen = myTickets.filter((t) => t.status !== "RESOLVED" && t.status !== "CLOSED").length;

    const resolvedTickets = myTickets.filter((t) => {
      if (!t.resolvedAt) return false;
      if (within?.gte && t.resolvedAt < within.gte) return false;
      if (within?.lt && t.resolvedAt >= within.lt) return false;
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
      purchaseSavings: savings ? (savings.get(u.id) ?? 0) : null,
    };
  });
}

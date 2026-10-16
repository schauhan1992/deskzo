import { db } from "@/lib/db";

export type XpLeader = {
  userId: string;
  name: string;
  photoUpdatedAt: Date | null;
  xp: number;
  tasks: number;
  badges: string[];
};

/**
 * Who earned the most task XP in a period (owner, 16 Oct 2026): XP is earned when a task is done on or
 * before its due day (src/lib/tasks/server.ts, `moveTask`), and frozen with when. Top ten, with the
 * badges their tasks carried. The caller has checked "See performance" and that Tasks is in the plan.
 * Server only.
 */
export async function taskXpLeaders(within: { gte?: Date; lt?: Date } | null, limit = 10): Promise<XpLeader[]> {
  const where = { xpEarnedById: { not: null }, ...(within ? { xpEarnedAt: within } : { xpEarnedAt: { not: null } }) };
  const rows = await db.task.groupBy({ by: ["xpEarnedById"], where, _sum: { xpEarned: true }, _count: { _all: true } });
  const top = rows
    .filter((r): r is typeof r & { xpEarnedById: string } => !!r.xpEarnedById)
    .sort((a, b) => (b._sum.xpEarned ?? 0) - (a._sum.xpEarned ?? 0))
    .slice(0, limit);
  if (top.length === 0) return [];
  const ids = top.map((r) => r.xpEarnedById);
  const [users, badges] = await Promise.all([
    db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, photoUpdatedAt: true } }),
    db.task.findMany({ where: { ...where, xpEarnedById: { in: ids }, badge: { not: null } }, select: { xpEarnedById: true, badge: true }, distinct: ["xpEarnedById", "badge"] }),
  ]);
  const byId = new Map(users.map((u) => [u.id, u]));
  return top.map((r) => ({
    userId: r.xpEarnedById,
    name: byId.get(r.xpEarnedById)?.name ?? "Somebody who has left",
    photoUpdatedAt: byId.get(r.xpEarnedById)?.photoUpdatedAt ?? null,
    xp: r._sum.xpEarned ?? 0,
    tasks: r._count._all,
    badges: badges.filter((b) => b.xpEarnedById === r.xpEarnedById && b.badge).map((b) => b.badge!),
  }));
}

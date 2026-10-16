import { db } from "@/lib/db";
import type { AvatarUser } from "@/components/ui/avatar";

/**
 * What a lead's card on the board shows beyond the lead itself (owner, 16 Oct 2026): its tasks done out
 * of all, the products asked for, the calls and notes logged, and the people on it — the owner, then
 * whoever has a task on it. Counts only, never what they say. One query a kind for the whole board.
 * Server only.
 */

export type LeadBoardExtras = {
  tasksDone: number;
  tasksTotal: number;
  products: number;
  /** Calls and notes logged on it. */
  touches: number;
  people: AvatarUser[];
};

export async function leadBoardExtras(leads: { id: string; ownerUserId: string | null }[]): Promise<Record<string, LeadBoardExtras>> {
  const ids = leads.map((l) => l.id);
  const out: Record<string, LeadBoardExtras> = {};
  if (ids.length === 0) return out;
  const [tasks, assignees, products, activities, calls] = await Promise.all([
    db.task.groupBy({ by: ["leadId", "done"], where: { leadId: { in: ids } }, _count: { _all: true } }),
    db.task.findMany({
      where: { leadId: { in: ids }, assignedToUserId: { not: null } },
      select: { leadId: true, assignedToUserId: true },
      distinct: ["leadId", "assignedToUserId"],
    }),
    db.leadRequirement.groupBy({ by: ["leadId"], where: { leadId: { in: ids } }, _count: { _all: true } }),
    db.activity.groupBy({ by: ["leadId"], where: { leadId: { in: ids } }, _count: { _all: true } }),
    db.callLog.groupBy({ by: ["leadId"], where: { leadId: { in: ids } }, _count: { _all: true } }),
  ]);

  const peopleIds = new Map<string, string[]>();
  for (const lead of leads) peopleIds.set(lead.id, lead.ownerUserId ? [lead.ownerUserId] : []);
  for (const a of assignees) {
    if (!a.leadId || !a.assignedToUserId) continue;
    const list = peopleIds.get(a.leadId);
    if (list && !list.includes(a.assignedToUserId)) list.push(a.assignedToUserId);
  }
  const everyone = [...new Set([...peopleIds.values()].flat())];
  const users = everyone.length
    ? await db.user.findMany({ where: { id: { in: everyone } }, select: { id: true, name: true, photoUpdatedAt: true } })
    : [];
  const userById = new Map(users.map((u) => [u.id, u]));

  for (const id of ids) out[id] = { tasksDone: 0, tasksTotal: 0, products: 0, touches: 0, people: [] };
  for (const t of tasks) {
    if (!t.leadId || !out[t.leadId]) continue;
    out[t.leadId]!.tasksTotal += t._count._all;
    if (t.done) out[t.leadId]!.tasksDone += t._count._all;
  }
  for (const p of products) if (out[p.leadId]) out[p.leadId]!.products = p._count._all;
  for (const a of activities) if (out[a.leadId]) out[a.leadId]!.touches += a._count._all;
  for (const c of calls) if (c.leadId && out[c.leadId]) out[c.leadId]!.touches += c._count._all;
  for (const [leadId, people] of peopleIds) {
    out[leadId]!.people = people.map((id) => userById.get(id)).filter((u): u is NonNullable<typeof u> => !!u);
  }
  return out;
}

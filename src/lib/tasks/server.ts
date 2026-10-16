import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { workspaceClock } from "@/lib/time/workspace";
import { closes, dayKeyOf, earnsXp, nextOccurrence, type TaskStatusKey } from "@/lib/tasks/rules";

/**
 * Advanced tasks on the server (owner, 16 Oct 2026). Server only.
 *
 * The task's newer columns are left out of every read by default until each workspace has them
 * (NOT_YET_EVERYWHERE, src/lib/tenancy/clients.ts); a read that wants them asks with `ADVANCED`.
 */

/** Put the newer columns back into a read. */
export const ADVANCED = {
  status: false,
  priority: false,
  startDate: false,
  estimateMinutes: false,
  departmentId: false,
  challengeId: false,
  xp: false,
  xpSetById: false,
  badge: false,
  xpEarned: false,
  xpEarnedById: false,
  xpEarnedAt: false,
  repeat: false,
  repeatUntil: false,
  repeatedFromId: false,
} as const satisfies Prisma.TaskOmit;

/** A calendar day as a stored day: its midnight UTC, as `dueDate` and `startDate` hold it. */
export const storedDay = (day: string) => new Date(`${day}T00:00:00.000Z`);

/**
 * Moves a task to a status — the one way a task is closed or opened again, whether through the status
 * menu, the board, or the old tick:
 *
 *   · Done and Cancelled set `done`; To do and In progress clear it.
 *   · Done on or before its due day earns its XP for its assignee, unless they set it themselves; any
 *     other move takes an earned XP back.
 *   · A call's follow-up follows its task, as it always has.
 *   · Done, a repeating task makes its next one — once.
 *
 * Asks nothing about who may: the caller has.
 */
export async function moveTask(taskId: string, status: TaskStatusKey): Promise<{ nextTaskId: string | null } | null> {
  const today = (await workspaceClock()).today();
  return db.$transaction(async (tx) => {
    const task = await tx.task.findUnique({ where: { id: taskId }, omit: ADVANCED, include: { checklist: { orderBy: { sortOrder: "asc" } } } });
    if (!task) return null;
    const closing = closes(status);
    const earns = status === "DONE" && earnsXp(task, today) && task.xpSetById !== task.assignedToUserId;
    await tx.task.update({
      where: { id: taskId },
      data: {
        status,
        done: closing,
        doneAt: closing ? (task.done ? task.doneAt : new Date()) : null,
        ...(earns
          ? { xpEarned: task.xp, xpEarnedById: task.assignedToUserId, xpEarnedAt: task.xpEarnedAt ?? new Date() }
          : { xpEarned: null, xpEarnedById: null, xpEarnedAt: null }),
      },
    });
    const call = await tx.callLog.findUnique({ where: { followUpTaskId: taskId }, select: { id: true } });
    if (call) await tx.callLog.update({ where: { id: call.id }, data: { followUpDone: closing } });

    if (status !== "DONE" || !task.repeat) return { nextTaskId: null };
    if ((await tx.task.count({ where: { repeatedFromId: taskId } })) > 0) return { nextTaskId: null };
    // The next one is a step on from its due day (or its start, or today), its start moved as far.
    const from = task.dueDate ? dayKeyOf(task.dueDate) : task.startDate ? dayKeyOf(task.startDate) : today;
    const nextDue = nextOccurrence(from, task.repeat);
    if (task.repeatUntil && nextDue > dayKeyOf(task.repeatUntil)) return { nextTaskId: null };
    const shift = storedDay(nextDue).getTime() - storedDay(from).getTime();
    const next = await tx.task.create({
      data: {
        title: task.title,
        description: task.description,
        dueDate: task.dueDate || !task.startDate ? storedDay(nextDue) : null,
        startDate: task.startDate ? new Date(task.startDate.getTime() + shift) : null,
        assignedToUserId: task.assignedToUserId,
        createdByUserId: task.createdByUserId,
        companyId: task.companyId,
        leadId: task.leadId,
        ticketId: task.ticketId,
        projectId: task.projectId,
        priority: task.priority,
        estimateMinutes: task.estimateMinutes,
        departmentId: task.departmentId,
        challengeId: task.challengeId,
        xp: task.xp,
        xpSetById: task.xpSetById,
        badge: task.badge,
        repeat: task.repeat,
        repeatUntil: task.repeatUntil,
        repeatedFromId: task.id,
        checklist: { create: task.checklist.map((c) => ({ title: c.title, sortOrder: c.sortOrder })) },
      },
      select: { id: true },
    });
    return { nextTaskId: next.id };
  });
}

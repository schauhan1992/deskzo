import { z } from "zod";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { ActionError, defineAction } from "@/lib/automate/action-types";
import { withEffect } from "@/lib/automate/effects";
import { emitEvent } from "@/lib/automate/events";
import type { Clock } from "@/lib/time/zone";

/**
 * Create a task (Deskzo Automate, Phase 1). As the workflow's owner: they are its creator, and the
 * assignee is told as `createTask` tells them (src/actions/task.ts). The due date is a calendar day
 * on the workspace's clock, held at UTC midnight as every due date is. The task's creation is
 * recorded as a `task.created` event caused by this run, one level deeper.
 */

const input = z
  .object({
    title: z.string().trim().min(1, "A task needs a title.").max(200),
    description: z.string().max(4000).optional(),
    /** "owner" (the workflow's owner), or a person's id. */
    assignTo: z.string().min(1).max(40).default("owner"),
    /** Days from today, on the workspace's clock: 0 is today. No due date when not given. */
    dueInDays: z.number().int().min(0).max(365).optional(),
  })
  .strict();

/** The calendar day `days` after today here, held as a due date is held: UTC midnight of that day. */
export function dueDayFrom(clock: Clock, days: number, now: Date = new Date()): Date {
  const [y, m, d] = clock.today(now).split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days));
}

export const taskCreate = defineAction({
  key: "task.create",
  label: "Create a task",
  description: "Adds a task for the workflow's owner or another person, with an optional due date.",
  module: "tasks",
  permission: null,
  risk: "change",
  input,
  preview: (i) => `Would create the task "${i.title}"${i.dueInDays === undefined ? "" : i.dueInDays === 0 ? ", due today" : `, due in ${i.dueInDays} day${i.dueInDays === 1 ? "" : "s"}`}.`,
  async run(ctx, i) {
    const assigneeId = i.assignTo === "owner" ? ctx.actorId : i.assignTo;
    const assignee = await db.user.findUnique({ where: { id: assigneeId }, select: { id: true, active: true } });
    if (!assignee?.active) throw new ActionError("The person to assign isn't an active user.", "PERMANENT");
    const dueDate = i.dueInDays === undefined ? null : dueDayFrom(ctx.clock, i.dueInDays);

    const { output, fresh } = await withEffect(ctx, async (tx) => {
      const task = await tx.task.create({
        data: { title: i.title, description: i.description || null, dueDate, assignedToUserId: assignee.id, createdByUserId: ctx.actorId, status: "TODO" },
        select: { id: true },
      });
      await emitEvent(tx, {
        type: "task.created",
        recordType: "task",
        recordId: task.id,
        payload: { task: { id: task.id, title: i.title, assignedToUserId: assignee.id, dueDate: dueDate?.toISOString() ?? null } },
        actorUserId: ctx.actorId,
        causedByRunId: ctx.runId,
        depth: ctx.depth + 1,
      });
      return { output: { taskId: task.id, assignedToUserId: assignee.id }, recordType: "task", recordId: task.id };
    });

    if (fresh) {
      if (assignee.id !== ctx.actorId) {
        await notifyUser({ userId: assignee.id, type: "TASK_ASSIGNED", title: "A task was assigned to you", message: i.title, link: "/tasks" });
      }
      await recordAudit({ userId: ctx.actorId, action: "CREATE", entityType: "Task", entityId: output.taskId, entityLabel: `${i.title} — by workflow "${ctx.workflowName}"` });
    }
    return output;
  },
});

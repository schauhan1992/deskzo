import { z } from "zod";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { leadPath, ticketPath } from "@/lib/record-links";
import { ActionError, causedBy, defineAction } from "@/lib/automate/action-types";
import { withEffect } from "@/lib/automate/effects";
import { emitTask } from "@/lib/automate/emit-records";
import { notReached, reach } from "@/lib/automate/actions/shared";
import type { Clock } from "@/lib/time/zone";

/**
 * Create a task (Deskzo Automate). As the workflow's owner: they are its creator, and the assignee is
 * told as `createTask` tells them (src/actions/task.ts). The due date is a calendar day on the
 * workspace's clock, held at UTC midnight as every due date is. The task's creation is recorded as a
 * `task.created` event caused by this run, one level deeper.
 *
 * It may be about a lead, a ticket or a customer (one the owner reaches), and then shows on that
 * record's page; "lead_owner" gives it to whoever owns the lead when the step runs — after an earlier
 * step reassigned it, the new owner — as a pipeline automation's task did.
 */

const id = z.string().trim().min(1).max(60).optional();

const input = z
  .object({
    title: z.string().trim().min(1, "A task needs a title.").max(200),
    description: z.string().max(4000).optional(),
    /** "owner" (the workflow's owner), "lead_owner" (the lead's owner now), or a person's id. */
    assignTo: z.string().min(1).max(40).default("owner"),
    /** Days from today, on the workspace's clock: 0 is today. No due date when not given. */
    dueInDays: z.number().int().min(0).max(365).optional(),
    leadId: id,
    ticketId: id,
    companyId: id,
  })
  .strict()
  .refine((i) => i.assignTo !== "lead_owner" || !!i.leadId, { message: "Say which lead, to give the task to its owner.", path: ["leadId"] });

/** The calendar day `days` after today here, held as a due date is held: UTC midnight of that day. */
export function dueDayFrom(clock: Clock, days: number, now: Date = new Date()): Date {
  const [y, m, d] = clock.today(now).split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days));
}

export const taskCreate = defineAction({
  key: "task.create",
  label: "Create a task",
  description: "Adds a task for the workflow's owner, a lead's owner or another person, with an optional due date, on a lead, ticket or customer.",
  module: "tasks",
  permission: null,
  risk: "change",
  input,
  outputs: ["taskId", "assignedToUserId"],
  preview: (i) => `Would create the task "${i.title}"${i.dueInDays === undefined ? "" : i.dueInDays === 0 ? ", due today" : `, due in ${i.dueInDays} day${i.dueInDays === 1 ? "" : "s"}`}.`,
  async run(ctx, i) {
    // What it is about: a lead or a ticket brings its customer; each must be one the owner reaches.
    let companyId = i.companyId ?? null;
    let lead: { id: string; leadSeq: number; ownerUserId: string | null; companyId: string } | null = null;
    let ticket: { id: string; ticketSeq: number; companyId: string } | null = null;
    if (i.leadId) {
      await reach(ctx, "leads", "view", i.leadId, "lead");
      lead = await db.lead.findUnique({ where: { id: i.leadId }, select: { id: true, leadSeq: true, ownerUserId: true, companyId: true } });
      if (!lead) throw notReached("lead");
      companyId = lead.companyId;
    }
    if (i.ticketId) {
      await reach(ctx, "tickets", "view", i.ticketId, "ticket");
      ticket = await db.ticket.findUnique({ where: { id: i.ticketId }, select: { id: true, ticketSeq: true, companyId: true } });
      if (!ticket) throw notReached("ticket");
      companyId ??= ticket.companyId;
    }
    if (i.companyId && !lead && !ticket) await reach(ctx, "companies", "view", i.companyId, "customer");

    const assigneeId = i.assignTo === "owner" ? ctx.actorId : i.assignTo === "lead_owner" ? lead?.ownerUserId : i.assignTo;
    if (!assigneeId) throw new ActionError("No task: the lead has no owner.", "PERMANENT");
    const assignee = await db.user.findUnique({ where: { id: assigneeId }, select: { id: true, active: true } });
    if (!assignee?.active) throw new ActionError("The person to assign isn't an active user.", "PERMANENT");
    const dueDate = i.dueInDays === undefined ? null : dueDayFrom(ctx.clock, i.dueInDays);

    const { output, fresh } = await withEffect(ctx, async (tx) => {
      const task = await tx.task.create({
        data: {
          title: i.title,
          description: i.description || null,
          dueDate,
          assignedToUserId: assignee.id,
          createdByUserId: ctx.actorId,
          status: "TODO",
          companyId,
          leadId: lead?.id ?? null,
          ticketId: ticket?.id ?? null,
        },
        select: { id: true },
      });
      await emitTask(tx, "task.created", task.id, ctx.actorId, causedBy(ctx));
      return { output: { taskId: task.id, assignedToUserId: assignee.id }, recordType: "task", recordId: task.id };
    });

    if (fresh) {
      if (assignee.id !== ctx.actorId) {
        const link = lead ? leadPath(lead.leadSeq) : ticket ? ticketPath(ticket.ticketSeq) : "/tasks";
        await notifyUser({ userId: assignee.id, type: "TASK_ASSIGNED", title: "A task was assigned to you", message: i.title, link });
      }
      await recordAudit({ userId: ctx.actorId, action: "CREATE", entityType: "Task", entityId: output.taskId, entityLabel: `${i.title} — by workflow "${ctx.workflowName}"` });
    }
    return output;
  },
});

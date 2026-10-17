import { z } from "zod";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { formatTicketId } from "@/lib/tickets";
import { ticketPath } from "@/lib/record-links";
import { isSupportAgent } from "@/lib/ticket-open";
import { ticketPriorityValues } from "@/lib/validation/ticket";
import { ActionError, defineAction } from "@/lib/automate/action-types";
import { priorOutput, withEffect } from "@/lib/automate/effects";
import { byWorkflow, notReached, reach, recordIdField } from "@/lib/automate/actions/shared";

/**
 * Escalate a ticket (Deskzo Automate, Phase 3): raise its priority, or give it to somebody else in
 * support — under the ticket page's rules (src/actions/ticket.ts): a ticket the workflow's owner may
 * change for its priority and may assign for its assignee, and an assignee from a support team, who
 * is told.
 */

type Output = { ticketId: string; priority: string; assignedToUserId: string | null; changed: boolean };

const input = z
  .object({
    ticketId: recordIdField("ticket"),
    priority: z.enum(ticketPriorityValues).optional(),
    /** Somebody in support, by id. */
    assignTo: z.string().trim().min(1).max(40).optional(),
  })
  .strict()
  .refine((i) => !!i.priority || !!i.assignTo, { message: "Change the priority, the assignee, or both.", path: ["priority"] });

export const ticketUpdate = defineAction({
  key: "ticket.update",
  label: "Escalate a ticket",
  description: "Raises a ticket's priority or gives it to somebody else in support.",
  module: "helpdesk",
  permission: null,
  risk: "change",
  input,
  outputs: ["ticketId", "priority", "assignedToUserId", "changed"],
  preview: (i) => `Would ${[i.priority ? `set the ticket's priority to ${i.priority.toLowerCase()}` : null, i.assignTo ? "give it to somebody in support" : null].filter(Boolean).join(" and ")}.`,
  async run(ctx, i): Promise<Output> {
    const done = await priorOutput<Output>(ctx);
    if (done) return done.output;

    if (i.priority) await reach(ctx, "tickets", "edit", i.ticketId, "ticket");
    if (i.assignTo) await reach(ctx, "tickets", "assign", i.ticketId, "ticket");
    const ticket = await db.ticket.findUnique({ where: { id: i.ticketId }, select: { id: true, ticketSeq: true, title: true, priority: true, assignedToUserId: true } });
    if (!ticket) throw notReached("ticket");
    if (i.assignTo) {
      const agent = await db.user.findUnique({ where: { id: i.assignTo }, select: { active: true } });
      if (!agent?.active || !(await isSupportAgent(i.assignTo))) throw new ActionError("Tickets can only be assigned to someone in the Tech Support department.", "PERMANENT");
    }
    const priority = i.priority ?? ticket.priority;
    const assignedToUserId = i.assignTo ?? ticket.assignedToUserId;
    if (priority === ticket.priority && assignedToUserId === ticket.assignedToUserId) return { ticketId: ticket.id, priority, assignedToUserId, changed: false };

    const { output, fresh } = await withEffect(ctx, async (tx) => {
      await tx.ticket.update({ where: { id: ticket.id }, data: { priority, assignedToUserId } });
      return { output: { ticketId: ticket.id, priority, assignedToUserId, changed: true }, recordType: "ticket", recordId: ticket.id };
    });
    if (fresh) {
      const ref = formatTicketId(ticket.ticketSeq);
      const what = [priority !== ticket.priority ? `priority ${ticket.priority} → ${priority}` : null, assignedToUserId !== ticket.assignedToUserId ? "reassigned" : null].filter(Boolean).join(", ");
      await recordAudit({ userId: ctx.actorId, action: "UPDATE", entityType: "Ticket", entityId: ticket.id, entityLabel: `${ref} — ${what} ${byWorkflow(ctx)}` });
      if (assignedToUserId && assignedToUserId !== ticket.assignedToUserId && assignedToUserId !== ctx.actorId) {
        await notifyUser({ userId: assignedToUserId, type: "TICKET_ASSIGNED", title: "A ticket was assigned to you", message: `${ref} — ${ticket.title}`, link: ticketPath(ticket.ticketSeq) });
      }
    }
    return output;
  },
});

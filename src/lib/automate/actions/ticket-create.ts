import { z } from "zod";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { formatTicketId } from "@/lib/tickets";
import { ticketPath } from "@/lib/record-links";
import { newTicketRefusal, writeTicket } from "@/lib/ticket-open";
import { ticketPriorityValues, ticketTypeValues } from "@/lib/validation/ticket";
import { ActionError, causedBy, defineAction } from "@/lib/automate/action-types";
import { priorOutput, withEffect } from "@/lib/automate/effects";
import { byWorkflow, recordIdField } from "@/lib/automate/actions/shared";

/**
 * Open a ticket for a customer (Deskzo Automate, Phase 2), as the workflow's owner — under the rules of
 * the New ticket form (src/lib/ticket-open.ts): a company they reach, its own contact and order, an
 * assignee from support, and none of the words the workspace keeps out of tickets.
 */

type Output = { ticketId: string; ticketSeq: number; ref: string };

const optionalId = z.string().trim().min(1).max(60).optional();

const input = z
  .object({
    companyId: recordIdField("company"),
    contactId: optionalId,
    /** The order it is about. */
    orderId: optionalId,
    title: z.string().trim().min(2, "Give the ticket a title.").max(200),
    description: z.string().trim().max(5000).optional(),
    ticketType: z.enum(ticketTypeValues).default("PRODUCT_SUPPORT"),
    priority: z.enum(ticketPriorityValues).default("MEDIUM"),
    /** Somebody in support, by id. */
    assignTo: optionalId,
  })
  .strict();

export const ticketCreate = defineAction({
  key: "ticket.create",
  label: "Open a ticket",
  description: "Opens a support ticket for a customer, optionally assigned to someone in support.",
  module: "helpdesk",
  permission: "tickets.create",
  risk: "change",
  input,
  outputs: ["ticketId", "ticketSeq", "ref"],
  preview: (i) => `Would open the ticket "${i.title}" (${i.priority.toLowerCase()} priority).`,
  async run(ctx, i): Promise<Output> {
    const done = await priorOutput<Output>(ctx);
    if (done) return done.output;

    const data = {
      companyId: i.companyId,
      contactId: i.contactId ?? "",
      companyProductId: i.orderId ?? "",
      title: i.title,
      description: i.description ?? "",
      ticketType: i.ticketType,
      priority: i.priority,
      assignedToUserId: i.assignTo ?? "",
    };
    const refused = await newTicketRefusal(ctx.actorId, data);
    if (refused) throw new ActionError(refused, "PERMANENT");

    const { output, fresh } = await withEffect(ctx, async (tx) => {
      const ticket = await writeTicket(tx, ctx.actorId, data, "workflow", causedBy(ctx));
      return { output: { ticketId: ticket.id, ticketSeq: ticket.ticketSeq, ref: formatTicketId(ticket.ticketSeq) }, recordType: "ticket", recordId: ticket.id };
    });
    if (fresh) {
      await recordAudit({ userId: ctx.actorId, action: "CREATE", entityType: "Ticket", entityId: output.ticketId, entityLabel: `${output.ref} — ${i.title} — ${byWorkflow(ctx)}` });
      if (i.assignTo && i.assignTo !== ctx.actorId) {
        await notifyUser({ userId: i.assignTo, type: "TICKET_ASSIGNED", title: "A ticket was assigned to you", message: `${output.ref} — ${i.title}`, link: ticketPath(output.ticketSeq) });
      }
    }
    return output;
  },
});

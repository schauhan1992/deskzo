import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { mayAddTo } from "@/lib/authz/access";
import { filteredWordsRefusal } from "@/lib/word-filter/server";
import { emitTicketCreated } from "@/lib/automate/emit-tickets";
import type { EventCause } from "@/lib/automate/action-types";
import type { CreateTicketInput } from "@/lib/validation/ticket";

/**
 * Opening a ticket by hand — the one way it is done, by a person (`createTicket`, src/actions/ticket.ts)
 * or by a workflow's step (src/lib/automate/actions). Whether the person may open tickets at all is the
 * caller's question; these are the rules about this one: a company they reach, a contact and an order
 * of that company, somebody in support to assign it to, and none of the words the workspace keeps out.
 */

/** Only users in a department marked as a support team can be assigned tickets. */
export async function isSupportAgent(userId: string): Promise<boolean> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { department: { select: { isSupportTeam: true } } },
  });
  return user?.department?.isSupportTeam ?? false;
}

/** Why this person can't open this ticket, in words — or null. */
export async function newTicketRefusal(actorId: string, data: CreateTicketInput): Promise<string | null> {
  const company = await db.company.findUnique({ where: { id: data.companyId } });
  // A ticket is logged on a company the person reaches — one they couldn't then open is refused as missing.
  if (!company || !(await mayAddTo(actorId, "tickets", company))) return "Company not found.";
  if (data.contactId) {
    const contact = await db.contact.findUnique({ where: { id: data.contactId } });
    if (!contact || contact.companyId !== data.companyId) return "That contact does not belong to the selected company.";
  }
  if (data.companyProductId) {
    const order = await db.companyProduct.findUnique({ where: { id: data.companyProductId } });
    if (!order || order.companyId !== data.companyId) return "That order does not belong to the selected company.";
  }
  if (data.assignedToUserId && !(await isSupportAgent(data.assignedToUserId))) {
    return "Tickets can only be assigned to someone in the Tech Support department.";
  }
  // Words the workspace keeps out of tickets (src/lib/word-filter): not saved, and only the writer is told.
  return filteredWordsRefusal("TICKETS", [data.title, data.description]);
}

/** The ticket, in the caller's transaction, with its event for workflows. */
export async function writeTicket(tx: Prisma.TransactionClient, actorId: string, data: CreateTicketInput, via: string, cause: EventCause | null = null) {
  const made = await tx.ticket.create({
    data: {
      companyId: data.companyId,
      contactId: data.contactId || null,
      companyProductId: data.companyProductId || null,
      title: data.title,
      description: data.description || null,
      ticketType: data.ticketType,
      priority: data.priority,
      assignedToUserId: data.assignedToUserId || null,
      createdByUserId: actorId,
    },
  });
  await emitTicketCreated(tx, made.id, actorId, via, cause);
  return made;
}

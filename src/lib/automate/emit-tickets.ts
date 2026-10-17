import type { Prisma } from "@prisma/client";
import { formatTicketId } from "@/lib/tickets";
import { emitEvents } from "@/lib/automate/events";
import type { EventCause } from "@/lib/automate/action-types";

/**
 * Deskzo Automate's ticket events (Phase 2): `ticket.created` and `ticket.status_changed`. Inside the
 * transaction that makes the change, from every way a ticket is opened — by a person, from an email,
 * from the Support inbox — and every way its status moves, bulk changes included. The ticket is read
 * behind the event's savepoint (`emitEvents`), so reading it can never fail the change.
 */

/** A ticket's part of an event's payload — also what a test run starts from (src/lib/automate/samples.ts). */
export async function ticketFacts(tx: Prisma.TransactionClient, ticketId: string) {
  const ticket = await tx.ticket.findUnique({
    where: { id: ticketId },
    select: {
      id: true,
      ticketSeq: true,
      title: true,
      ticketType: true,
      priority: true,
      status: true,
      companyId: true,
      contactId: true,
      assignedToUserId: true,
      company: { select: { name: true } },
    },
  });
  if (!ticket) return null;
  return {
    ticket: {
      id: ticket.id,
      ref: formatTicketId(ticket.ticketSeq),
      title: ticket.title,
      type: ticket.ticketType,
      priority: ticket.priority,
      status: ticket.status,
      companyId: ticket.companyId,
      contactId: ticket.contactId,
      assignedToUserId: ticket.assignedToUserId,
    },
    company: { id: ticket.companyId, name: ticket.company.name },
  };
}

/** A ticket was opened. `via`: "person", "email" (it wrote in), or "inbox" (filed from the Support inbox). */
export async function emitTicketCreated(tx: Prisma.TransactionClient, ticketId: string, actorUserId: string | null, via: string, cause: EventCause | null = null): Promise<void> {
  await emitEvents(tx, "ticket.created", async () => {
    const facts = await ticketFacts(tx, ticketId);
    return facts && { type: "ticket.created", recordType: "ticket", recordId: ticketId, payload: { ...facts, via }, actorUserId, ...cause };
  });
}

/** A ticket's status moved. Keyed by ticket and status, so two quick moves are two events. */
export async function emitTicketStatusChanged(tx: Prisma.TransactionClient, ticketId: string, actorUserId: string | null, from: string, to: string, cause: EventCause | null = null): Promise<void> {
  if (from === to) return;
  await emitEvents(tx, "ticket.status_changed", async () => {
    const facts = await ticketFacts(tx, ticketId);
    return facts && { type: "ticket.status_changed", recordType: "ticket", recordId: `${ticketId}>${to}`, payload: { ...facts, from, to }, actorUserId, ...cause };
  });
}

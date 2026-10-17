import type { Prisma } from "@prisma/client";
import { formatOrderId, formatPaymentId } from "@/lib/order-id";
import { emitEvent, emitEvents } from "@/lib/automate/events";
import type { EventCause } from "@/lib/automate/action-types";

/**
 * Deskzo Automate's events for documents, payments, orders, bookings and tasks (Phase 2). Each is
 * called inside the transaction that makes the change. Payloads carry ids and the fields a workflow
 * tests or writes into a message — amounts, numbers, statuses — never a customer's contact details.
 * Records are read behind the event's savepoint (`emitEvents`), so reading one can never fail the change.
 */

const money = (value: Prisma.Decimal | number | null | undefined) => (value === null || value === undefined ? null : Number(value));
const iso = (value: Date | null | undefined) => value?.toISOString() ?? null;

// ─── Documents ─────────────────────────────────────────────────────────────────────────────────

/** The payloads' parts, also what a test run starts from (src/lib/automate/samples.ts). */
export async function documentFacts(tx: Prisma.TransactionClient, documentId: string) {
  const doc = await tx.tradeDocument.findUnique({
    where: { id: documentId },
    select: { id: true, docNumber: true, docType: true, status: true, companyId: true, total: true, currency: true, issueDate: true, dueDate: true, salespersonId: true, company: { select: { name: true } } },
  });
  if (!doc) return null;
  return {
    document: {
      id: doc.id,
      number: doc.docNumber,
      type: doc.docType,
      status: doc.status,
      companyId: doc.companyId,
      total: money(doc.total),
      currency: doc.currency,
      issueDate: iso(doc.issueDate),
      dueDate: iso(doc.dueDate),
      salespersonId: doc.salespersonId,
    },
    company: { id: doc.companyId, name: doc.company.name },
  };
}

/** A quote, proforma, invoice or note was issued. Filter on `document.type`. */
export async function emitDocumentIssued(tx: Prisma.TransactionClient, documentId: string, actorUserId: string | null): Promise<void> {
  await emitEvents(tx, "document.issued", async () => {
    const facts = await documentFacts(tx, documentId);
    return facts && { type: "document.issued", recordType: "document", recordId: documentId, payload: facts, actorUserId };
  });
}

/** An invoice became fully paid. */
export async function emitInvoicePaid(tx: Prisma.TransactionClient, documentId: string, actorUserId: string | null): Promise<void> {
  await emitEvents(tx, "invoice.paid", async () => {
    const facts = await documentFacts(tx, documentId);
    return facts && { type: "invoice.paid", recordType: "document", recordId: documentId, payload: facts, actorUserId };
  });
}

// ─── Payments ──────────────────────────────────────────────────────────────────────────────────

/** Money came in. `invoiceId` when it was recorded against an invoice. */
export async function paymentFacts(tx: Prisma.TransactionClient, paymentId: string, invoiceId: string | null = null) {
  const p = await tx.payment.findUnique({
    where: { id: paymentId },
    select: { id: true, paymentSeq: true, direction: true, amount: true, currency: true, method: true, reference: true, companyId: true, company: { select: { name: true } } },
  });
  if (!p || p.direction !== "RECEIVED") return null;
  return {
    payment: { id: p.id, ref: formatPaymentId(p.paymentSeq), amount: money(p.amount), currency: p.currency, method: p.method, reference: p.reference, companyId: p.companyId, invoiceId },
    company: { id: p.companyId, name: p.company.name },
  };
}

export async function emitPaymentReceived(tx: Prisma.TransactionClient, paymentId: string, actorUserId: string | null, invoiceId: string | null = null): Promise<void> {
  await emitEvents(tx, "payment.received", async () => {
    const payload = await paymentFacts(tx, paymentId, invoiceId);
    return payload && { type: "payment.received", recordType: "payment", recordId: paymentId, payload, actorUserId };
  });
}

// ─── Orders ────────────────────────────────────────────────────────────────────────────────────

export type OrderEvent = "order.created" | "order.approved" | "order.fulfilled";

export async function orderFacts(tx: Prisma.TransactionClient, orderId: string) {
  const o = await tx.companyProduct.findUnique({
    where: { id: orderId },
    select: { id: true, orderSeq: true, orderStatus: true, companyId: true, itemId: true, quantity: true, unitPrice: true, addedByUserId: true, company: { select: { name: true } }, item: { select: { name: true } } },
  });
  if (!o) return null;
  return {
    order: { id: o.id, ref: formatOrderId(o.orderSeq), status: o.orderStatus, companyId: o.companyId, itemId: o.itemId, itemName: o.item.name, quantity: o.quantity, unitPrice: money(o.unitPrice), addedByUserId: o.addedByUserId },
    company: { id: o.companyId, name: o.company.name },
  };
}

export async function emitOrder(tx: Prisma.TransactionClient, type: OrderEvent, orderId: string, actorUserId: string | null): Promise<void> {
  await emitEvents(tx, type, async () => {
    const payload = await orderFacts(tx, orderId);
    return payload && { type, recordType: "order", recordId: orderId, payload, actorUserId };
  });
}

// ─── Bookings ──────────────────────────────────────────────────────────────────────────────────

/** Somebody booked a slot on a booking page. Its lead, if one was made, is `leadId`. */
export async function emitBookingMade(
  tx: Prisma.TransactionClient,
  booking: { id: string; pageId: string; pageTitle: string; hostUserId: string; startsAt: Date; endsAt: Date },
  links: { companyId: string | null; contactId: string | null; leadId: string | null },
): Promise<void> {
  await emitEvent(tx, {
    type: "booking.made",
    recordType: "booking",
    recordId: booking.id,
    payload: { booking: { id: booking.id, pageId: booking.pageId, page: booking.pageTitle, hostUserId: booking.hostUserId, startsAt: iso(booking.startsAt), endsAt: iso(booking.endsAt) }, ...links },
  });
}

// ─── Tasks ─────────────────────────────────────────────────────────────────────────────────────

export type TaskEvent = "task.created" | "task.completed";

export async function taskFacts(tx: Prisma.TransactionClient, taskId: string) {
  const t = await tx.task.findUnique({
    where: { id: taskId },
    select: { id: true, title: true, status: true, priority: true, dueDate: true, assignedToUserId: true, createdByUserId: true, companyId: true, leadId: true, ticketId: true },
  });
  if (!t) return null;
  return { task: { id: t.id, title: t.title, status: t.status, priority: t.priority, dueDate: iso(t.dueDate), assignedToUserId: t.assignedToUserId, createdByUserId: t.createdByUserId, companyId: t.companyId, leadId: t.leadId, ticketId: t.ticketId } };
}

export async function emitTask(tx: Prisma.TransactionClient, type: TaskEvent, taskId: string, actorUserId: string | null, cause: EventCause | null = null): Promise<void> {
  await emitEvents(tx, type, async () => {
    const payload = await taskFacts(tx, taskId);
    return payload && { type, recordType: "task", recordId: taskId, payload, actorUserId, ...cause };
  });
}

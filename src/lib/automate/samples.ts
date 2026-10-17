import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { companyAccess, documentAccess, leadAccess, orderAccess, paymentAccess, taskAccess, ticketAccess } from "@/lib/authz/access";
import { workspaceClock } from "@/lib/time/workspace";
import { leadFacts } from "@/lib/automate/emit-leads";
import { ticketFacts } from "@/lib/automate/emit-tickets";
import { documentFacts, orderFacts, paymentFacts, taskFacts } from "@/lib/automate/emit-records";

/**
 * What a test run starts from (Deskzo Automate, Phase 3): the latest real record of the kind a trigger
 * is about — the last lead, the last ticket, an overdue invoice — that the person testing can see,
 * turned into exactly the payload a real event would carry (the same builders as src/lib/automate/emit-*.ts).
 * A test then shows what the workflow would do with a real case rather than a made-up one.
 *
 * Null when there is no such record yet: the builder says so, and the test runs on nothing.
 */

export type Sample = { payload: Record<string, unknown>; about: string };

const DAY_MS = 86_400_000;
const tx = () => db as unknown as Prisma.TransactionClient;

/**
 * Records that may have no customer: those without one, and those on a customer the person reaches. An
 * empty reach (everybody's) is no filter at all — inside an OR, `company: {}` would match nothing.
 */
async function noneOrReached(userId: string): Promise<{ OR?: ({ companyId: null } | { company: { is: Prisma.CompanyWhereInput } })[] }> {
  const reached = await companyAccess(userId, "view");
  return Object.keys(reached).length === 0 ? {} : { OR: [{ companyId: null }, { company: { is: reached } }] };
}

export async function sampleTrigger(userId: string, type: string, now: Date = new Date(), workflowId: string | null = null): Promise<Sample | null> {
  const clock = await workspaceClock();
  const day = clock.calendarDate(now);

  if (type === "schedule") return { payload: { scheduledFor: now.toISOString(), firedAt: now.toISOString() }, about: "this moment, as if the schedule came due" };
  if (type === "manual") return { payload: { startedById: userId, data: {} }, about: "you pressing Run" };
  if (type === "webhook") {
    // The last call this workflow's address took — or none yet.
    const last = workflowId
      ? await db.automationEvent.findFirst({ where: { type: "webhook", payload: { path: ["workflowId"], equals: workflowId } }, orderBy: { occurredAt: "desc" }, select: { payload: true } })
      : null;
    return last ? { payload: last.payload as Record<string, unknown>, about: "the last call to its webhook address" } : null;
  }

  if (type.startsWith("lead.")) {
    const where: Prisma.LeadWhereInput = {
      AND: [
        await leadAccess(userId, "view"),
        type === "lead.won" ? { status: "WON" } : type === "lead.lost" ? { status: { in: ["LOST", "DISQUALIFIED"] } } : type === "lead.quiet" ? { status: { notIn: ["WON", "LOST", "DISQUALIFIED"] } } : {},
      ],
    };
    const lead = await db.lead.findFirst({ where, orderBy: type === "lead.quiet" ? { updatedAt: "asc" } : { createdAt: "desc" }, select: { id: true, title: true, status: true, updatedAt: true } });
    if (!lead) return null;
    const facts = await leadFacts(tx(), lead.id);
    if (!facts) return null;
    const about = `the lead "${facts.lead.title}"`;
    const at = { stageId: facts.lead.stageId, status: facts.lead.status, pipelineId: facts.lead.pipelineId };
    switch (type) {
      case "lead.created":
      case "lead.arrived":
        return { payload: { ...facts, via: "person" }, about };
      case "lead.quiet":
        return { payload: { lead: facts.lead, company: facts.company, daysQuiet: Math.max(3, Math.floor((now.getTime() - lead.updatedAt.getTime()) / DAY_MS)) }, about };
      default:
        return { payload: { ...facts, from: { stageId: null, status: "NEW", pipelineId: at.pipelineId }, to: at }, about };
    }
  }

  if (type.startsWith("ticket.")) {
    const ticket = await db.ticket.findFirst({ where: await ticketAccess(userId, "view"), orderBy: { createdAt: "desc" }, select: { id: true } });
    const facts = ticket ? await ticketFacts(tx(), ticket.id) : null;
    if (!facts) return null;
    const about = `ticket ${facts.ticket.ref}`;
    return type === "ticket.created" ? { payload: { ...facts, via: "person" }, about } : { payload: { ...facts, from: "OPEN", to: facts.ticket.status }, about };
  }

  if (type === "document.issued" || type.startsWith("invoice.")) {
    const scope = await documentAccess(userId, "view");
    const unsettled = { docType: "INVOICE" as const, status: { notIn: ["DRAFT" as const, "CANCELLED" as const, "PAID" as const] } };
    const narrowed: Prisma.TradeDocumentWhereInput =
      type === "document.issued"
        ? { status: { notIn: ["DRAFT", "CANCELLED"] } }
        : type === "invoice.paid"
          ? { docType: "INVOICE", status: "PAID" }
          : type === "invoice.overdue"
            ? { ...unsettled, dueDate: { lt: day } }
            : { ...unsettled, dueDate: { gte: day } };
    const doc = await db.tradeDocument.findFirst({ where: { AND: [scope, narrowed] }, orderBy: type === "invoice.due_soon" ? { dueDate: "asc" } : { createdAt: "desc" }, select: { id: true, dueDate: true } });
    const facts = doc ? await documentFacts(tx(), doc.id) : null;
    if (!facts) return null;
    const about = `${facts.document.type.toLowerCase().replace(/_/g, " ")} ${facts.document.number ?? ""}`.trim();
    const days = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / DAY_MS);
    if (type === "invoice.overdue") return { payload: { ...facts, daysOverdue: doc!.dueDate ? days(doc!.dueDate, day) : null }, about };
    if (type === "invoice.due_soon") return { payload: { ...facts, daysUntilDue: doc!.dueDate ? days(day, doc!.dueDate) : null }, about };
    return { payload: facts, about };
  }

  if (type === "payment.received") {
    const payment = await db.payment.findFirst({ where: { AND: [await paymentAccess(userId, "view"), { direction: "RECEIVED" }] }, orderBy: { createdAt: "desc" }, select: { id: true } });
    const facts = payment ? await paymentFacts(tx(), payment.id) : null;
    return facts ? { payload: facts, about: `payment ${facts.payment.ref}` } : null;
  }

  if (type.startsWith("order.") || type === "renewal.due") {
    const scope = await orderAccess(userId, "view");
    const renewal = type === "renewal.due";
    const order = await db.companyProduct.findFirst({
      where: { AND: [scope, renewal ? { parentId: null, item: { type: "SUBSCRIPTION" }, endDate: { gte: day } } : {}] },
      orderBy: renewal ? { endDate: "asc" } : { createdAt: "desc" },
      select: { id: true, endDate: true },
    });
    const facts = order ? await orderFacts(tx(), order.id) : null;
    if (!facts) return null;
    const about = `order ${facts.order.ref}`;
    if (!renewal) return { payload: facts, about };
    const owner = await db.company.findUnique({ where: { id: facts.company.id }, select: { ownerUserId: true } });
    return {
      payload: { order: { ...facts.order, endDate: order!.endDate?.toISOString() ?? null }, company: { ...facts.company, ownerUserId: owner?.ownerUserId ?? null }, daysLeft: order!.endDate ? Math.round((order!.endDate.getTime() - day.getTime()) / DAY_MS) : null },
      about,
    };
  }

  if (type === "form.submitted") {
    const submission = await db.formSubmission.findFirst({
      where: await noneOrReached(userId),
      orderBy: { createdAt: "desc" },
      select: { id: true, companyId: true, contactId: true, leadId: true, inviteId: true, form: { select: { id: true, name: true } } },
    });
    if (!submission) return null;
    return {
      payload: { form: submission.form, submission: { id: submission.id }, companyId: submission.companyId, contactId: submission.contactId, leadId: submission.leadId, invited: !!submission.inviteId },
      about: `the latest response to "${submission.form.name}"`,
    };
  }

  if (type === "booking.made") {
    const booking = await db.booking.findFirst({
      where: await noneOrReached(userId),
      orderBy: { createdAt: "desc" },
      select: { id: true, pageId: true, hostUserId: true, startsAt: true, endsAt: true, companyId: true, contactId: true, leadId: true, page: { select: { title: true } } },
    });
    if (!booking) return null;
    return {
      payload: {
        booking: { id: booking.id, pageId: booking.pageId, page: booking.page.title, hostUserId: booking.hostUserId, startsAt: booking.startsAt.toISOString(), endsAt: booking.endsAt.toISOString() },
        companyId: booking.companyId,
        contactId: booking.contactId,
        leadId: booking.leadId,
      },
      about: `the latest booking on "${booking.page.title}"`,
    };
  }

  if (type.startsWith("task.")) {
    const task = await db.task.findFirst({ where: { AND: [await taskAccess(userId, "view"), type === "task.completed" ? { status: "DONE" } : {}] }, orderBy: { createdAt: "desc" }, select: { id: true } });
    const facts = task ? await taskFacts(tx(), task.id) : null;
    return facts ? { payload: facts, about: `the task "${facts.task.title}"` } : null;
  }

  return null;
}

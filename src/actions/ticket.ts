"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type TicketStatus, type TicketPriority, type TicketType } from "@prisma/client";
import { db } from "@/lib/db";
import { CATEGORY_SELECT } from "@/lib/customers/categories";
import { requireModuleUser } from "@/lib/modules-access";
import { viaCompanyScope } from "@/lib/authz/company-scope";
import { hasEffectivePermission, viewerHas } from "@/actions/permission";
import { notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { formatTicketId } from "@/lib/tickets";
import { ticketPath } from "@/lib/record-links";
import { pageSlice } from "@/lib/pagination";
import {
  createTicketSchema,
  updateTicketStatusSchema,
  updateTicketPrioritySchema,
  assignTicketSchema,
  bulkUpdateTicketsSchema,
  addTicketCommentSchema,
} from "@/lib/validation/ticket";
import type { ActionResult } from "@/actions/company";

/** Only users in a department marked as a support team can be assigned tickets. */
async function isSupportAgent(userId: string): Promise<boolean> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { department: { select: { isSupportTeam: true } } },
  });
  return user?.department?.isSupportTeam ?? false;
}

/** Active users belonging to a department marked as a support team — the only people a ticket can be assigned to. */
export async function listSupportAgents() {
  await requireModuleUser("helpdesk");
  return db.user.findMany({
    where: { active: true, department: { isSupportTeam: true } },
    orderBy: { name: "asc" },
    select: { id: true, name: true, role: true },
  });
}

export async function createTicket(input: unknown): Promise<ActionResult<{ id: string; ticketSeq: number }>> {
  const user = await requireModuleUser("helpdesk");
  if (!(await hasEffectivePermission(user.id, "tickets.create"))) {
    return { ok: false, error: "You don't have permission to create tickets." };
  }
  const parsed = createTicketSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  const company = await db.company.findUnique({ where: { id: data.companyId } });
  if (!company) {
    return { ok: false, error: "Company not found." };
  }
  if (data.contactId) {
    const contact = await db.contact.findUnique({ where: { id: data.contactId } });
    if (!contact || contact.companyId !== data.companyId) {
      return { ok: false, error: "That contact does not belong to the selected company." };
    }
  }
  if (data.companyProductId) {
    const order = await db.companyProduct.findUnique({ where: { id: data.companyProductId } });
    if (!order || order.companyId !== data.companyId) {
      return { ok: false, error: "That order does not belong to the selected company." };
    }
  }
  if (data.assignedToUserId && !(await isSupportAgent(data.assignedToUserId))) {
    return { ok: false, error: "Tickets can only be assigned to someone in the Tech Support department." };
  }

  const ticket = await db.ticket.create({
    data: {
      companyId: data.companyId,
      contactId: data.contactId || null,
      companyProductId: data.companyProductId || null,
      title: data.title,
      description: data.description || null,
      ticketType: data.ticketType,
      priority: data.priority,
      assignedToUserId: data.assignedToUserId || null,
      createdByUserId: user.id,
    },
  });

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "Ticket",
    entityId: ticket.id,
    entityLabel: `${formatTicketId(ticket.ticketSeq)} — ${ticket.title}`,
  });

  revalidatePath("/tickets");
  revalidatePath(`/companies/${data.companyId}`);
  return { ok: true, data: { id: ticket.id, ticketSeq: ticket.ticketSeq } };
}

/** Lightweight order list for the ticket "which order is this support for?" picker — no Decimal fields, so it's safe to pass straight to a Client Component. */
export async function listCompanyOrderOptions(companyId: string) {
  const user = await requireModuleUser("helpdesk");
  return db.companyProduct.findMany({
    // Scoped as well as filtered by id: the company id arrives from the caller and is not a
    // secret, so without this the picker would list what any account has bought to anyone who
    // passes one in. An order reaches the company directly, same one hop as the ticket.
    where: { companyId, ...(await viaCompanyScope(user.id)) },
    orderBy: { createdAt: "desc" },
    select: { id: true, orderSeq: true, item: { select: { name: true } } },
  });
}

type TicketListParams = {
  status?: TicketStatus;
  priority?: TicketPriority;
  ticketType?: TicketType;
  assignedToUserId?: string;
  search?: string;
  companyId?: string;
};

/**
 * A ticket reaches its company in one hop — `Ticket.companyId` — so the account manager on that
 * company is what decides whose ticket it is, exactly as `companies.viewAll` describes.
 *
 * Support is untouched by this: every support preset holds `companies.viewAll`, so
 * `viaCompanyScope` hands them `{}` and the helpdesk still sees every ticket in the business.
 * `params.companyId` is a scalar and the scope is a relation filter, so the two never collide.
 */
async function ticketListWhere(userId: string, params?: TicketListParams): Promise<Prisma.TicketWhereInput> {
  return {
    ...(await viaCompanyScope(userId)),
    ...(params?.status ? { status: params.status } : {}),
    ...(params?.priority ? { priority: params.priority } : {}),
    ...(params?.ticketType ? { ticketType: params.ticketType } : {}),
    ...(params?.companyId ? { companyId: params.companyId } : {}),
    ...(params?.assignedToUserId
      ? params.assignedToUserId === "unassigned"
        ? { assignedToUserId: null }
        : { assignedToUserId: params.assignedToUserId }
      : {}),
    ...(params?.search
      ? {
          OR: [
            { title: { contains: params.search, mode: "insensitive" as const } },
            { company: { name: { contains: params.search, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };
}

const ticketListInclude = {
  company: { select: { id: true, name: true, companySeq: true } },
  contact: { select: { id: true, name: true } },
  companyProduct: { select: { id: true, orderSeq: true } },
  assignedTo: { select: { id: true, name: true } },
} as const;

export async function listTickets(params?: TicketListParams) {
  const user = await requireModuleUser("helpdesk");
  if (!(await viewerHas("tickets.view"))) return [];
  return db.ticket.findMany({
    where: await ticketListWhere(user.id, params),
    orderBy: { updatedAt: "desc" },
    include: ticketListInclude,
  });
}

export async function listTicketsPaged(params: TicketListParams & { page: number; pageSize: number }) {
  const user = await requireModuleUser("helpdesk");
  if (!(await viewerHas("tickets.view"))) return { rows: [], total: 0 };
  const where = await ticketListWhere(user.id, params);
  const [rows, total] = await Promise.all([
    db.ticket.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      include: ticketListInclude,
      ...pageSlice(params.page, params.pageSize),
    }),
    db.ticket.count({ where }),
  ]);
  return { rows, total };
}

/**
 * `findFirst` rather than `findUnique` so the scope can sit in the same `where` as the id: a ticket
 * on somebody else's account is missing rather than refused, which is the same answer as for an id
 * that never existed and so cannot be used to probe which accounts are real. The detail page
 * already renders `notFound()` for `null`.
 */
export async function getTicket(id: string) {
  const user = await requireModuleUser("helpdesk");
  if (!(await viewerHas("tickets.view"))) return null;
  return db.ticket.findFirst({
    where: { id, ...(await viaCompanyScope(user.id)) },
    include: {
      company: { select: { id: true, name: true, companySeq: true, customerCategory: { select: CATEGORY_SELECT } } },
      contact: { select: { id: true, name: true, email: true, phone: true, designation: true } },
      companyProduct: { select: { id: true, orderSeq: true, item: { select: { name: true } } } },
      assignedTo: { select: { id: true, name: true } },
      createdBy: { select: { id: true, name: true } },
      comments: { orderBy: { createdAt: "asc" }, include: { user: { select: { id: true, name: true } } } },
    },
  });
}

export async function updateTicketStatus(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("helpdesk");
  const parsed = updateTicketStatusSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { ticketId, status } = parsed.data;

  const ticket = await db.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) {
    return { ok: false, error: "Ticket not found." };
  }

  const isResolved = status === "RESOLVED" || status === "CLOSED";
  const isClosed = status === "CLOSED";

  await db.ticket.update({
    where: { id: ticketId },
    data: {
      status,
      resolvedAt: isResolved ? (ticket.resolvedAt ?? new Date()) : null,
      closedAt: isClosed ? (ticket.closedAt ?? new Date()) : null,
    },
  });

  if (ticket.assignedToUserId && ticket.assignedToUserId !== user.id) {
    await notifyUser({
      userId: ticket.assignedToUserId,
      type: "TICKET_STATUS_CHANGED",
      title: "Your ticket's status changed",
      message: `${formatTicketId(ticket.ticketSeq)} — now ${status.replaceAll("_", " ")}`,
      link: ticketPath(ticket.ticketSeq),
    });
  }

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Ticket",
    entityId: ticketId,
    entityLabel: `${formatTicketId(ticket.ticketSeq)} — ${ticket.title}`,
  });

  revalidatePath("/tickets");
  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath(`/companies/${ticket.companyId}`);
  return { ok: true, data: { id: ticketId } };
}

export async function updateTicketPriority(input: unknown): Promise<ActionResult<{ id: string }>> {
  await requireModuleUser("helpdesk");
  const parsed = updateTicketPrioritySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { ticketId, priority } = parsed.data;

  const ticket = await db.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) {
    return { ok: false, error: "Ticket not found." };
  }

  await db.ticket.update({ where: { id: ticketId }, data: { priority } });

  revalidatePath("/tickets");
  revalidatePath(`/tickets/${ticketId}`);
  return { ok: true, data: { id: ticketId } };
}

export async function assignTicket(input: unknown): Promise<ActionResult<{ id: string }>> {
  const actor = await requireModuleUser("helpdesk");
  const parsed = assignTicketSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { ticketId, userId } = parsed.data;

  const ticket = await db.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) {
    return { ok: false, error: "Ticket not found." };
  }
  if (userId && !(await isSupportAgent(userId))) {
    return { ok: false, error: "Tickets can only be assigned to someone in the Tech Support department." };
  }

  await db.ticket.update({ where: { id: ticketId }, data: { assignedToUserId: userId || null } });

  if (userId && userId !== actor.id) {
    await notifyUser({
      userId,
      type: "TICKET_ASSIGNED",
      title: "A ticket was assigned to you",
      message: `${formatTicketId(ticket.ticketSeq)} — ${ticket.title}`,
      link: ticketPath(ticket.ticketSeq),
    });
  }

  revalidatePath("/tickets");
  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath(`/companies/${ticket.companyId}`);
  return { ok: true, data: { id: ticketId } };
}

export async function addTicketComment(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("helpdesk");
  const parsed = addTicketCommentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { ticketId, body } = parsed.data;

  const ticket = await db.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) {
    return { ok: false, error: "Ticket not found." };
  }

  const comment = await db.ticketComment.create({ data: { ticketId, userId: user.id, body } });

  if (ticket.assignedToUserId && ticket.assignedToUserId !== user.id) {
    await notifyUser({
      userId: ticket.assignedToUserId,
      type: "TICKET_COMMENT",
      title: "New comment on your ticket",
      message: `${formatTicketId(ticket.ticketSeq)} — ${body}`,
      link: ticketPath(ticket.ticketSeq),
    });
  }

  revalidatePath(`/tickets/${ticketId}`);
  return { ok: true, data: { id: comment.id } };
}

export async function deleteTicket(id: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("helpdesk");
  if (!(await hasEffectivePermission(user.id, "tickets.delete"))) {
    return { ok: false, error: "You don't have permission to delete tickets." };
  }
  const ticket = await db.ticket.findUnique({ where: { id } });
  if (!ticket) {
    return { ok: false, error: "Ticket not found." };
  }

  await db.ticket.delete({ where: { id } });

  revalidatePath("/tickets");
  revalidatePath(`/companies/${ticket.companyId}`);
  return { ok: true, data: null };
}

/**
 * Bulk edits from the ticket list's selection bar. Each change goes through the single-ticket
 * action rather than an `updateMany`: status, priority and assignment each notify someone and
 * write an audit entry, and a bulk path that skipped those would leave the helpdesk's history
 * depending on how the change happened to be made.
 */
export async function bulkUpdateTickets(input: unknown): Promise<ActionResult<{ count: number }>> {
  await requireModuleUser("helpdesk");
  const parsed = bulkUpdateTicketsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { ticketIds, assignedToUserId, status, priority } = parsed.data;
  if (!assignedToUserId && !status && !priority) {
    return { ok: false, error: "Pick an agent, status or priority to apply." };
  }

  for (const ticketId of ticketIds) {
    if (assignedToUserId) {
      const result = await assignTicket({
        ticketId,
        assignedToUserId: assignedToUserId === "unassign" ? "" : assignedToUserId,
      });
      if (!result.ok) return { ok: false, error: result.error };
    }
    if (status) {
      const result = await updateTicketStatus({ ticketId, status });
      if (!result.ok) return { ok: false, error: result.error };
    }
    if (priority) {
      const result = await updateTicketPriority({ ticketId, priority });
      if (!result.ok) return { ok: false, error: result.error };
    }
  }

  revalidatePath("/tickets");
  return { ok: true, data: { count: ticketIds.length } };
}

/** Open tickets across the whole filtered set, so the header count doesn't shrink as you page. */
export async function countOpenTickets(params?: TicketListParams) {
  const user = await requireModuleUser("helpdesk");
  if (!(await viewerHas("tickets.view"))) return 0;
  return db.ticket.count({
    // Scoped through the same `where` as the list it sits above, or the header would count
    // tickets the rows beneath it no longer show.
    where: { ...(await ticketListWhere(user.id, params)), status: { notIn: ["RESOLVED", "CLOSED"] } },
  });
}

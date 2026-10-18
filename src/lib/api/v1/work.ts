import { createTask, listTasksPaged, setTaskStatus, updateTask } from "@/actions/task";
import { getTaskPanel } from "@/actions/task-extras";
import { addTicketComment, assignTicket, createTicket, getTicket, listTicketsPaged, updateTicketPriority, updateTicketStatus } from "@/actions/ticket";
import { ApiError, notFound, pageOf, paging, refusedBy, type ApiAnswer, type ApiCall } from "@/lib/api/handler";
import { taskCreateSchema, taskPatchSchema, ticketCommentSchema, ticketCreateSchema, ticketPatchSchema } from "@/lib/api/v1/schemas";
import { needModule } from "@/lib/api/v1/shared";
import { companyRef, contactRef, day, idOf, iso, leadRef, orderRef, personId, plainId, ticketRef } from "@/lib/api/refs";
import { API_DEFAULT_PAGE_SIZE, API_MAX_PAGE_SIZE } from "@/lib/api/scopes";
import { ticketPriorityValues, ticketStatusValues } from "@/lib/validation/ticket";

/**
 * Tasks and tickets in the public API (src/lib/api) — through the app's own task and helpdesk actions
 * as the key's person: who may see, work, change or reassign each, the given-task rule, the support
 * agent rule and the word filter apply as on the screens.
 */

type Row = Record<string, unknown> & { id: string };
const str = (v: unknown) => (typeof v === "string" ? v : null);
const rec = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : null);
const person = (v: unknown) => {
  const p = rec(v);
  return p ? { id: p.id, name: p.name } : null;
};
const ref = (v: unknown, make: (seq: number) => string | null, seqKey: string, label = "name") => {
  const r = rec(v);
  return r ? { id: r.id, ref: make(r[seqKey] as number), [label]: r[label] ?? null } : null;
};

// ─── Tasks ──────────────────────────────────────────────────────────────────────────────────────

function taskOut(row: Row, detail = false) {
  const team = rec(row.department);
  return {
    id: row.id,
    title: row.title,
    description: str(row.description),
    status: row.status ?? null,
    priority: row.priority ?? null,
    done: row.done === true,
    done_at: iso(row.doneAt as Date | null),
    due_date: day(row.dueDate as Date | null),
    start_date: day(row.startDate as Date | null),
    estimate_minutes: typeof row.estimateMinutes === "number" ? row.estimateMinutes : null,
    assignee: person(row.assignedTo),
    set_by: person(row.createdBy),
    team: team ? { id: team.id, name: team.name } : null,
    about: {
      company: ref(row.company, companyRef, "companySeq"),
      lead: ref(row.lead, leadRef, "leadSeq", "title"),
      ticket: ref(row.ticket, ticketRef, "ticketSeq", "title"),
    },
    ...(detail && Array.isArray(row.checklist) ? { checklist: (row.checklist as Row[]).map((s) => ({ id: s.id, title: s.title, done: s.done === true })) } : {}),
    created_at: iso(row.createdAt as Date | string),
    updated_at: iso(row.updatedAt as Date | string),
  };
}

async function readTask(id: string) {
  const task = (await getTaskPanel(id)) as Row | null;
  if (!task) throw notFound("task");
  return taskOut(task, true);
}

export async function listTasksApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("tasks", call.actor.userId, "Tasks");
  const q = call.url.searchParams;
  const { page, pageSize } = paging(call.url, API_MAX_PAGE_SIZE, API_DEFAULT_PAGE_SIZE);
  const status = q.get("status")?.toLowerCase();
  if (status && !["upcoming", "todo", "in_progress", "done", "cancelled", "open"].includes(status)) throw new ApiError(400, "invalid_request", "status is one of upcoming, todo, in_progress, done, cancelled, open.");
  const assignee = q.get("assignee");
  const { rows, total } = await listTasksPaged({
    page,
    pageSize,
    status: status || undefined,
    search: q.get("search")?.slice(0, 100) || undefined,
    assignedToUserId: assignee ? ((await personId(assignee)) ?? "zz-nobody") : undefined,
    dueFrom: q.get("due_from") || undefined,
    dueTo: q.get("due_to") || undefined,
  });
  return { data: (rows as unknown as Row[]).map((r) => taskOut(r)), page: pageOf(page, pageSize, total) };
}

export async function getTaskApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("tasks", call.actor.userId, "Tasks");
  const id = plainId(call.params.id);
  if (!id) throw notFound("task");
  return { data: await readTask(id) };
}

async function assigneeOf(value: string | undefined): Promise<string | undefined> {
  if (value === undefined) return undefined;
  const id = await personId(value);
  if (!id) throw new ApiError(422, "refused", "No active person by that id or email.", { assignee: "Not found." });
  return id;
}

/** What a task is about, by ref — each found, or the request refused naming the field. */
async function aboutOf(input: { company?: string; lead?: string; ticket?: string }) {
  const out: { companyId?: string; leadId?: string; ticketId?: string } = {};
  for (const [field, kind, key] of [["company", "company", "companyId"], ["lead", "lead", "leadId"], ["ticket", "ticket", "ticketId"]] as const) {
    const value = input[field];
    if (!value) continue;
    const id = await idOf(kind, value);
    if (!id) throw new ApiError(422, "refused", `No ${field} by that reference.`, { [field]: "Not found." });
    out[key] = id;
  }
  return out;
}

export async function createTaskApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("tasks", call.actor.userId, "Tasks");
  const input = taskCreateSchema.parse(await call.body());
  const about = await aboutOf(input);
  const made = await createTask({
    title: input.title,
    description: input.description ?? "",
    dueDate: input.due_date ?? "",
    assignedToUserId: (await assigneeOf(input.assignee)) ?? call.actor.userId,
    ...about,
    ...(input.status ? { status: input.status } : {}),
    ...(input.priority ? { priority: input.priority } : {}),
    ...(input.checklist ? { steps: input.checklist } : {}),
  });
  if (!made.ok) throw refusedBy(made);
  return { status: 201, data: await readTask(made.data.id) };
}

export async function patchTaskApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("tasks", call.actor.userId, "Tasks");
  const id = plainId(call.params.id);
  if (!id) throw notFound("task");
  const input = taskPatchSchema.parse(await call.body());
  const now = (await getTaskPanel(id)) as Row | null;
  if (!now) throw notFound("task");
  // The status moves as the person working it moves it — whoever it's given to may, whatever else they may change.
  if (input.status) {
    const moved = await setTaskStatus(id, input.status);
    if (!moved.ok) throw refusedBy(moved);
  }
  const rest = { ...input };
  delete rest.status;
  if (Object.keys(rest).length) {
    const done = await updateTask({
      id,
      title: input.title ?? String(now.title),
      description: input.description ?? str(now.description) ?? "",
      dueDate: input.due_date ?? day(now.dueDate as Date | null) ?? "",
      assignedToUserId: (await assigneeOf(input.assignee)) ?? str(now.assignedToUserId) ?? "",
      ...(input.priority ? { priority: input.priority } : {}),
    });
    if (!done.ok) throw refusedBy(done);
  }
  return { data: await readTask(id) };
}

// ─── Tickets ────────────────────────────────────────────────────────────────────────────────────

function ticketOut(row: Row, detail = false) {
  const order = rec(row.companyProduct);
  return {
    id: row.id,
    ref: ticketRef(row.ticketSeq as number),
    title: row.title,
    description: str(row.description),
    status: row.status,
    priority: row.priority,
    type: row.ticketType ?? null,
    company: ref(row.company, companyRef, "companySeq"),
    contact: rec(row.contact) ? { id: rec(row.contact)!.id, ref: contactRef(rec(row.contact)!.contactSeq as number), name: rec(row.contact)!.name } : null,
    order: order ? { id: order.id, ref: orderRef(order.orderSeq as number) } : null,
    assignee: person(row.assignedTo),
    ...(detail
      ? {
          opened_by: person(row.createdBy),
          comments: Array.isArray(row.comments) ? (row.comments as Row[]).map((c) => ({ id: c.id, body: c.body, by: person(c.user), created_at: iso(c.createdAt as Date) })) : [],
        }
      : {}),
    resolved_at: iso(row.resolvedAt as Date | null),
    created_at: iso(row.createdAt as Date | string),
    updated_at: iso(row.updatedAt as Date | string),
  };
}

async function readTicket(id: string) {
  const ticket = (await getTicket(id)) as Row | null;
  if (!ticket) throw notFound("ticket");
  return ticketOut(ticket, true);
}

export async function listTicketsApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("helpdesk", call.actor.userId, "Helpdesk");
  const q = call.url.searchParams;
  const { page, pageSize } = paging(call.url, API_MAX_PAGE_SIZE, API_DEFAULT_PAGE_SIZE);
  const status = q.get("status")?.toUpperCase();
  const priority = q.get("priority")?.toUpperCase();
  if (status && !(ticketStatusValues as readonly string[]).includes(status)) throw new ApiError(400, "invalid_request", `status is one of ${ticketStatusValues.join(", ")}.`);
  if (priority && !(ticketPriorityValues as readonly string[]).includes(priority)) throw new ApiError(400, "invalid_request", `priority is one of ${ticketPriorityValues.join(", ")}.`);
  const company = q.get("company");
  const assignee = q.get("assignee");
  const { rows, total } = await listTicketsPaged({
    page,
    pageSize,
    status: status as (typeof ticketStatusValues)[number] | undefined,
    priority: priority as (typeof ticketPriorityValues)[number] | undefined,
    search: q.get("search")?.slice(0, 100) || undefined,
    companyId: company ? ((await idOf("company", company)) ?? "zz-nothing") : undefined,
    assignedToUserId: assignee ? ((await personId(assignee)) ?? "zz-nobody") : undefined,
  });
  return { data: (rows as unknown as Row[]).map((r) => ticketOut(r)), page: pageOf(page, pageSize, total) };
}

export async function getTicketApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("helpdesk", call.actor.userId, "Helpdesk");
  const id = await idOf("ticket", call.params.ref);
  if (!id) throw notFound("ticket");
  return { data: await readTicket(id) };
}

export async function createTicketApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("helpdesk", call.actor.userId, "Helpdesk");
  const input = ticketCreateSchema.parse(await call.body());
  const companyId = await idOf("company", input.company);
  if (!companyId) throw new ApiError(422, "refused", "No company by that reference reaches this key.", { company: "Not found." });
  const contactId = input.contact ? await idOf("contact", input.contact) : null;
  if (input.contact && !contactId) throw new ApiError(422, "refused", "No contact by that reference.", { contact: "Not found." });
  const orderId = input.order ? await idOf("order", input.order) : null;
  if (input.order && !orderId) throw new ApiError(422, "refused", "No order by that reference.", { order: "Not found." });
  const made = await createTicket({
    companyId,
    contactId: contactId ?? "",
    companyProductId: orderId ?? "",
    title: input.title,
    description: input.description ?? "",
    ticketType: input.type ?? "PRODUCT_SUPPORT",
    priority: input.priority ?? "MEDIUM",
    assignedToUserId: (await assigneeOf(input.assignee)) ?? "",
  });
  if (!made.ok) throw refusedBy(made);
  return { status: 201, data: await readTicket(made.data.id) };
}

export async function patchTicketApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("helpdesk", call.actor.userId, "Helpdesk");
  const id = await idOf("ticket", call.params.ref);
  if (!id) throw notFound("ticket");
  const input = ticketPatchSchema.parse(await call.body());
  if (!(await getTicket(id))) throw notFound("ticket");
  if (input.status) {
    const done = await updateTicketStatus({ ticketId: id, status: input.status });
    if (!done.ok) throw refusedBy(done);
  }
  if (input.priority) {
    const done = await updateTicketPriority({ ticketId: id, priority: input.priority });
    if (!done.ok) throw refusedBy(done);
  }
  if (input.assignee !== undefined) {
    const done = await assignTicket({ ticketId: id, userId: input.assignee === "" ? "" : await assigneeOf(input.assignee) });
    if (!done.ok) throw refusedBy(done);
  }
  return { data: await readTicket(id) };
}

export async function commentTicketApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("helpdesk", call.actor.userId, "Helpdesk");
  const id = await idOf("ticket", call.params.ref);
  if (!id) throw notFound("ticket");
  const input = ticketCommentSchema.parse(await call.body());
  const done = await addTicketComment({ ticketId: id, body: input.body });
  if (!done.ok) throw refusedBy(done);
  return { status: 201, data: { id: done.data.id, ticket: (await readTicket(id)).ref, body: input.body } };
}

"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { dateRangeFilter } from "@/lib/utils";
import { pageSlice } from "@/lib/pagination";
import { notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { createTaskSchema, updateTaskSchema } from "@/lib/validation/task";
import type { ActionResult } from "@/actions/company";

function revalidateTaskPaths(task: { companyId: string | null; leadId: string | null; ticketId: string | null }) {
  revalidatePath("/tasks");
  if (task.companyId) revalidatePath(`/companies/${task.companyId}`);
  if (task.leadId) revalidatePath(`/leads/${task.leadId}`);
  if (task.ticketId) revalidatePath(`/tickets/${task.ticketId}`);
}

async function assertValidAssignee(userId: string) {
  const assignee = await db.user.findUnique({ where: { id: userId } });
  return !!assignee && assignee.active;
}

export async function createTask(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("tasks");
  const parsed = createTaskSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  if (data.assignedToUserId && !(await assertValidAssignee(data.assignedToUserId))) {
    return { ok: false, error: "That person is not a valid, active user." };
  }

  const task = await db.task.create({
    data: {
      title: data.title,
      description: data.description || null,
      dueDate: data.dueDate ? new Date(data.dueDate) : null,
      assignedToUserId: data.assignedToUserId || null,
      createdByUserId: user.id,
      companyId: data.companyId || null,
      leadId: data.leadId || null,
      ticketId: data.ticketId || null,
    },
  });

  if (data.assignedToUserId && data.assignedToUserId !== user.id) {
    await notifyUser({
      userId: data.assignedToUserId,
      type: "TASK_ASSIGNED",
      title: "A task was assigned to you",
      message: data.title,
      link: "/tasks",
    });
  }

  await recordAudit({ userId: user.id, action: "CREATE", entityType: "Task", entityId: task.id, entityLabel: data.title });

  revalidateTaskPaths(task);
  return { ok: true, data: { id: task.id } };
}

export async function updateTask(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("tasks");
  const parsed = updateTaskSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  const existing = await db.task.findUnique({ where: { id: data.id } });
  if (!existing) {
    return { ok: false, error: "Task not found." };
  }
  if (data.assignedToUserId && !(await assertValidAssignee(data.assignedToUserId))) {
    return { ok: false, error: "That person is not a valid, active user." };
  }

  const newAssignee = data.assignedToUserId || null;
  const task = await db.task.update({
    where: { id: data.id },
    data: {
      title: data.title,
      description: data.description || null,
      dueDate: data.dueDate ? new Date(data.dueDate) : null,
      assignedToUserId: newAssignee,
    },
  });

  if (newAssignee && newAssignee !== existing.assignedToUserId && newAssignee !== user.id) {
    await notifyUser({
      userId: newAssignee,
      type: "TASK_ASSIGNED",
      title: "A task was assigned to you",
      message: data.title,
      link: "/tasks",
    });
  }

  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Task", entityId: task.id, entityLabel: data.title });

  revalidateTaskPaths(task);
  return { ok: true, data: { id: task.id } };
}

export async function toggleTaskDone(id: string): Promise<ActionResult<null>> {
  await requireModuleUser("tasks");
  const task = await db.task.findUnique({ where: { id } });
  if (!task) {
    return { ok: false, error: "Task not found." };
  }
  const done = !task.done;
  await db.$transaction(async (tx) => {
    await tx.task.update({ where: { id }, data: { done, doneAt: done ? new Date() : null } });
    const call = await tx.callLog.findUnique({ where: { followUpTaskId: id }, select: { id: true } });
    if (call) await tx.callLog.update({ where: { id: call.id }, data: { followUpDone: done } });
  });
  revalidateTaskPaths(task);
  revalidatePath("/calls");
  return { ok: true, data: null };
}

export async function deleteTask(id: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("tasks");
  const task = await db.task.findUnique({ where: { id } });
  if (!task) {
    return { ok: false, error: "Task not found." };
  }
  const isOwnTask = task.createdByUserId === user.id || task.assignedToUserId === user.id;
  if (!isOwnTask && !(await hasEffectivePermission(user.id, "tasks.delete"))) {
    return { ok: false, error: "You don't have permission to delete this task." };
  }

  await db.task.delete({ where: { id } });
  revalidateTaskPaths(task);
  return { ok: true, data: null };
}

type TaskListParams = {
  assignedToUserId?: string;
  done?: boolean;
  search?: string;
  dueFrom?: string;
  dueTo?: string;
  companyId?: string;
  leadId?: string;
  ticketId?: string;
};

function taskListWhere(params?: TaskListParams): Prisma.TaskWhereInput {
  const dueDate = dateRangeFilter(params?.dueFrom, params?.dueTo);
  return {
    ...(params?.assignedToUserId
      ? params.assignedToUserId === "unassigned"
        ? { assignedToUserId: null }
        : { assignedToUserId: params.assignedToUserId }
      : {}),
    ...(params?.done !== undefined ? { done: params.done } : {}),
    ...(params?.search ? { title: { contains: params.search, mode: "insensitive" as const } } : {}),
    ...(dueDate ? { dueDate } : {}),
    ...(params?.companyId ? { companyId: params.companyId } : {}),
    ...(params?.leadId ? { leadId: params.leadId } : {}),
    ...(params?.ticketId ? { ticketId: params.ticketId } : {}),
  };
}

const taskListInclude = {
  assignedTo: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  company: { select: { id: true, name: true } },
  lead: { select: { id: true, title: true } },
  ticket: { select: { id: true, ticketSeq: true, title: true } },
} as const;

export type RailTask = {
  id: string;
  title: string;
  dueDate: Date | null;
  companyName: string | null;
  /** Decided here rather than in the panel, which renders on the client and must not read the clock. */
  overdue: boolean;
};

/**
 * The short list for the side rail: open tasks assigned to whoever is asking, soonest first.
 *
 * Its own action rather than `listTasks` with parameters, because it answers a different
 * question and should keep answering it if the list page's defaults change. Capped, because the
 * panel is a reminder and not a backlog — somebody with two hundred open tasks needs the page.
 */
export async function myOpenTasks(): Promise<RailTask[]> {
  const user = await requireModuleUser("tasks");
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const rows = await db.task.findMany({
    where: { assignedToUserId: user.id, done: false },
    // Undated ones last: a task with a date is a commitment and one without is an intention.
    orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
    take: 15,
    select: { id: true, title: true, dueDate: true, company: { select: { name: true } } },
  });

  return rows.map((t) => ({
    id: t.id,
    title: t.title,
    dueDate: t.dueDate,
    companyName: t.company?.name ?? null,
    overdue: t.dueDate !== null && t.dueDate < startOfToday,
  }));
}

export async function listTasks(params?: TaskListParams) {
  await requireModuleUser("tasks");
  return db.task.findMany({
    where: taskListWhere(params),
    orderBy: [{ done: "asc" }, { dueDate: "asc" }],
    include: taskListInclude,
  });
}

export async function listTasksPaged(params: TaskListParams & { page: number; pageSize: number }) {
  await requireModuleUser("tasks");
  const where = taskListWhere(params);
  const [rows, total] = await Promise.all([
    db.task.findMany({
      where,
      orderBy: [{ done: "asc" }, { dueDate: "asc" }],
      include: taskListInclude,
      ...pageSlice(params.page, params.pageSize),
    }),
    db.task.count({ where }),
  ]);
  return { rows, total };
}

/** Open and overdue counts across the whole filtered set, so the header holds steady while paging. */
export async function countTasks(params?: TaskListParams) {
  await requireModuleUser("tasks");
  const where = taskListWhere(params);
  const [open, overdue] = await Promise.all([
    db.task.count({ where: { ...where, done: false } }),
    db.task.count({ where: { ...where, done: false, dueDate: { lt: new Date() } } }),
  ]);
  return { open, overdue };
}

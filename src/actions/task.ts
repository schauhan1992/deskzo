"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { emitTask } from "@/lib/automate/emit-records";
import { leadsSeenBy } from "@/lib/leads/shown";
import { requireModuleUser } from "@/lib/modules-access";
import { companyAccess, leadAccess, taskAccess, ticketAccess, type AccessAction } from "@/lib/authz/access";
import { pageSlice } from "@/lib/pagination";
import { notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { createTaskSchema, updateTaskSchema } from "@/lib/validation/task";
import { workspaceClock } from "@/lib/time/workspace";
import { calendarDayRange } from "@/lib/time/zone";
import { ADVANCED, givenToWork, moveTask, taskRights, workableTask } from "@/lib/tasks/server";
import { ONLY_WORKS, TASK_STATUSES, type TaskPriorityKey, type TaskRepeatKey, type TaskSort, type TaskStatusKey } from "@/lib/tasks/rules";
import type { ActionResult } from "@/actions/company";

function revalidateTaskPaths(task: { companyId: string | null; leadId: string | null; ticketId: string | null }) {
  revalidatePath("/tasks");
  if (task.companyId) revalidatePath(`/companies/${task.companyId}`);
  if (task.leadId) revalidatePath(`/leads/${task.leadId}`);
  if (task.ticketId) revalidatePath(`/tickets/${task.ticketId}`);
}

/**
 * The task, when this person may act on it this way — the task rule (src/lib/authz/access.ts, "tasks"):
 * everybody's to see, change and hand on, and deleting one that isn't yours needs "Delete any task",
 * until a role sets levels of its own. A task out of reach is missing, as one that never existed.
 */
async function reachableTask(userId: string, id: string, action: AccessAction) {
  return db.task.findFirst({ where: { AND: [{ id }, await taskAccess(userId, action)] }, omit: ADVANCED });
}

/**
 * What a task is about — one company, lead or ticket — when this person can see it (owner, 17 Oct 2026:
 * the form picks it now, so it's checked rather than taken on trust from the record page that used to
 * be the only way in). A lead or ticket brings its company with it, as a task made on its page has.
 */
async function aboutLink(userId: string, about: { companyId?: string; leadId?: string; ticketId?: string }): Promise<{ ok: true; link: { companyId: string | null; leadId: string | null; ticketId: string | null } } | { ok: false; error: string }> {
  const none = { companyId: null, leadId: null, ticketId: null };
  const refused = { ok: false as const, error: "That record isn't one you can see." };
  if (about.ticketId) {
    const ticket = await db.ticket.findFirst({ where: { AND: [{ id: about.ticketId }, await ticketAccess(userId, "view")] }, select: { id: true, companyId: true } });
    return ticket ? { ok: true, link: { ...none, ticketId: ticket.id, companyId: ticket.companyId } } : refused;
  }
  if (about.leadId) {
    const lead = await db.lead.findFirst({ where: { AND: [{ id: about.leadId }, await leadAccess(userId, "view")] }, select: { id: true, companyId: true } });
    return lead ? { ok: true, link: { ...none, leadId: lead.id, companyId: lead.companyId } } : refused;
  }
  if (about.companyId) {
    const company = await db.company.findFirst({ where: { AND: [{ id: about.companyId }, await companyAccess(userId, "view")] }, select: { id: true } });
    return company ? { ok: true, link: { ...none, companyId: company.id } } : refused;
  }
  return { ok: true, link: none };
}

async function assertValidAssignee(userId: string) {
  const assignee = await db.user.findUnique({ where: { id: userId } });
  return !!assignee && assignee.active;
}

/**
 * A due date is a calendar day, held as a `@db.Date` would hold it — UTC midnight of the day picked —
 * so it reads back as that day in every zone (formatCalendarDay). A callback's is the moment promised
 * (src/actions/call.ts), which falls inside its own day. Null for a day that isn't one.
 */
function dueDateFrom(day: string | undefined): Date | null {
  return day ? (calendarDayRange(day, null)?.gte ?? null) : null;
}

/** Due From and To as calendar days, the To day whole — a callback promised for 4 pm on it is in. */
function dueDayRange(from?: string, to?: string): { gte?: Date; lt?: Date } | null {
  const days = calendarDayRange(from, to);
  if (!days) return null;
  return { ...(days.gte ? { gte: days.gte } : {}), ...(days.lte ? { lt: new Date(days.lte.getTime() + 86_400_000) } : {}) };
}

/** What the fields shared by create and update come to — or why they can't be kept. */
type Advanced = {
  priority?: TaskPriorityKey;
  startDate?: Date | null;
  estimateMinutes?: number | null;
  departmentId?: string | null;
  challengeId?: string | null;
  xp?: number;
  badge?: string | null;
  repeat?: TaskRepeatKey | null;
  repeatUntil?: Date | null;
};
async function advancedOf(data: {
  priority?: string;
  startDate?: string;
  estimateMinutes?: number | null;
  departmentId?: string;
  challengeId?: string;
  xp?: number;
  badge?: string;
  repeat?: string;
  repeatUntil?: string;
}): Promise<{ ok: true; fields: Advanced } | { ok: false; error: string }> {
  const fields: Advanced = {};
  if (data.priority !== undefined) fields.priority = data.priority as TaskPriorityKey;
  if (data.startDate !== undefined) {
    fields.startDate = dueDateFrom(data.startDate);
    if (data.startDate && !fields.startDate) return { ok: false, error: "That start date isn't a date." };
  }
  if (data.estimateMinutes !== undefined) fields.estimateMinutes = data.estimateMinutes || null;
  if (data.departmentId !== undefined) {
    if (data.departmentId && !(await db.department.count({ where: { id: data.departmentId } }))) return { ok: false, error: "That team no longer exists." };
    fields.departmentId = data.departmentId || null;
  }
  if (data.challengeId !== undefined) {
    if (data.challengeId && !(await db.taskChallenge.count({ where: { id: data.challengeId, archivedAt: null } }))) {
      return { ok: false, error: "That challenge has been archived or no longer exists." };
    }
    fields.challengeId = data.challengeId || null;
  }
  if (data.xp !== undefined) fields.xp = data.xp;
  if (data.badge !== undefined) fields.badge = data.badge || null;
  if (data.repeat !== undefined) fields.repeat = (data.repeat || null) as TaskRepeatKey | null;
  if (data.repeatUntil !== undefined) {
    fields.repeatUntil = dueDateFrom(data.repeatUntil);
    if (data.repeatUntil && !fields.repeatUntil) return { ok: false, error: "That repeat-until date isn't a date." };
  }
  return { ok: true, fields };
}

/** Nobody sets what their own task is worth: XP counts only when somebody else put it there. */
const OWN_XP = "You can't set the XP on a task that's yours — somebody else decides what your tasks are worth.";

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
  const dueDate = dueDateFrom(data.dueDate);
  if (data.dueDate && !dueDate) return { ok: false, error: "That due date isn't a date." };
  const advanced = await advancedOf(data);
  if (!advanced.ok) return advanced;
  const fields = advanced.fields;
  if (fields.startDate && dueDate && fields.startDate > dueDate) return { ok: false, error: "A task can't start after it's due." };
  // Unassigned is fine: whoever later gets it earns it, unless that is whoever set it (moveTask).
  if ((fields.xp ?? 0) > 0 && data.assignedToUserId === user.id) return { ok: false, error: OWN_XP };
  // A new task is to do or already under way; it's closed by moving it, which is what earns and repeats.
  const status = data.status === "IN_PROGRESS" ? "IN_PROGRESS" : "TODO";
  const about = await aboutLink(user.id, { companyId: data.companyId || undefined, leadId: data.leadId || undefined, ticketId: data.ticketId || undefined });
  if (!about.ok) return about;
  // A reminder for whoever makes it — read in the workspace's time, and still to come.
  const remindAt = data.remindAt ? (await workspaceClock()).parseTyped(data.remindAt) : null;
  if (data.remindAt && !remindAt) return { ok: false, error: "That reminder time isn't a time." };
  if (remindAt && remindAt.getTime() <= Date.now()) return { ok: false, error: "Set the reminder for a time still to come." };

  const task = await db.$transaction(async (tx) => {
    const made = await tx.task.create({
      data: {
        title: data.title,
        description: data.description || null,
        dueDate,
        assignedToUserId: data.assignedToUserId || null,
        createdByUserId: user.id,
        ...about.link,
        status,
        ...fields,
        ...((fields.xp ?? 0) > 0 ? { xpSetById: user.id } : {}),
      },
      select: { id: true, companyId: true, leadId: true, ticketId: true },
    });
    // For Automate's workflows (src/lib/automate), with the task.
    await emitTask(tx, "task.created", made.id, user.id);
    return made;
  });
  // Its checklist, typed with it — in the order typed.
  const steps = (data.steps ?? []).filter(Boolean);
  if (steps.length) await db.taskChecklistItem.createMany({ data: steps.map((title, sortOrder) => ({ taskId: task.id, title, sortOrder })) });
  if (remindAt) await db.taskReminder.create({ data: { taskId: task.id, userId: user.id, nextAt: remindAt, repeat: data.remindRepeat ?? "ONCE" } });

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

  const existing = await reachableTask(user.id, data.id, "edit");
  if (!existing) {
    return { ok: false, error: "Task not found." };
  }
  // Given to them by somebody else: they move it along (setTaskStatus), they don't rewrite it.
  if (await givenToWork(user.id, existing)) return { ok: false, error: ONLY_WORKS };
  // Handing it to somebody else is assigning, and asks for that.
  if ((data.assignedToUserId || null) !== existing.assignedToUserId && !(await reachableTask(user.id, data.id, "assign"))) {
    return { ok: false, error: "You can't hand this task to somebody else." };
  }
  if (data.assignedToUserId && !(await assertValidAssignee(data.assignedToUserId))) {
    return { ok: false, error: "That person is not a valid, active user." };
  }
  const dueDate = dueDateFrom(data.dueDate);
  if (data.dueDate && !dueDate) return { ok: false, error: "That due date isn't a date." };
  const advanced = await advancedOf(data);
  if (!advanced.ok) return advanced;
  const fields = advanced.fields;
  const startDate = fields.startDate !== undefined ? fields.startDate : existing.startDate;
  if (startDate && dueDate && startDate > dueDate) return { ok: false, error: "A task can't start after it's due." };

  const newAssignee = data.assignedToUserId || null;
  // Changing what it's worth is setting its XP — never by whoever it's for.
  const xpChanges = fields.xp !== undefined && fields.xp !== existing.xp;
  if (xpChanges && newAssignee === user.id && (fields.xp ?? 0) > 0) return { ok: false, error: OWN_XP };
  // What it's about, where the form sent it: checked like a new task's; left out, left as it was.
  const about = data.about ? await aboutLink(user.id, { companyId: data.about.companyId || undefined, leadId: data.about.leadId || undefined, ticketId: data.about.ticketId || undefined }) : null;
  if (about && !about.ok) return about;

  const task = await db.task.update({
    where: { id: data.id },
    data: {
      title: data.title,
      description: data.description || null,
      dueDate,
      assignedToUserId: newAssignee,
      ...(about?.ok ? about.link : {}),
      ...fields,
      ...(xpChanges ? { xpSetById: (fields.xp ?? 0) > 0 ? user.id : null } : {}),
    },
    select: { id: true, companyId: true, leadId: true, ticketId: true },
  });
  // A status sent with the edit is a move: it earns, takes back and repeats as the status menu does.
  if (data.status && data.status !== existing.status) await moveTask(data.id, data.status as TaskStatusKey);

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
  // Linked somewhere else now: the record it left shows it no more.
  if (about?.ok) revalidateTaskPaths(existing);
  return { ok: true, data: { id: task.id } };
}

/** The old tick: done, or open again — through the same move as the status menu (src/lib/tasks/server.ts). */
export async function toggleTaskDone(id: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("tasks");
  // Whoever it's assigned to ticks it off, whatever their role may change (workableTask).
  const task = await workableTask(user.id, id);
  if (!task) {
    return { ok: false, error: "Task not found." };
  }
  await moveTask(id, task.done ? "TODO" : "DONE");
  revalidateTaskPaths(task);
  revalidatePath("/calls");
  return { ok: true, data: null };
}

/**
 * Moves a task to a status (owner, 16 Oct 2026): To do, In progress, Done or Cancelled. Done on time
 * earns its XP; done, a repeating task makes its next one.
 */
export async function setTaskStatus(id: string, status: string): Promise<ActionResult<{ nextTaskId: string | null }>> {
  const user = await requireModuleUser("tasks");
  if (!(TASK_STATUSES as readonly string[]).includes(status)) return { ok: false, error: "That isn't a status a task can have." };
  // Whoever it's assigned to moves it along, whatever their role may change (workableTask).
  const task = await workableTask(user.id, String(id ?? ""));
  if (!task) return { ok: false, error: "Task not found." };
  const moved = await moveTask(task.id, status as TaskStatusKey);
  if (!moved) return { ok: false, error: "Task not found." };
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Task", entityId: task.id, entityLabel: `${task.title} → ${status.toLowerCase().replace("_", " ")}` });
  revalidateTaskPaths(task);
  revalidatePath("/calls");
  return { ok: true, data: moved };
}

/** Stars a task for whoever asks, or takes the star off — theirs alone. */
export async function toggleTaskStar(id: string): Promise<ActionResult<{ starred: boolean }>> {
  const user = await requireModuleUser("tasks");
  const task = await reachableTask(user.id, String(id ?? ""), "view");
  if (!task) return { ok: false, error: "Task not found." };
  const key = { taskId_userId: { taskId: task.id, userId: user.id } };
  const had = await db.taskStar.findUnique({ where: key, select: { taskId: true } });
  if (had) await db.taskStar.delete({ where: key });
  else await db.taskStar.create({ data: { taskId: task.id, userId: user.id } });
  revalidatePath("/tasks");
  return { ok: true, data: { starred: !had } };
}

export async function deleteTask(id: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("tasks");
  // Your own (made by you, or given to you by somebody whose tasks you reach), or anybody's with "Delete
  // any task" — the task rule's delete. One given to you by a manager or a peer is theirs to delete.
  if (!(await db.task.findUnique({ where: { id }, select: { id: true } }))) {
    return { ok: false, error: "Task not found." };
  }
  const task = await reachableTask(user.id, id, "delete");
  if (!task) {
    return { ok: false, error: "You don't have permission to delete this task." };
  }
  if (await givenToWork(user.id, task)) return { ok: false, error: ONLY_WORKS };

  await db.task.delete({ where: { id } });
  revalidateTaskPaths(task);
  return { ok: true, data: null };
}

type TaskListParams = {
  assignedToUserId?: string;
  /** The tasks somebody set — "Set by me" on the Tasks page. */
  createdByUserId?: string;
  done?: boolean;
  search?: string;
  dueFrom?: string;
  dueTo?: string;
  companyId?: string;
  leadId?: string;
  ticketId?: string;
  /** "upcoming" | "todo" | "in_progress" | "done" | "cancelled" | "open" (owner, 16 Oct 2026). */
  status?: string;
  priority?: string;
  departmentId?: string;
  challengeId?: string;
  starred?: boolean;
  sort?: TaskSort;
  dir?: "asc" | "desc";
};

/** A status as the list filters by it: what `shownStatus` would say, written as a query. */
function statusWhere(status: string | undefined, today: Date): Prisma.TaskWhereInput | null {
  switch (status) {
    case "open":
      return { done: false };
    case "done":
      return { done: true, NOT: { status: "CANCELLED" } };
    case "cancelled":
      return { done: true, status: "CANCELLED" };
    case "in_progress":
      return { done: false, status: "IN_PROGRESS" };
    case "upcoming":
      return { done: false, NOT: { status: "IN_PROGRESS" }, startDate: { gt: today } };
    case "todo":
      return { done: false, NOT: { status: "IN_PROGRESS" }, OR: [{ startDate: null }, { startDate: { lte: today } }] };
    default:
      return null;
  }
}

async function taskListWhere(userId: string, params?: TaskListParams): Promise<Prisma.TaskWhereInput> {
  const dueDate = dueDayRange(params?.dueFrom, params?.dueTo);
  const today = (await workspaceClock()).calendarDate(new Date());
  const byStatus = statusWhere(params?.status, today);
  return {
    // The task rule, under AND so the assignee filter narrows it and never stands in for it.
    AND: [await taskAccess(userId, "view"), ...(byStatus ? [byStatus] : [])],
    ...(params?.assignedToUserId
      ? params.assignedToUserId === "unassigned"
        ? { assignedToUserId: null }
        : { assignedToUserId: params.assignedToUserId }
      : {}),
    ...(params?.createdByUserId ? { createdByUserId: params.createdByUserId } : {}),
    ...(params?.done !== undefined ? { done: params.done } : {}),
    ...(params?.search ? { title: { contains: params.search, mode: "insensitive" as const } } : {}),
    ...(dueDate ? { dueDate } : {}),
    ...(params?.companyId ? { companyId: params.companyId } : {}),
    ...(params?.leadId ? { leadId: params.leadId } : {}),
    ...(params?.ticketId ? { ticketId: params.ticketId } : {}),
    ...(params?.priority ? { priority: params.priority as TaskPriorityKey } : {}),
    ...(params?.departmentId ? { departmentId: params.departmentId } : {}),
    ...(params?.challengeId ? { challengeId: params.challengeId } : {}),
    ...(params?.starred ? { stars: { some: { userId } } } : {}),
  };
}

/** The list's order: the column asked for, then due day, so a tie still reads sensibly. */
function taskListOrder(params?: TaskListParams): Prisma.TaskOrderByWithRelationInput[] {
  const dir = params?.dir === "desc" ? "desc" : "asc";
  const due = { dueDate: { sort: "asc" as const, nulls: "last" as const } };
  switch (params?.sort) {
    case "start":
      return [{ startDate: { sort: dir, nulls: "last" } }, due];
    case "priority":
      // Urgent first unless reversed.
      return [{ priority: dir === "asc" ? "desc" : "asc" }, due];
    case "title":
      return [{ title: dir }];
    case "created":
      return [{ createdAt: dir === "asc" ? "desc" : "asc" }];
    case "xp":
      return [{ xp: dir === "asc" ? "desc" : "asc" }, due];
    case "status":
      return [{ done: dir }, { status: dir }, due];
    case "due":
      return [{ dueDate: { sort: dir, nulls: "last" } }];
    default:
      return [{ done: "asc" }, due];
  }
}

const taskListInclude = (userId: string) =>
  ({
    assignedTo: { select: { id: true, name: true, photoUpdatedAt: true } },
    createdBy: { select: { id: true, name: true } },
    company: { select: { id: true, name: true, companySeq: true } },
    lead: { select: { id: true, title: true, leadSeq: true } },
    ticket: { select: { id: true, ticketSeq: true, title: true } },
    department: { select: { id: true, name: true } },
    challenge: { select: { id: true, name: true } },
    stars: { where: { userId }, select: { userId: true } },
    _count: { select: { checklist: true, comments: true, attachments: true } },
  }) as const;

/** How many of each task's checklist steps are ticked — one query for the page. */
async function checklistDone(ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await db.taskChecklistItem.groupBy({ by: ["taskId"], where: { taskId: { in: ids }, done: true }, _count: { _all: true } });
  return new Map(rows.map((r) => [r.taskId, r._count._all]));
}

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
  // Today on the workspace's calendar, as a due date holds a day — not the server's today, which on a
  // server in UTC began at 05:30 in India.
  const today = (await workspaceClock()).calendarDate(new Date());

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
    overdue: t.dueDate !== null && t.dueDate < today,
  }));
}

/** A row of the list, with its checklist's progress and whether the viewer starred it. */
async function withProgress<T extends { id: string; stars: { userId: string }[]; assignedToUserId: string | null; createdByUserId: string }>(userId: string, rows: T[]) {
  const [done, rights] = await Promise.all([checklistDone(rows.map((r) => r.id)), taskRights(userId, rows)]);
  return rows.map(({ stars, ...row }) => ({
    ...row,
    starred: stars.length > 0,
    checklistDone: done.get(row.id) ?? 0,
    // What the viewer may do with it — work it, change it, delete it, and whether it was given to them
    // (src/lib/tasks/server.ts, taskRights) — so the list offers only what the server will do.
    ...rights(row),
  }));
}

export async function listTasks(params?: TaskListParams) {
  const user = await requireModuleUser("tasks");
  const rows = await db.task.findMany({
    where: await taskListWhere(user.id, params),
    orderBy: taskListOrder(params),
    omit: ADVANCED,
    include: taskListInclude(user.id),
  });
  return withProgress(user.id, await leadsSeenBy(user.id, rows));
}

export async function listTasksPaged(params: TaskListParams & { page: number; pageSize: number }) {
  const user = await requireModuleUser("tasks");
  const where = await taskListWhere(user.id, params);
  const [rows, total] = await Promise.all([
    db.task.findMany({
      where,
      orderBy: taskListOrder(params),
      omit: ADVANCED,
      include: taskListInclude(user.id),
      ...pageSlice(params.page, params.pageSize),
    }),
    db.task.count({ where }),
  ]);
  return { rows: await withProgress(user.id, await leadsSeenBy(user.id, rows)), total };
}

/** Open and overdue counts across the whole filtered set, so the header holds steady while paging. */
export async function countTasks(params?: TaskListParams) {
  const user = await requireModuleUser("tasks");
  const where = await taskListWhere(user.id, params);
  // Overdue is due before today on the workspace's calendar, as the list's badge and the rail say. Before
  // now, a day held at UTC midnight was overdue from the evening before it west of UTC.
  const today = (await workspaceClock()).calendarDate(new Date());
  const [open, overdue] = await Promise.all([
    db.task.count({ where: { ...where, done: false } }),
    db.task.count({ where: { ...where, done: false, dueDate: { lt: today } } }),
  ]);
  return { open, overdue };
}

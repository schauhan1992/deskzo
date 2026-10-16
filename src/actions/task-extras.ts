"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { refuseWhileViewingAs } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { taskAccess, type AccessAction } from "@/lib/authz/access";
import { leadsSeenBy } from "@/lib/leads/shown";
import { notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { PEOPLE_ONLY } from "@/lib/people";
import { workspaceClock } from "@/lib/time/workspace";
import { chatFileType } from "@/lib/chat/rules";
import { ADVANCED, storedDay } from "@/lib/tasks/server";
import { COMMENT_MAX, TASK_FILE_MAX_BYTES } from "@/lib/tasks/rules";
import type { ActionResult } from "@/actions/company";

/**
 * Everything on a task beyond its fields (owner, 16 Oct 2026): its checklist, comments, files and time
 * logged, the choices the task form offers, and challenges. Each asks the task rule
 * (src/lib/authz/access.ts) about the task it belongs to: seeing it to read and comment, changing it to
 * tick, attach and log time.
 */

async function taskFor(userId: string, id: string, action: AccessAction) {
  if (typeof id !== "string" || !id) return null;
  return db.task.findFirst({ where: { AND: [{ id }, await taskAccess(userId, action)] }, omit: ADVANCED });
}

const touched = () => revalidatePath("/tasks");

// ─── The panel ───────────────────────────────────────────────────────────────────────────────────

export type TaskPanel = NonNullable<Awaited<ReturnType<typeof getTaskPanel>>>;

/** One task in full, for its panel — or null when this person can't see it. */
export async function getTaskPanel(id: string) {
  const user = await requireModuleUser("tasks");
  if (!(await taskFor(user.id, id, "view"))) return null;
  const [task, canEdit, canDelete] = await Promise.all([
    db.task.findUnique({
      where: { id },
      omit: ADVANCED,
      include: {
        assignedTo: { select: { id: true, name: true, photoUpdatedAt: true } },
        createdBy: { select: { id: true, name: true } },
        xpEarnedBy: { select: { id: true, name: true } },
        department: { select: { id: true, name: true } },
        challenge: { select: { id: true, name: true } },
        company: { select: { id: true, name: true, companySeq: true } },
        lead: { select: { id: true, title: true, leadSeq: true } },
        ticket: { select: { id: true, ticketSeq: true, title: true } },
        checklist: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true, title: true, done: true } },
        comments: {
          orderBy: { createdAt: "asc" },
          select: { id: true, body: true, createdAt: true, user: { select: { id: true, name: true, photoUpdatedAt: true } } },
        },
        attachments: {
          orderBy: { createdAt: "asc" },
          select: { id: true, fileName: true, mimeType: true, size: true, createdAt: true, uploadedBy: { select: { id: true, name: true } } },
        },
        timeLogs: {
          orderBy: [{ spentOn: "desc" }, { createdAt: "desc" }],
          select: { id: true, minutes: true, note: true, spentOn: true, user: { select: { id: true, name: true } } },
        },
        stars: { where: { userId: user.id }, select: { userId: true } },
      },
    }),
    taskFor(user.id, id, "edit").then(Boolean),
    taskFor(user.id, id, "delete").then(Boolean),
  ]);
  if (!task) return null;
  const [shown] = await leadsSeenBy(user.id, [task]);
  const { stars, ...rest } = shown!;
  return {
    ...rest,
    starred: stars.length > 0,
    loggedMinutes: task.timeLogs.reduce((sum, t) => sum + t.minutes, 0),
    viewerId: user.id,
    canEdit,
    canDelete,
  };
}

// ─── The checklist ───────────────────────────────────────────────────────────────────────────────

export async function addChecklistItem(taskId: string, title: string): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("tasks");
  const task = await taskFor(user.id, taskId, "edit");
  if (!task) return { ok: false, error: "Task not found." };
  const text = String(title ?? "").trim();
  if (!text) return { ok: false, error: "Write the step first." };
  if (text.length > 200) return { ok: false, error: "A step is at most 200 characters." };
  const last = await db.taskChecklistItem.aggregate({ where: { taskId: task.id }, _max: { sortOrder: true } });
  const item = await db.taskChecklistItem.create({ data: { taskId: task.id, title: text, sortOrder: (last._max.sortOrder ?? -1) + 1 }, select: { id: true } });
  touched();
  return { ok: true, data: item };
}

async function itemFor(userId: string, itemId: string) {
  const item = await db.taskChecklistItem.findUnique({ where: { id: String(itemId ?? "") }, select: { id: true, taskId: true, done: true } });
  return item && (await taskFor(userId, item.taskId, "edit")) ? item : null;
}

export async function toggleChecklistItem(itemId: string): Promise<ActionResult<{ done: boolean }>> {
  const user = await requireModuleUser("tasks");
  const item = await itemFor(user.id, itemId);
  if (!item) return { ok: false, error: "That step no longer exists." };
  const done = !item.done;
  await db.taskChecklistItem.update({ where: { id: item.id }, data: { done, doneAt: done ? new Date() : null, doneById: done ? user.id : null } });
  touched();
  return { ok: true, data: { done } };
}

export async function deleteChecklistItem(itemId: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("tasks");
  const item = await itemFor(user.id, itemId);
  if (!item) return { ok: false, error: "That step no longer exists." };
  await db.taskChecklistItem.delete({ where: { id: item.id } });
  touched();
  return { ok: true, data: null };
}

// ─── Comments ────────────────────────────────────────────────────────────────────────────────────

/** A comment on a task anybody who can see it may leave; its maker and its assignee are told. */
export async function addTaskComment(taskId: string, body: string): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("tasks");
  const refused = await refuseWhileViewingAs();
  if (refused) return { ok: false, error: refused };
  const task = await taskFor(user.id, taskId, "view");
  if (!task) return { ok: false, error: "Task not found." };
  const text = String(body ?? "").trim();
  if (!text) return { ok: false, error: "Write the comment first." };
  if (text.length > COMMENT_MAX) return { ok: false, error: `A comment is at most ${COMMENT_MAX.toLocaleString("en-IN")} characters.` };
  const comment = await db.taskComment.create({ data: { taskId: task.id, userId: user.id, body: text }, select: { id: true } });
  const name = (await db.user.findUnique({ where: { id: user.id }, select: { name: true } }))?.name ?? "Somebody";
  for (const to of new Set([task.assignedToUserId, task.createdByUserId].filter((v): v is string => !!v && v !== user.id))) {
    await notifyUser({ userId: to, type: "TASK_COMMENT", title: `${name} commented on "${task.title}"`, message: text.slice(0, 200), link: "/tasks" });
  }
  touched();
  return { ok: true, data: comment };
}

/** Its writer takes a comment back, or anybody who may change the task. */
export async function deleteTaskComment(commentId: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("tasks");
  const comment = await db.taskComment.findUnique({ where: { id: String(commentId ?? "") }, select: { id: true, taskId: true, userId: true } });
  if (!comment || !(await taskFor(user.id, comment.taskId, "view"))) return { ok: false, error: "That comment no longer exists." };
  if (comment.userId !== user.id && !(await taskFor(user.id, comment.taskId, "edit"))) return { ok: false, error: "Only its writer can take a comment back." };
  await db.taskComment.delete({ where: { id: comment.id } });
  touched();
  return { ok: true, data: null };
}

// ─── Files ───────────────────────────────────────────────────────────────────────────────────────

/** A file attached to a task — the kinds chat takes, up to 10 MB — served only by /api/tasks/files. */
export async function uploadTaskFile(form: FormData): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("tasks");
  const refused = await refuseWhileViewingAs();
  if (refused) return { ok: false, error: refused };
  const task = await taskFor(user.id, String(form.get("taskId") ?? ""), "edit");
  if (!task) return { ok: false, error: "Task not found." };
  const file = form.get("file");
  if (!file || typeof file !== "object" || !("arrayBuffer" in file) || (file as File).size === 0) return { ok: false, error: "Choose a file." };
  const f = file as File;
  if (f.size > TASK_FILE_MAX_BYTES) return { ok: false, error: "Files on a task can be up to 10 MB." };
  const mimeType = chatFileType(f.type, f.name);
  if (!mimeType) return { ok: false, error: `"${f.name}" isn't a kind of file a task takes — pictures, PDFs, office documents, text and zip files are.` };
  const saved = await db.taskAttachment.create({
    data: { taskId: task.id, uploadedById: user.id, fileName: f.name.slice(0, 200), mimeType, size: f.size, data: Buffer.from(await f.arrayBuffer()) },
    select: { id: true },
  });
  await recordAudit({ userId: user.id, action: "CREATE", entityType: "TaskAttachment", entityId: saved.id, entityLabel: `${f.name.slice(0, 80)} on "${task.title}"` });
  touched();
  return { ok: true, data: saved };
}

export async function deleteTaskFile(fileId: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("tasks");
  const file = await db.taskAttachment.findUnique({ where: { id: String(fileId ?? "") }, select: { id: true, taskId: true, uploadedById: true, fileName: true } });
  if (!file || !(await taskFor(user.id, file.taskId, "view"))) return { ok: false, error: "That file no longer exists." };
  if (file.uploadedById !== user.id && !(await taskFor(user.id, file.taskId, "edit"))) return { ok: false, error: "Only whoever attached it can remove a file." };
  await db.taskAttachment.delete({ where: { id: file.id } });
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "TaskAttachment", entityId: file.id, entityLabel: file.fileName.slice(0, 80) });
  touched();
  return { ok: true, data: null };
}

// ─── Time logged ─────────────────────────────────────────────────────────────────────────────────

/** Time spent on a task, by whoever spent it: up to a day at a time, on a day that has happened. */
export async function logTaskTime(input: { taskId: string; minutes: number; note?: string; spentOn?: string }): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("tasks");
  const refused = await refuseWhileViewingAs();
  if (refused) return { ok: false, error: refused };
  const task = await taskFor(user.id, String(input?.taskId ?? ""), "edit");
  if (!task) return { ok: false, error: "Task not found." };
  const minutes = Number(input?.minutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) return { ok: false, error: "Log between 1 minute and 24 hours at a time." };
  const today = (await workspaceClock()).today();
  const day = String(input?.spentOn || today);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day > today) return { ok: false, error: "Time is logged on a day that has happened." };
  const note = String(input?.note ?? "").trim().slice(0, 300) || null;
  const log = await db.taskTimeLog.create({ data: { taskId: task.id, userId: user.id, minutes, note, spentOn: storedDay(day) }, select: { id: true } });
  touched();
  return { ok: true, data: log };
}

export async function deleteTaskTime(logId: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("tasks");
  const log = await db.taskTimeLog.findUnique({ where: { id: String(logId ?? "") }, select: { id: true, userId: true } });
  if (!log || log.userId !== user.id) return { ok: false, error: "Only whoever logged the time can take it off." };
  await db.taskTimeLog.delete({ where: { id: log.id } });
  touched();
  return { ok: true, data: null };
}

// ─── The form's choices ──────────────────────────────────────────────────────────────────────────

/** The teams (departments), live challenges and people the task form offers. */
export async function taskFormOptions() {
  await requireModuleUser("tasks");
  const [departments, challenges, people] = await Promise.all([
    db.department.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.taskChallenge.findMany({ where: { archivedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true, departmentId: true } }),
    db.user.findMany({ where: { active: true, ...PEOPLE_ONLY }, orderBy: { name: "asc" }, select: { id: true, name: true, departmentId: true } }),
  ]);
  return { departments, challenges, people };
}

// ─── Challenges ──────────────────────────────────────────────────────────────────────────────────

/** The challenges, live first, with how their tasks stand and the XP they carry. */
export async function listTaskChallenges() {
  await requireModuleUser("tasks");
  const challenges = await db.taskChallenge.findMany({
    orderBy: [{ archivedAt: { sort: "desc", nulls: "first" } }, { createdAt: "desc" }],
    select: {
      id: true,
      name: true,
      description: true,
      startDate: true,
      endDate: true,
      archivedAt: true,
      createdById: true,
      department: { select: { id: true, name: true } },
    },
  });
  const ids = challenges.map((c) => c.id);
  const totals = ids.length
    ? await db.task.groupBy({ by: ["challengeId", "done"], where: { challengeId: { in: ids } }, _count: { _all: true }, _sum: { xp: true, xpEarned: true } })
    : [];
  return challenges.map((c) => {
    const mine = totals.filter((t) => t.challengeId === c.id);
    return {
      ...c,
      tasks: mine.reduce((n, t) => n + t._count._all, 0),
      done: mine.filter((t) => t.done).reduce((n, t) => n + t._count._all, 0),
      xp: mine.reduce((n, t) => n + (t._sum.xp ?? 0), 0),
      xpEarned: mine.reduce((n, t) => n + (t._sum.xpEarned ?? 0), 0),
    };
  });
}

/** Makes or changes a challenge: whoever made it, or whoever manages the workspace's settings, changes one. */
export async function saveTaskChallenge(input: {
  id?: string;
  name: string;
  description?: string;
  departmentId?: string;
  startDate?: string;
  endDate?: string;
}): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("tasks");
  const refused = await refuseWhileViewingAs();
  if (refused) return { ok: false, error: refused };
  const name = String(input?.name ?? "").trim();
  if (name.length < 2 || name.length > 80) return { ok: false, error: "Give the challenge a name of 2 to 80 characters." };
  const description = String(input?.description ?? "").trim().slice(0, 500) || null;
  const departmentId = input?.departmentId || null;
  if (departmentId && !(await db.department.count({ where: { id: departmentId } }))) return { ok: false, error: "That team no longer exists." };
  const day = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? storedDay(v) : null);
  const startDate = day(input?.startDate);
  const endDate = day(input?.endDate);
  if (startDate && endDate && startDate > endDate) return { ok: false, error: "A challenge can't end before it starts." };
  const data = { name, description, departmentId, startDate, endDate };

  if (input?.id) {
    const existing = await db.taskChallenge.findUnique({ where: { id: input.id }, select: { id: true, createdById: true } });
    if (!existing) return { ok: false, error: "That challenge no longer exists." };
    if (existing.createdById !== user.id && !(await can(user.id, "settings.manage"))) return { ok: false, error: "Only whoever made a challenge can change it." };
    await db.taskChallenge.update({ where: { id: existing.id }, data });
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "TaskChallenge", entityId: existing.id, entityLabel: name });
    touched();
    return { ok: true, data: { id: existing.id } };
  }
  const made = await db.taskChallenge.create({ data: { ...data, createdById: user.id }, select: { id: true } });
  await recordAudit({ userId: user.id, action: "CREATE", entityType: "TaskChallenge", entityId: made.id, entityLabel: name });
  touched();
  return { ok: true, data: made };
}

/** Archives a challenge — its tasks keep it — or brings one back. */
export async function archiveTaskChallenge(id: string, archived: boolean): Promise<ActionResult<null>> {
  const user = await requireModuleUser("tasks");
  const existing = await db.taskChallenge.findUnique({ where: { id: String(id ?? "") }, select: { id: true, createdById: true, name: true } });
  if (!existing) return { ok: false, error: "That challenge no longer exists." };
  if (existing.createdById !== user.id && !(await can(user.id, "settings.manage"))) return { ok: false, error: "Only whoever made a challenge can archive it." };
  await db.taskChallenge.update({ where: { id: existing.id }, data: { archivedAt: archived ? new Date() : null } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "TaskChallenge", entityId: existing.id, entityLabel: `${existing.name} ${archived ? "archived" : "brought back"}` });
  touched();
  return { ok: true, data: null };
}

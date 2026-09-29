"use server";

import { revalidatePath } from "next/cache";
import type { CloseTaskStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { toPlain } from "@/lib/serialize";
import { checkUpload } from "@/lib/hr/document-upload";
import { FLUX_NOTE_MAX, taskHref } from "@/lib/close/catalogue";
import {
  currentMonth,
  indiaToday,
  lastCompletedMonth,
  monthKeyOf,
  monthLabel,
  monthName,
  parseMonthKey,
} from "@/lib/close/months";
import {
  closeBlockers,
  evaluateAutoChecks,
  ensureCloseMonth,
  generateTasks,
  monthTasks,
  progressOf,
  workableTask,
  writeTaskNote,
  writeTaskOwner,
  writeTaskStatus,
} from "@/lib/close/checklist";
import { closeMonthInBooks, reopenMonthInBooks } from "@/lib/close/closing";
import { ensureDefaultTemplates, listTemplates, removeTemplate, reorderTemplateRows, writeTemplate, type TemplateInput } from "@/lib/close/templates";
import { fluxFor, writeFluxNote } from "@/lib/close/flux";
import { closeSettingsProblem, readCloseSettings, writeCloseSettings, type CloseSettings } from "@/lib/close/settings";
import { authorLabel } from "@/lib/automation-user";
import { PEOPLE_ONLY } from "@/lib/people";
import type { ActionResult } from "@/actions/company";

/**
 * The month-end close (Revenue & Close, spec §4): the checklist, closing and reopening a month, the
 * templates, flux and the close settings.
 *
 * Permissions:
 *   · reading the close, and working it — ticking, "not applicable", notes, owners, attachments, flux
 *     explanations — is `close.work` (`close.manage` reads too);
 *   · templates and the settings are `close.manage`;
 *   · closing and reopening a month is `close.manage` **and** the ledger's own `books.close`, because it
 *     moves the period lock.
 *
 * The work itself is in src/lib/close (the nightly job calls the same functions with nobody signed in).
 */

type Access = { user: Awaited<ReturnType<typeof requireModuleUser>>; work: boolean; manage: boolean };

async function access(): Promise<Access> {
  const user = await requireModuleUser("revenue_close");
  const [work, manage] = await Promise.all([
    hasEffectivePermission(user.id, "close.work"),
    hasEffectivePermission(user.id, "close.manage"),
  ]);
  return { user, work, manage };
}

const NO_READ = "You don't have access to the month-end close.";
const NO_WORK = "You can't work the month-end checklist.";
const NO_MANAGE = "Only somebody who manages the close can change this.";

/** A month from the screen, or a refusal: a real month, and not one still to come. */
function monthFrom(key: string | null | undefined, now: Date): { ok: true; month: Date } | { ok: false; error: string } {
  const month = parseMonthKey(key);
  if (!month) return { ok: false, error: "Choose a month." };
  if (month.getTime() > currentMonth(now).getTime()) return { ok: false, error: `${monthLabel(month)} hasn't started yet.` };
  return { ok: true, month };
}

function revalidateClose() {
  revalidatePath("/accounting/close");
  revalidatePath("/accounting");
}

// ─── The month ───────────────────────────────────────────────────────────────────────────────

/**
 * A month's close, as the page shows it — made on first read: the month's row, its checklist from the
 * templates (seeded the first time), and every automatic check run fresh unless `refresh: false` or the
 * month is closed. The default month is the last one that has ended.
 */
export async function getCloseMonth(monthKey?: string | null, opts: { refresh?: boolean } = {}) {
  const { user, work, manage } = await access();
  if (!work && !manage) return null;
  const now = new Date();
  const picked = monthFrom(monthKey ?? monthKeyOf(lastCompletedMonth(now)), now);
  if (!picked.ok) return null;
  const { month } = picked;

  await generateTasks(month, { now });
  const row = await ensureCloseMonth(month);
  if (row.status === "OPEN" && opts.refresh !== false) await evaluateAutoChecks(month, { now });

  const [tasks, closedBy, blockers, canClose] = await Promise.all([
    monthTasks(month),
    row.closedById ? db.user.findUnique({ where: { id: row.closedById }, select: { id: true, name: true } }) : null,
    closeBlockers(month, now),
    manage ? hasEffectivePermission(user.id, "books.close") : false,
  ]);
  const today = indiaToday(now);

  return toPlain({
    month: monthKeyOf(month),
    label: monthLabel(month),
    name: monthName(month),
    status: row.status,
    closedAt: row.closedAt,
    closedBy,
    reopenedAt: row.reopenedAt,
    note: row.note,
    progress: progressOf(tasks, today),
    blockers: row.status === "CLOSED" ? [] : blockers.blockers,
    permissions: { work, manage, close: manage && canClose },
    tasks: tasks.map((t) => ({
      id: t.id,
      templateId: t.templateId,
      title: t.title,
      description: t.template?.description ?? null,
      owner: t.owner,
      dueOn: t.dueOn,
      overdue: t.status === "TODO" && t.dueOn.getTime() < today.getTime(),
      status: t.status,
      doneAt: t.doneAt,
      doneBy: t.doneBy ? { id: t.doneBy.id, name: authorLabel(t.doneBy), automatic: t.doneBy.kind === "AUTOMATION" } : null,
      note: t.note,
      autoCheck: t.autoCheck,
      autoOk: t.autoOk,
      autoDetail: t.autoDetail,
      autoCheckedAt: t.autoCheckedAt,
      href: taskHref(t),
      attachments: t.attachments,
    })),
  });
}

/** The months with a close, newest first, for the month picker and the history. */
export async function listCloseMonths() {
  const { work, manage } = await access();
  if (!work && !manage) return [];
  const [months, counts] = await Promise.all([
    db.closeMonth.findMany({
      orderBy: { month: "desc" },
      take: 36,
      select: { month: true, status: true, closedAt: true, reopenedAt: true, note: true, closedBy: { select: { id: true, name: true } } },
    }),
    db.closeTask.groupBy({ by: ["month", "status"], _count: { _all: true } }),
  ]);
  return toPlain(
    months.map((m) => {
      const mine = counts.filter((c) => c.month.getTime() === m.month.getTime());
      const count = (s?: CloseTaskStatus) => mine.filter((c) => !s || c.status === s).reduce((t, c) => t + c._count._all, 0);
      return {
        month: monthKeyOf(m.month),
        label: monthLabel(m.month),
        status: m.status,
        closedAt: m.closedAt,
        closedBy: m.closedBy,
        reopenedAt: m.reopenedAt,
        note: m.note,
        total: count(),
        done: count("DONE") + count("NOT_APPLICABLE"),
      };
    }),
  );
}

/** What changed on a month's close, newest first: closings, reopenings, overrides (the audit log). */
export async function closeMonthHistory(monthKey: string) {
  const { work, manage } = await access();
  if (!work && !manage) return [];
  const month = parseMonthKey(monthKey);
  if (!month) return [];
  const row = await db.closeMonth.findUnique({ where: { month }, select: { id: true } });
  if (!row) return [];
  const rows = await db.auditLog.findMany({
    where: { entityType: "CloseMonth", entityId: row.id },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, entityLabel: true, createdAt: true, user: { select: { id: true, name: true } } },
  });
  return toPlain(rows);
}

/** Runs the month's automatic checks again now. */
export async function refreshCloseChecks(monthKey: string): Promise<ActionResult<{ evaluated: number; passed: number; failed: number }>> {
  const { work, manage } = await access();
  if (!work && !manage) return { ok: false, error: NO_READ };
  const now = new Date();
  const picked = monthFrom(monthKey, now);
  if (!picked.ok) return picked;
  await generateTasks(picked.month, { now });
  const result = await evaluateAutoChecks(picked.month, { now });
  revalidateClose();
  return { ok: true, data: { evaluated: result.evaluated, passed: result.passed, failed: result.failed } };
}

/**
 * "Close September": locks the books to the month's last day and marks it closed. Refused while any
 * task is open unless `override` gives a written reason (audited), and refused out of order.
 */
export async function closeMonth(monthKey: string, opts: { override?: string | null } = {}): Promise<ActionResult<{ lockedUntil: string | null }>> {
  const { user, manage } = await access();
  if (!manage || !(await hasEffectivePermission(user.id, "books.close"))) {
    return { ok: false, error: "Closing a month needs both managing the close and closing the books." };
  }
  const now = new Date();
  const picked = monthFrom(monthKey, now);
  if (!picked.ok) return picked;
  const result = await closeMonthInBooks({ month: picked.month, userId: user.id, override: opts.override, now });
  if (!result.ok) return result;
  revalidateClose();
  revalidatePath("/accounting/books");
  return { ok: true, data: { lockedUntil: result.lock?.lockedUntil?.toISOString().slice(0, 10) ?? null } };
}

/** Reopens a closed month and every later one, loosening the lock to the month before. A reason is required. */
export async function reopenMonth(monthKey: string, reason: string): Promise<ActionResult<{ reopened: string[] }>> {
  const { user, manage } = await access();
  if (!manage || !(await hasEffectivePermission(user.id, "books.close"))) {
    return { ok: false, error: "Reopening a month needs both managing the close and closing the books." };
  }
  const month = parseMonthKey(monthKey);
  if (!month) return { ok: false, error: "Choose a month." };
  const result = await reopenMonthInBooks({ month, userId: user.id, reason });
  if (!result.ok) return result;
  revalidateClose();
  revalidatePath("/accounting/books");
  return { ok: true, data: { reopened: result.reopened } };
}

/** The card on the Accounting overview: last month's close, "9 of 14 · due 3 Oct". Null when nobody here may see it. */
export async function closeOverview() {
  const { work, manage } = await access();
  if (!work && !manage) return null;
  const now = new Date();
  const month = lastCompletedMonth(now);
  const row = await db.closeMonth.findUnique({ where: { month }, select: { status: true } });
  const tasks = await db.closeTask.findMany({ where: { month }, select: { status: true, dueOn: true } });
  return toPlain({
    month: monthKeyOf(month),
    label: monthLabel(month),
    name: monthName(month),
    status: row?.status ?? "OPEN",
    started: tasks.length > 0,
    progress: progressOf(tasks, indiaToday(now)),
  });
}

// ─── Working the checklist ───────────────────────────────────────────────────────────────────

/**
 * Who a task (or a template) can be given to: active people only — never the Automation or support
 * accounts (`PEOPLE_ONLY`), which `writeTaskOwner` and `writeTemplate` refuse anyway.
 */
export async function listCloseOwnerOptions() {
  const { work, manage } = await access();
  if (!work && !manage) return [];
  return db.user.findMany({
    where: { active: true, ...PEOPLE_ONLY },
    orderBy: { name: "asc" },
    select: { id: true, name: true, email: true, photoUpdatedAt: true },
  });
}

/** Ticks a task, marks it not applicable (a note is required), or puts it back to do. */
export async function setTaskStatus(taskId: string, status: CloseTaskStatus, note?: string | null): Promise<ActionResult<null>> {
  const { user, work } = await access();
  if (!work) return { ok: false, error: NO_WORK };
  if (!["TODO", "DONE", "NOT_APPLICABLE"].includes(status)) return { ok: false, error: "That isn't a task status." };
  const result = await writeTaskStatus({ taskId, status, note, userId: user.id, userName: user.name });
  if (!result.ok) return result;
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "CloseTask",
    entityId: taskId,
    entityLabel: `${result.task.title} (${monthLabel(result.task.month)}) → ${status === "NOT_APPLICABLE" ? "not applicable" : status === "DONE" ? "done" : "to do"}`,
  });
  revalidateClose();
  return { ok: true, data: null };
}

/** Gives a task to somebody (or nobody). They are told. */
export async function setTaskOwner(taskId: string, ownerId: string | null): Promise<ActionResult<null>> {
  const { user, work } = await access();
  if (!work) return { ok: false, error: NO_WORK };
  const result = await writeTaskOwner({ taskId, ownerId: ownerId || null, userId: user.id });
  if (!result.ok) return result;
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "CloseTask",
    entityId: taskId,
    entityLabel: `${result.task.title} (${monthLabel(result.task.month)}) — owner ${ownerId ? "changed" : "removed"}`,
  });
  revalidateClose();
  return { ok: true, data: null };
}

/** Adds a note under the writer's name and the day. */
export async function addTaskNote(taskId: string, text: string): Promise<ActionResult<null>> {
  const { user, work } = await access();
  if (!work) return { ok: false, error: NO_WORK };
  const result = await writeTaskNote({ taskId, text, userName: user.name });
  if (!result.ok) return result;
  revalidateClose();
  return { ok: true, data: null };
}

/**
 * Attaches a file to a task — the statement a reconciliation was agreed to, the GST working. Stored as
 * project and HR documents are (a data URL in the row), with their size and type rules (`checkUpload`).
 */
export async function addTaskAttachment(
  taskId: string,
  file: { name: string; fileDataUrl: string; mimeType: string },
): Promise<ActionResult<{ id: string }>> {
  const { user, work } = await access();
  if (!work) return { ok: false, error: NO_WORK };
  const guard = await workableTask(taskId);
  if (!guard.ok) return guard;
  const check = checkUpload(file);
  if (!check.ok) return { ok: false, error: check.error };
  const created = await db.closeTaskAttachment.create({
    data: { taskId, name: file.name.trim().slice(0, 200), fileDataUrl: file.fileDataUrl, mimeType: file.mimeType, sizeBytes: check.sizeBytes, uploadedById: user.id },
    select: { id: true },
  });
  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "CloseTaskAttachment",
    entityId: created.id,
    entityLabel: `${file.name.trim()} on ${guard.task.title} (${monthLabel(guard.task.month)})`,
  });
  revalidateClose();
  return { ok: true, data: created };
}

/** The file itself, fetched only when somebody opens it — the page lists names, not megabytes of base64. */
export async function getTaskAttachmentFile(id: string): Promise<ActionResult<{ name: string; mimeType: string; fileDataUrl: string }>> {
  const { work, manage } = await access();
  if (!work && !manage) return { ok: false, error: NO_READ };
  const file = await db.closeTaskAttachment.findUnique({ where: { id }, select: { name: true, mimeType: true, fileDataUrl: true } });
  if (!file) return { ok: false, error: "That file no longer exists." };
  return { ok: true, data: file };
}

export async function deleteTaskAttachment(id: string): Promise<ActionResult<null>> {
  const { user, work } = await access();
  if (!work) return { ok: false, error: NO_WORK };
  const file = await db.closeTaskAttachment.findUnique({ where: { id }, select: { name: true, taskId: true } });
  if (!file) return { ok: false, error: "That file no longer exists." };
  const guard = await workableTask(file.taskId);
  if (!guard.ok) return guard;
  await db.closeTaskAttachment.delete({ where: { id } });
  await recordAudit({
    userId: user.id,
    action: "DELETE",
    entityType: "CloseTaskAttachment",
    entityId: id,
    entityLabel: `${file.name} on ${guard.task.title} (${monthLabel(guard.task.month)})`,
  });
  revalidateClose();
  return { ok: true, data: null };
}

// ─── Templates ───────────────────────────────────────────────────────────────────────────────

/** Every template, active or not, in order — the settings catalogue's editor. Seeds the defaults the first time. */
export async function listCloseTemplates() {
  const { manage } = await access();
  if (!manage) return [];
  await ensureDefaultTemplates();
  return toPlain(await listTemplates({ includeInactive: true }));
}

export async function saveCloseTemplate(input: TemplateInput): Promise<ActionResult<{ id: string }>> {
  const { user, manage } = await access();
  if (!manage) return { ok: false, error: NO_MANAGE };
  await ensureDefaultTemplates();
  const result = await writeTemplate(input);
  if (!result.ok) return result;
  await recordAudit({
    userId: user.id,
    action: result.created ? "CREATE" : "UPDATE",
    entityType: "CloseTaskTemplate",
    entityId: result.id,
    entityLabel: input.title.trim(),
  });
  revalidatePath("/settings");
  revalidateClose();
  return { ok: true, data: { id: result.id } };
}

/** Deletes a template. Months already generated keep their task; the defaults are never seeded again. */
export async function deleteCloseTemplate(id: string): Promise<ActionResult<null>> {
  const { user, manage } = await access();
  if (!manage) return { ok: false, error: NO_MANAGE };
  const result = await removeTemplate(id);
  if (!result.ok) return result;
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "CloseTaskTemplate", entityId: id, entityLabel: result.title });
  revalidatePath("/settings");
  return { ok: true, data: null };
}

export async function reorderCloseTemplates(ids: string[]): Promise<ActionResult<null>> {
  const { manage } = await access();
  if (!manage) return { ok: false, error: NO_MANAGE };
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) return { ok: false, error: "That isn't an order." };
  await reorderTemplateRows(ids);
  revalidatePath("/settings");
  return { ok: true, data: null };
}

// ─── Flux ────────────────────────────────────────────────────────────────────────────────────

/** The flux table for a month: every account against last month and last year, the flags and the notes. */
export async function getFlux(monthKey: string) {
  const { work, manage } = await access();
  if (!work && !manage) return null;
  const picked = monthFrom(monthKey, new Date());
  if (!picked.ok) return null;
  return toPlain(await fluxFor(picked.month));
}

/** Why an account moved as it did in a month. At most 1,000 characters. */
export async function explainFlux(monthKey: string, accountId: string, explanation: string): Promise<ActionResult<null>> {
  const { user, work } = await access();
  if (!work) return { ok: false, error: NO_WORK };
  const month = parseMonthKey(monthKey);
  if (!month) return { ok: false, error: "Choose a month." };
  const text = explanation?.trim() ?? "";
  if (!text) return { ok: false, error: "Write the explanation first." };
  if (text.length > FLUX_NOTE_MAX) return { ok: false, error: `Keep it under ${FLUX_NOTE_MAX.toLocaleString("en-IN")} characters.` };
  const row = await db.closeMonth.findUnique({ where: { month }, select: { status: true } });
  if (row?.status === "CLOSED") return { ok: false, error: `${monthLabel(month)} is closed. Reopen it to change its explanations.` };
  const account = await db.ledgerAccount.findUnique({ where: { id: accountId }, select: { code: true, name: true, isGroup: true } });
  if (!account || account.isGroup) return { ok: false, error: "That account no longer exists." };
  await writeFluxNote({ month, accountId, explanation: text, userId: user.id });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "FluxNote",
    entityId: `${monthKeyOf(month)}:${accountId}`,
    entityLabel: `Explained ${account.code} ${account.name} for ${monthLabel(month)}`,
  });
  revalidateClose();
  return { ok: true, data: null };
}

// ─── Settings ────────────────────────────────────────────────────────────────────────────────

export async function getCloseSettings(): Promise<CloseSettings | null> {
  const { work, manage } = await access();
  if (!work && !manage) return null;
  return readCloseSettings();
}

/** Automatic posting, the revenue spreading default and the flux thresholds. */
export async function saveCloseSettings(input: CloseSettings): Promise<ActionResult<CloseSettings>> {
  const { user, manage } = await access();
  if (!manage) return { ok: false, error: NO_MANAGE };
  const clean = {
    autoPost: input.autoPost,
    spreadEvenly: input.spreadEvenly,
    fluxPercent: Number(input.fluxPercent),
    fluxAmount: Number(input.fluxAmount),
  };
  const problem = closeSettingsProblem(clean);
  if (problem) return { ok: false, error: problem };
  const saved = await writeCloseSettings(clean, user.id);
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "RevenueCloseSettings",
    entityId: "global",
    entityLabel: `Revenue & Close settings: automatic posting ${saved.autoPost ? "on" : "off"}, spread ${saved.spreadEvenly ? "evenly" : "by day"}, flux at ${saved.fluxPercent}% and ₹${saved.fluxAmount.toLocaleString("en-IN")}`,
  });
  revalidateClose();
  revalidatePath("/settings");
  return { ok: true, data: saved };
}

import type { CloseTaskStatus, NotificationType, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notifyUser } from "@/lib/notify";
import { automationUserId } from "@/lib/automation-user";
import { PEOPLE_ONLY } from "@/lib/people";
import { formatIstDate } from "@/lib/india-time";
import { isLockedDate } from "@/lib/ledger/period";
import { CHECKED_AUTOMATICALLY, isAutoCheckKey, type AutoCheckKey } from "@/lib/close/catalogue";
import {
  addDays,
  currentMonth,
  dayKey,
  dueOnFor,
  indiaToday,
  monthEnd,
  monthKeyOf,
  monthLabel,
} from "@/lib/close/months";
import { ensureDefaultTemplates } from "@/lib/close/templates";
import { runCheck } from "@/lib/close/loaders";
import type { CheckDetail } from "@/lib/close/checks";

/**
 * A month's checklist: the month row, its tasks, the automatic checks that tick them, and the people
 * told about them.
 *
 * Library functions, not actions: the close page (through src/actions/close.ts, which checks who is
 * asking) and the nightly job (src/lib/close/nightly.ts, with nobody signed in) both call them.
 *
 * **Who ticked it.** A task an automatic check passes is marked DONE by the workspace's Automation
 * account (`automationUserId`, src/lib/automation-user.ts), with the note "Checked automatically". A
 * later failure undoes only that: a task the Automation account ticked goes back to TODO, while one a
 * person marked DONE or NOT_APPLICABLE is theirs, and a failing check only refreshes what it found.
 */

/** Where a task is opened from a notification. */
export function closeTaskLink(month: Date, taskId: string): string {
  return `/accounting/close?month=${monthKeyOf(month)}&task=${taskId}`;
}

/** The month's row, made on first read. */
export async function ensureCloseMonth(month: Date) {
  const select = { id: true, month: true, status: true, closedAt: true, closedById: true, reopenedAt: true, note: true } as const;
  const existing = await db.closeMonth.findUnique({ where: { month }, select });
  if (existing) return existing;
  try {
    return await db.closeMonth.create({ data: { month }, select });
  } catch {
    // Two first reads at once: the other one made it.
    return db.closeMonth.findUniqueOrThrow({ where: { month }, select });
  }
}

/**
 * Copies the active templates into the month's checklist: one task per template, unique on
 * (month, template), so generating twice — the page and the nightly job at once — gives one set. Due on
 * the template's `dueDay`th working day of the next month. Owners of new tasks are told.
 *
 * Not for a month still to come, and not for a closed one (its checklist is what it was closed with).
 */
export async function generateTasks(month: Date, opts: { now?: Date } = {}): Promise<{ created: number }> {
  const now = opts.now ?? new Date();
  if (month.getTime() > currentMonth(now).getTime()) return { created: 0 };
  // A month the books are already locked through was closed before (Close the Books, or before the
  // checklist existed): opening it — by a typed address, say — must not give it a checklist, or its
  // open tasks would stand in front of every later close (months close in order).
  if (await lockedThrough(month)) return { created: 0 };
  await ensureDefaultTemplates(now);
  const row = await ensureCloseMonth(month);
  if (row.status === "CLOSED") return { created: 0 };

  const templates = await db.closeTaskTemplate.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: { id: true, title: true, ownerId: true, dueDay: true, autoCheck: true },
  });
  if (templates.length === 0) return { created: 0 };
  const have = new Set(
    (await db.closeTask.findMany({ where: { month, templateId: { in: templates.map((t) => t.id) } }, select: { templateId: true } })).map((t) => t.templateId),
  );
  const missing = templates.filter((t) => !have.has(t.id));
  if (missing.length === 0) return { created: 0 };

  await db.closeTask.createMany({
    data: missing.map((t) => ({
      month,
      templateId: t.id,
      title: t.title,
      ownerId: t.ownerId,
      dueOn: dueOnFor(month, t.dueDay),
      autoCheck: isAutoCheckKey(t.autoCheck) ? t.autoCheck : null,
      status: "TODO" as const,
    })),
    skipDuplicates: true,
  });

  const created = await db.closeTask.findMany({
    where: { month, templateId: { in: missing.map((t) => t.id) }, ownerId: { not: null } },
    select: { id: true, title: true, ownerId: true, dueOn: true },
  });
  for (const task of created) {
    await notifyOnce(task.ownerId!, "TASK_ASSIGNED", month, task.id, {
      title: `Month-end close: ${task.title}`,
      message: `${monthLabel(month)} close · due ${formatIstDate(task.dueOn)}`,
    });
  }
  return { created: missing.length };
}

export type EvaluateResult = { month: string; evaluated: number; passed: number; failed: number; ticked: number; unticked: number; errors: string[] };

/**
 * Runs every task's automatic check for the month and stores what it found. A pass ticks a TODO task
 * (as the Automation account); a failure unticks only a task the Automation account ticked.
 *
 * A check that cannot run (its loader threw) leaves the task as it was, with `autoOk` null and the
 * reason in the detail — "couldn't check" is not evidence either way.
 */
export async function evaluateAutoChecks(month: Date, opts: { now?: Date; keys?: AutoCheckKey[] } = {}): Promise<EvaluateResult> {
  const now = opts.now ?? new Date();
  const result: EvaluateResult = { month: monthKeyOf(month), evaluated: 0, passed: 0, failed: 0, ticked: 0, unticked: 0, errors: [] };
  const row = await db.closeMonth.findUnique({ where: { month }, select: { status: true } });
  if (row?.status === "CLOSED") return result;

  const tasks = await db.closeTask.findMany({
    where: { month, autoCheck: opts.keys ? { in: opts.keys } : { not: null } },
    select: { id: true, autoCheck: true, status: true, doneById: true, note: true },
  });
  if (tasks.length === 0) return result;

  const automation = await automationUserId();
  const outcomes = new Map<AutoCheckKey, { ok: boolean | null; detail: CheckDetail | { key: string; summary: string; error: true } }>();
  for (const key of new Set(tasks.map((t) => t.autoCheck).filter(isAutoCheckKey))) {
    try {
      outcomes.set(key, await runCheck(key, month));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`${key}: ${message}`);
      console.error(`close: the ${key} check for ${monthKeyOf(month)} failed`, err);
      outcomes.set(key, { ok: null, detail: { key, summary: `The check couldn't run: ${message}`, error: true } });
    }
  }

  for (const task of tasks) {
    if (!isAutoCheckKey(task.autoCheck)) continue;
    const outcome = outcomes.get(task.autoCheck)!;
    result.evaluated += 1;
    await db.closeTask.update({
      where: { id: task.id },
      data: { autoOk: outcome.ok, autoDetail: outcome.detail as unknown as Prisma.InputJsonValue, autoCheckedAt: now },
    });
    if (outcome.ok === true) {
      result.passed += 1;
      // Conditional, so a person who ticked or dismissed it a moment ago keeps what they chose.
      const ticked = await db.closeTask.updateMany({
        where: { id: task.id, status: "TODO" },
        data: { status: "DONE", doneAt: now, doneById: automation, note: withAutomaticNote(task.note) },
      });
      result.ticked += ticked.count;
    } else if (outcome.ok === false) {
      result.failed += 1;
      const unticked = await db.closeTask.updateMany({
        where: { id: task.id, status: "DONE", doneById: automation },
        data: { status: "TODO", doneAt: null, doneById: null },
      });
      result.unticked += unticked.count;
    }
  }
  return result;
}

/** The task's note with "Checked automatically" on it once. */
function withAutomaticNote(note: string | null): string {
  if (!note?.trim()) return CHECKED_AUTOMATICALLY;
  if (note.includes(CHECKED_AUTOMATICALLY)) return note;
  return `${note}\n\n${CHECKED_AUTOMATICALLY}`;
}

// ─── Reading a month ─────────────────────────────────────────────────────────────────────────

const taskSelect = {
  id: true, month: true, templateId: true, title: true, ownerId: true, dueOn: true, status: true, doneAt: true,
  doneById: true, note: true, autoCheck: true, autoOk: true, autoDetail: true, autoCheckedAt: true, createdAt: true,
  template: { select: { sortOrder: true, description: true } },
  owner: { select: { id: true, name: true } },
  doneBy: { select: { id: true, name: true, kind: true } },
  attachments: {
    orderBy: { createdAt: "asc" as const },
    select: { id: true, name: true, mimeType: true, sizeBytes: true, createdAt: true, uploadedBy: { select: { id: true, name: true } } },
  },
} satisfies Prisma.CloseTaskSelect;

export type CloseTaskRow = Prisma.CloseTaskGetPayload<{ select: typeof taskSelect }>;

/** The month's tasks in the templates' order, one-offs last. */
export async function monthTasks(month: Date): Promise<CloseTaskRow[]> {
  const tasks = await db.closeTask.findMany({ where: { month }, select: taskSelect });
  return tasks.sort(
    (a, b) =>
      (a.template?.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.template?.sortOrder ?? Number.MAX_SAFE_INTEGER) ||
      a.createdAt.getTime() - b.createdAt.getTime(),
  );
}

export type CloseProgress = { total: number; done: number; notApplicable: number; open: number; overdue: number; nextDue: Date | null };

export function progressOf(tasks: { status: CloseTaskStatus; dueOn: Date }[], today: Date): CloseProgress {
  const open = tasks.filter((t) => t.status === "TODO");
  const nextDue = open.map((t) => t.dueOn).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  return {
    total: tasks.length,
    done: tasks.filter((t) => t.status === "DONE").length,
    notApplicable: tasks.filter((t) => t.status === "NOT_APPLICABLE").length,
    open: open.length,
    overdue: open.filter((t) => t.dueOn.getTime() < today.getTime()).length,
    nextDue,
  };
}

/** Why the month can't be closed yet, in the order to fix them. `blockers` empty: it can. */
export async function closeBlockers(month: Date, now: Date): Promise<{ blockers: string[]; notFinished: boolean; earlier: Date | null; openTasks: number }> {
  const blockers: string[] = [];
  const notFinished = monthEnd(month).getTime() > indiaToday(now).getTime();
  if (notFinished) blockers.push(`${monthLabel(month)} hasn't finished yet.`);
  const earlier = await earlierOpenMonth(month);
  if (earlier) blockers.push(`Close ${monthLabel(earlier)} first.`);
  const openTasks = await db.closeTask.count({ where: { month, status: "TODO" } });
  if (openTasks > 0) blockers.push(`${openTasks} task${openTasks === 1 ? " is" : "s are"} still open.`);
  return { blockers, notFinished, earlier, openTasks };
}

/** Whether the books are locked through the whole of this month — closed, whatever its checklist says. */
async function lockedThrough(month: Date): Promise<boolean> {
  const lock = await db.ledgerLock.findUnique({ where: { id: "global" }, select: { lockedUntil: true } });
  return isLockedDate(monthEnd(month), lock?.lockedUntil);
}

/**
 * The earliest month before this one that has a checklist and isn't closed. A month the books are
 * locked through counts as closed: it can't hold up a later close.
 */
export async function earlierOpenMonth(month: Date): Promise<Date | null> {
  const withTasks = await db.closeTask.groupBy({ by: ["month"], where: { month: { lt: month } } });
  if (withTasks.length === 0) return null;
  const [closed, lock] = await Promise.all([
    db.closeMonth.findMany({ where: { month: { in: withTasks.map((t) => t.month) }, status: "CLOSED" }, select: { month: true } }),
    db.ledgerLock.findUnique({ where: { id: "global" }, select: { lockedUntil: true } }),
  ]);
  const closedKeys = new Set(closed.map((c) => c.month.getTime()));
  const open = withTasks
    .map((t) => t.month)
    .filter((m) => !closedKeys.has(m.getTime()) && !isLockedDate(monthEnd(m), lock?.lockedUntil))
    .sort((a, b) => a.getTime() - b.getTime());
  return open[0] ?? null;
}

// ─── Working the checklist ───────────────────────────────────────────────────────────────────

type TaskGuard = { ok: true; task: { id: string; month: Date; title: string; ownerId: string | null; note: string | null; status: CloseTaskStatus } } | { ok: false; error: string };

/** A task that can still be worked: it exists, and its month isn't closed. */
export async function workableTask(taskId: string): Promise<TaskGuard> {
  const task = await db.closeTask.findUnique({
    where: { id: taskId },
    select: { id: true, month: true, title: true, ownerId: true, note: true, status: true },
  });
  if (!task) return { ok: false, error: "That task no longer exists." };
  const month = await db.closeMonth.findUnique({ where: { month: task.month }, select: { status: true } });
  if (month?.status === "CLOSED") return { ok: false, error: `${monthLabel(task.month)} is closed. Reopen it to change its checklist.` };
  return { ok: true, task };
}

/** A person's note, appended under their name and the day. */
export function appendNote(existing: string | null, text: string, who: string, now: Date): string {
  const line = `${who}, ${formatIstDate(now)}: ${text.trim()}`;
  const next = existing?.trim() ? `${existing.trim()}\n\n${line}` : line;
  // Keep the newest if a task's notes ever grow past what the page should show.
  return next.length > 20000 ? next.slice(next.length - 20000) : next;
}

export async function writeTaskStatus(input: { taskId: string; status: CloseTaskStatus; note?: string | null; userId: string; userName: string; now?: Date }) {
  const now = input.now ?? new Date();
  const guard = await workableTask(input.taskId);
  if (!guard.ok) return guard;
  const note = input.note?.trim();
  if (input.status === "NOT_APPLICABLE" && !note) return { ok: false as const, error: "Say why it doesn't apply this month." };
  if (note && note.length > 2000) return { ok: false as const, error: "Keep the note under 2,000 characters." };
  await db.closeTask.update({
    where: { id: input.taskId },
    data: {
      status: input.status,
      doneAt: input.status === "TODO" ? null : now,
      doneById: input.status === "TODO" ? null : input.userId,
      ...(note ? { note: appendNote(guard.task.note, note, input.userName, now) } : {}),
    },
  });
  return { ok: true as const, task: guard.task };
}

export async function writeTaskOwner(input: { taskId: string; ownerId: string | null; userId: string }) {
  const guard = await workableTask(input.taskId);
  if (!guard.ok) return guard;
  if (input.ownerId) {
    const owner = await db.user.findFirst({ where: { id: input.ownerId, ...PEOPLE_ONLY, active: true }, select: { id: true } });
    if (!owner) return { ok: false as const, error: "Choose somebody active in this workspace." };
  }
  const task = await db.closeTask.update({
    where: { id: input.taskId },
    data: { ownerId: input.ownerId },
    select: { id: true, month: true, title: true, dueOn: true },
  });
  if (input.ownerId && input.ownerId !== input.userId && input.ownerId !== guard.task.ownerId) {
    await notifyOnce(input.ownerId, "TASK_ASSIGNED", task.month, task.id, {
      title: `Month-end close: ${task.title}`,
      message: `${monthLabel(task.month)} close · due ${formatIstDate(task.dueOn)}`,
    });
  }
  return { ok: true as const, task: guard.task };
}

export async function writeTaskNote(input: { taskId: string; text: string; userName: string; now?: Date }) {
  const guard = await workableTask(input.taskId);
  if (!guard.ok) return guard;
  const text = input.text.trim();
  if (!text) return { ok: false as const, error: "Write something first." };
  if (text.length > 2000) return { ok: false as const, error: "Keep the note under 2,000 characters." };
  await db.closeTask.update({ where: { id: input.taskId }, data: { note: appendNote(guard.task.note, text, input.userName, input.now ?? new Date()) } });
  return { ok: true as const, task: guard.task };
}

// ─── Telling people ──────────────────────────────────────────────────────────────────────────

/**
 * Sends a close notification unless this person already has one of this kind for this task — the
 * notification row is the memory, so "told once" survives restarts and needs no column of its own.
 */
async function notifyOnce(
  userId: string,
  type: NotificationType,
  month: Date,
  taskId: string,
  content: { title: string; message: string },
): Promise<boolean> {
  const link = closeTaskLink(month, taskId);
  const already = await db.notification.findFirst({ where: { userId, type, link }, select: { id: true } });
  if (already) return false;
  await notifyUser({ userId, type, title: content.title, message: content.message, link });
  return true;
}

/**
 * Owners of open tasks, told two days before a task falls due and once it is overdue — each once.
 * Months that are closed are left alone.
 */
export async function sendCloseNotifications(now: Date = new Date()): Promise<{ dueSoon: number; overdue: number }> {
  const today = indiaToday(now);
  const soon = addDays(today, 2);
  const closed = await db.closeMonth.findMany({ where: { status: "CLOSED" }, select: { month: true } });
  const tasks = await db.closeTask.findMany({
    where: {
      status: "TODO",
      ownerId: { not: null },
      dueOn: { lte: soon },
      ...(closed.length ? { month: { notIn: closed.map((c) => c.month) } } : {}),
    },
    select: { id: true, month: true, title: true, ownerId: true, dueOn: true },
  });
  let dueSoon = 0;
  let overdue = 0;
  for (const t of tasks) {
    const late = t.dueOn.getTime() < today.getTime();
    const sent = late
      ? await notifyOnce(t.ownerId!, "TASK_OVERDUE", t.month, t.id, {
          title: `Overdue: ${t.title}`,
          message: `${monthLabel(t.month)} close · was due ${formatIstDate(t.dueOn)}`,
        })
      : await notifyOnce(t.ownerId!, "TASK_DUE", t.month, t.id, {
          title: `Due ${dayKey(t.dueOn) === dayKey(today) ? "today" : formatIstDate(t.dueOn)}: ${t.title}`,
          message: `${monthLabel(t.month)} close`,
        });
    if (sent && late) overdue += 1;
    else if (sent) dueSoon += 1;
  }
  return { dueSoon, overdue };
}


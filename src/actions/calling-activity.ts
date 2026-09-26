"use server";

import { revalidatePath } from "next/cache";
import type { CallerAllocationMethod, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { canViewContacts } from "@/lib/authz/contact-access";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { toPlain } from "@/lib/serialize";
import { notifyUser } from "@/lib/notify";
import { buildWhere, type WorkbookFilters } from "@/lib/workspace/filters";
import { allocate, trackedGap } from "@/lib/workspace/allocation";
import type { ActionResult } from "@/actions/company";

/**
 * Turns a saved segment into a calling campaign.
 *
 * The rows are *frozen* at this moment: a live segment reshuffles as the data changes, which is
 * right for browsing and impossible to hand out as work — a caller can't be measured against a list
 * that grows underneath them, and two callers can't safely share one. Everything after this point
 * is about these records, not the filters.
 */
export async function startCallingActivity(input: {
  workbookId: string;
  callerIds: string[];
  method: CallerAllocationMethod;
  dueAt?: string;
  note?: string;
}): Promise<ActionResult<{ records: number; callers: number }>> {
  const user = await requireModuleUser("calls");

  const workbook = await db.workbook.findUnique({
    where: { id: input.workbookId },
    select: { id: true, name: true, ownerUserId: true, filters: true, mode: true },
  });
  if (!workbook) return { ok: false, error: "That list no longer exists." };
  if (workbook.ownerUserId !== user.id && !(await hasEffectivePermission(user.id, "workspace.manageAny"))) {
    return { ok: false, error: "Only the person who built this list can start a calling activity on it." };
  }
  if (workbook.mode === "COLD_CALLING") {
    return { ok: false, error: "This is already a calling activity. Re-share it instead to change who's working it." };
  }

  const callerIds = [...new Set(input.callerIds.filter(Boolean))];
  if (callerIds.length === 0) return { ok: false, error: "Pick at least one caller." };

  const dueAt = input.dueAt ? new Date(input.dueAt) : null;
  if (dueAt && Number.isNaN(dueAt.getTime())) return { ok: false, error: "That deadline isn't a valid date." };

  const companies = await db.company.findMany({
    where: buildWhere((workbook.filters ?? {}) as WorkbookFilters),
    orderBy: { name: "asc" },
    select: { id: true, ownerUserId: true },
  });
  if (companies.length === 0) {
    return { ok: false, error: "This list matches nothing right now. Loosen a filter before starting." };
  }

  const allocations = allocate(companies, callerIds, input.method);
  const byRecord = new Map(allocations.map((a) => [a.recordId, a]));

  await db.$transaction(async (tx) => {
    await tx.workbookRecord.createMany({
      data: companies.map((c) => ({
        workbookId: workbook.id,
        companyId: c.id,
        assignedToUserId: byRecord.get(c.id)?.userId ?? null,
        sortOrder: byRecord.get(c.id)?.sortOrder ?? 0,
      })),
      skipDuplicates: true,
    });

    await tx.workbook.update({
      where: { id: workbook.id },
      data: { mode: "COLD_CALLING", startedAt: new Date(), allocationMethod: input.method, dueAt },
    });

    // Each caller gets a task, so the work turns up where they already look rather than only on a
    // screen they have to remember to open.
    for (const userId of callerIds) {
      const share = allocations.filter((a) => a.userId === userId).length;
      const task = await tx.task.create({
        data: {
          title: `Call through ${workbook.name}`,
          description:
            `${share} compan${share === 1 ? "y" : "ies"} to call.` +
            (input.note?.trim() ? ` ${input.note.trim()}` : ""),
          dueDate: dueAt,
          assignedToUserId: userId,
          createdByUserId: user.id,
        },
        select: { id: true },
      });
      await tx.workbookAssignee.upsert({
        where: { workbookId_userId: { workbookId: workbook.id, userId } },
        create: {
          workbookId: workbook.id,
          userId,
          assignedByUserId: user.id,
          note: input.note?.trim() || null,
          dueAt,
          taskId: task.id,
        },
        update: { dueAt, taskId: task.id, note: input.note?.trim() || null },
      });
    }
  });

  for (const userId of callerIds) {
    const share = allocations.filter((a) => a.userId === userId).length;
    await notifyUser({
      userId,
      type: "TASK_ASSIGNED",
      title: "Calling list assigned to you",
      message: `${workbook.name} — ${share} to call${dueAt ? ` by ${dueAt.toLocaleDateString("en-IN")}` : ""}`,
      link: `/workspace/${workbook.id}/call`,
    });
  }

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Workbook",
    entityId: workbook.id,
    entityLabel: `Started calling activity: ${companies.length} records across ${callerIds.length} caller(s)`,
  });
  revalidatePath(`/workspace/${workbook.id}`);
  revalidatePath("/workspace");
  return { ok: true, data: { records: companies.length, callers: callerIds.length } };
}

/** Re-shares the records that haven't been worked yet, when the team changes mid-campaign. */
export async function redistributeActivity(input: {
  workbookId: string;
  callerIds: string[];
  method: CallerAllocationMethod;
}): Promise<ActionResult<{ moved: number }>> {
  const user = await requireModuleUser("calls");
  const workbook = await db.workbook.findUnique({
    where: { id: input.workbookId },
    select: { id: true, name: true, ownerUserId: true },
  });
  if (!workbook) return { ok: false, error: "That list no longer exists." };
  if (workbook.ownerUserId !== user.id && !(await hasEffectivePermission(user.id, "workspace.manageAny"))) {
    return { ok: false, error: "Only the person who built this list can re-share it." };
  }

  const callerIds = [...new Set(input.callerIds.filter(Boolean))];
  if (callerIds.length === 0) return { ok: false, error: "Pick at least one caller." };

  // Only untouched records move. Reassigning something already called would strip the caller who
  // did the work of the credit, and would make the timing figures meaningless.
  const open = await db.workbookRecord.findMany({
    where: { workbookId: workbook.id, status: "PENDING" },
    orderBy: { sortOrder: "asc" },
    select: { id: true, company: { select: { ownerUserId: true } } },
  });
  if (open.length === 0) return { ok: false, error: "Every record has been worked — there's nothing left to share out." };

  const allocations = allocate(
    open.map((r) => ({ id: r.id, ownerUserId: r.company.ownerUserId })),
    callerIds,
    input.method,
  );

  await db.$transaction(async (tx) => {
    for (const op of allocations.map((a) =>
      tx.workbookRecord.update({
        where: { id: a.recordId },
        data: { assignedToUserId: a.userId, sortOrder: a.sortOrder },
      }),
    )) await op;
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Workbook",
    entityId: workbook.id,
    entityLabel: `Re-shared ${allocations.length} unworked record(s)`,
  });
  revalidatePath(`/workspace/${workbook.id}`);
  return { ok: true, data: { moved: allocations.length } };
}

const queueSelect = {
  id: true,
  status: true,
  sortOrder: true,
  openedAt: true,
  completedAt: true,
  handleSeconds: true,
  gapSeconds: true,
  outcomeNote: true,
  company: {
    select: {
      id: true,
      name: true,
      website: true,
      employeeCount: true,
      industry: { select: { name: true } },
      locations: { orderBy: { isPrimary: "desc" as const }, take: 1, select: { city: true, state: true } },
      contacts: {
        orderBy: [{ isPrimary: "desc" as const }, { name: "asc" as const }],
        select: {
          id: true, name: true, designation: true, email: true, phone: true, isPrimary: true,
          // So the caller can see what is already known about the address before they spend the
          // call asking about one that was reported dead last week.
          emailStatus: true, emailCheckedValue: true, emailCheckedAt: true,
          emailCheckMethod: true, emailCheckDetail: true,
        },
      },
    },
  },
} satisfies Prisma.WorkbookRecordSelect;

/** One caller's queue: their records only, in their order, unworked first. */
export async function myCallingQueue(workbookId: string) {
  const user = await requireModuleUser("calls");
  const [workbook, records] = await Promise.all([
    db.workbook.findUnique({
      where: { id: workbookId },
      select: { id: true, name: true, description: true, mode: true, dueAt: true },
    }),
    db.workbookRecord.findMany({
      where: { workbookId, assignedToUserId: user.id },
      orderBy: [{ status: "asc" }, { sortOrder: "asc" }],
      select: queueSelect,
    }),
  ]);
  if (!workbook || workbook.mode !== "COLD_CALLING") return null;

  // Without `contacts.view` the queue still names who to ask for, but not how to reach them.
  if (!(await canViewContacts(user.id))) {
    for (const r of records) for (const c of r.company.contacts) Object.assign(c, { email: null, phone: null });
  }

  const done = records.filter((r) => r.status === "DONE" || r.status === "SKIPPED");
  const handled = done.map((r) => r.handleSeconds ?? 0).filter((n) => n > 0);
  const gaps = done.map((r) => r.gapSeconds ?? 0).filter((n) => n > 0);

  return toPlain({
    workbook,
    records,
    progress: {
      total: records.length,
      done: done.length,
      remaining: records.filter((r) => r.status === "PENDING" || r.status === "IN_PROGRESS").length,
      talkSeconds: handled.reduce((t, n) => t + n, 0),
      idleSeconds: gaps.reduce((t, n) => t + n, 0),
      averageHandleSeconds: handled.length > 0 ? Math.round(handled.reduce((t, n) => t + n, 0) / handled.length) : 0,
      averageGapSeconds: gaps.length > 0 ? Math.round(gaps.reduce((t, n) => t + n, 0) / gaps.length) : 0,
    },
  });
}

/**
 * Marks a record as being worked, and measures the gap since the last one was finished.
 *
 * The gap is computed here rather than on completion because this is the moment it's knowable —
 * the caller has just turned their attention to this record, and whatever happened before that was
 * time between calls.
 */
/**
 * The two record-level checks below are NOT converted to a permission, and that is deliberate.
 *
 * Both bodies compute per-caller timing from the ACTOR's own last completed record
 * (`assignedToUserId: user.id`), not the assignee's. A second person acting on somebody else's
 * record therefore writes a fabricated idle-time figure into that caller's row and takes the next
 * id from their own queue — silently, with no error and no audit trail, into the numbers callers
 * are paid on. The role check is accidentally the only thing keeping a second person out of a
 * per-caller measurement, so widening it to a grantable key would multiply the number of people
 * who can corrupt it. The legitimate need — somebody else must work this record — is served by
 * redistributeActivity, which reassigns it properly and is permission-gated above.
 */
export async function openRecord(recordId: string): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("calls");
  const record = await db.workbookRecord.findUnique({
    where: { id: recordId },
    select: { id: true, workbookId: true, assignedToUserId: true, status: true, openedAt: true },
  });
  if (!record) return { ok: false, error: "That record no longer exists." };
  if (record.assignedToUserId !== user.id && user.role !== "ADMIN") {
    return { ok: false, error: "That record is assigned to someone else." };
  }
  // Re-opening something already in progress keeps the original start, so glancing away and coming
  // back doesn't reset the clock and flatter the figures.
  if (record.status === "IN_PROGRESS" && record.openedAt) return { ok: true, data: { id: record.id } };

  const previous = await db.workbookRecord.findFirst({
    where: { workbookId: record.workbookId, assignedToUserId: user.id, completedAt: { not: null } },
    orderBy: { completedAt: "desc" },
    select: { completedAt: true },
  });

  const openedAt = new Date();
  await db.workbookRecord.update({
    where: { id: recordId },
    data: {
      status: "IN_PROGRESS",
      openedAt,
      gapSeconds: trackedGap(previous?.completedAt ?? null, openedAt),
    },
  });
  return { ok: true, data: { id: record.id } };
}

/** Finishes a record and records how long it took. */
export async function completeRecord(input: {
  recordId: string;
  status: "DONE" | "SKIPPED";
  note?: string;
  callId?: string;
}): Promise<ActionResult<{ nextId: string | null }>> {
  const user = await requireModuleUser("calls");
  const record = await db.workbookRecord.findUnique({
    where: { id: input.recordId },
    select: { id: true, workbookId: true, assignedToUserId: true, openedAt: true },
  });
  if (!record) return { ok: false, error: "That record no longer exists." };
  if (record.assignedToUserId !== user.id && user.role !== "ADMIN") {
    return { ok: false, error: "That record is assigned to someone else." };
  }

  const completedAt = new Date();
  // A record finished without ever being opened — someone marking it done from the list — has no
  // handle time rather than a fabricated zero.
  const handleSeconds = record.openedAt
    ? Math.max(0, Math.round((completedAt.getTime() - record.openedAt.getTime()) / 1000))
    : null;

  await db.workbookRecord.update({
    where: { id: record.id },
    data: {
      status: input.status,
      completedAt,
      handleSeconds,
      outcomeNote: input.note?.trim() || null,
      callId: input.callId ?? undefined,
    },
  });

  const next = await db.workbookRecord.findFirst({
    where: { workbookId: record.workbookId, assignedToUserId: user.id, status: "PENDING" },
    orderBy: { sortOrder: "asc" },
    select: { id: true },
  });

  // Finishing the last one closes the task, so nobody has to remember to tick it.
  if (!next) {
    const assignment = await db.workbookAssignee.findUnique({
      where: { workbookId_userId: { workbookId: record.workbookId, userId: user.id } },
      select: { taskId: true, completedAt: true },
    });
    if (assignment && !assignment.completedAt) {
      await db.workbookAssignee.update({
        where: { workbookId_userId: { workbookId: record.workbookId, userId: user.id } },
        data: { completedAt: new Date() },
      });
      if (assignment.taskId) {
        await db.task.update({ where: { id: assignment.taskId }, data: { done: true, doneAt: new Date() } });
      }
    }
  }

  revalidatePath(`/workspace/${record.workbookId}/call`);
  revalidatePath(`/workspace/${record.workbookId}`);
  return { ok: true, data: { nextId: next?.id ?? null } };
}

/**
 * The activity report: where each caller is, and how they're spending the time.
 *
 * Handle time and gap are reported separately because they mean different things — a slow day is
 * either long calls or long silences, and the fix is different for each.
 */
export async function activityReport(workbookId: string) {
  await requireModuleUser("calls");
  const [workbook, records] = await Promise.all([
    db.workbook.findUnique({
      where: { id: workbookId },
      select: {
        id: true, name: true, mode: true, dueAt: true, startedAt: true, allocationMethod: true,
        assignees: {
          select: {
            userId: true, dueAt: true, completedAt: true,
            user: { select: { id: true, name: true } },
            task: { select: { id: true, done: true, dueDate: true } },
          },
        },
      },
    }),
    db.workbookRecord.findMany({
      where: { workbookId },
      select: {
        status: true, assignedToUserId: true, handleSeconds: true, gapSeconds: true, completedAt: true,
        assignedTo: { select: { id: true, name: true } },
      },
    }),
  ]);
  if (!workbook) return null;

  const byCaller = new Map<string, { id: string; name: string; total: number; done: number; skipped: number; handle: number[]; gaps: number[]; lastAt: Date | null }>();
  for (const r of records) {
    if (!r.assignedTo) continue;
    const row =
      byCaller.get(r.assignedTo.id) ??
      { id: r.assignedTo.id, name: r.assignedTo.name, total: 0, done: 0, skipped: 0, handle: [], gaps: [], lastAt: null };
    row.total++;
    if (r.status === "DONE") row.done++;
    if (r.status === "SKIPPED") row.skipped++;
    if (r.handleSeconds) row.handle.push(r.handleSeconds);
    if (r.gapSeconds) row.gaps.push(r.gapSeconds);
    if (r.completedAt && (!row.lastAt || r.completedAt > row.lastAt)) row.lastAt = r.completedAt;
    byCaller.set(r.assignedTo.id, row);
  }

  const average = (values: number[]) => (values.length > 0 ? Math.round(values.reduce((t, n) => t + n, 0) / values.length) : 0);
  const sum = (values: number[]) => values.reduce((t, n) => t + n, 0);

  const callers = [...byCaller.values()]
    .map((c) => {
      const assignment = workbook.assignees.find((a) => a.userId === c.id);
      return {
        id: c.id,
        name: c.name,
        total: c.total,
        worked: c.done + c.skipped,
        done: c.done,
        skipped: c.skipped,
        remaining: c.total - c.done - c.skipped,
        talkSeconds: sum(c.handle),
        idleSeconds: sum(c.gaps),
        averageHandleSeconds: average(c.handle),
        averageGapSeconds: average(c.gaps),
        lastActivityAt: c.lastAt,
        dueAt: assignment?.dueAt ?? null,
        taskDone: assignment?.task?.done ?? false,
        finishedAt: assignment?.completedAt ?? null,
      };
    })
    .sort((a, b) => b.worked - a.worked);

  // Per-day, so "how did Tuesday go" is answerable without exporting anything.
  const byDay = new Map<string, { date: string; worked: number; talkSeconds: number }>();
  for (const r of records) {
    if (!r.completedAt) continue;
    const key = r.completedAt.toISOString().slice(0, 10);
    const row = byDay.get(key) ?? { date: key, worked: 0, talkSeconds: 0 };
    row.worked++;
    row.talkSeconds += r.handleSeconds ?? 0;
    byDay.set(key, row);
  }

  const worked = records.filter((r) => r.status === "DONE" || r.status === "SKIPPED").length;
  return toPlain({
    workbook,
    callers,
    days: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
    totals: {
      records: records.length,
      worked,
      remaining: records.length - worked,
      talkSeconds: sum(records.map((r) => r.handleSeconds ?? 0)),
      idleSeconds: sum(records.map((r) => r.gapSeconds ?? 0)),
      averageHandleSeconds: average(records.map((r) => r.handleSeconds ?? 0).filter((n) => n > 0)),
      averageGapSeconds: average(records.map((r) => r.gapSeconds ?? 0).filter((n) => n > 0)),
    },
  });
}

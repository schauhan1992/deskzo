"use server";

import { revalidatePath } from "next/cache";
import type { LeaveStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { toPlain } from "@/lib/serialize";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { notMigratedYet } from "@/lib/not-migrated";
import { hasEffectivePermission } from "@/actions/permission";
import { getDownlineUserIds } from "@/lib/org-chart";
import { closedDates, dateOnly, isWeekOff, monthRange, toKey } from "@/lib/hr/calendar";
import { workspaceClock } from "@/lib/time/workspace";
import { officeHours } from "@/lib/hr/office-hours";
import { leaveDecisionSchema } from "@/lib/validation/hr";
import {
  DEFAULT_SHORT_LEAVE_POLICY,
  draftOrRefusal,
  limitsRefusal,
  policyOrRefusal,
  spanWords,
  type ShortLeaveDraft,
  type ShortLeavePolicy,
} from "@/lib/hr/short-leave-rules";
import type { ActionResult } from "@/actions/company";

/**
 * Short leave by the hour (owner, 18 Oct 2026): asking for it, deciding it, and the company's rules.
 * The rules themselves are src/lib/hr/short-leave-rules.ts; the attendance month reads the approved
 * ones to clear the Late and Left early marks they cover.
 */

const LIVE = ["PENDING", "APPROVED"] as const;

/** The company's rules, the defaults while nobody has set them, or null while the tables aren't there. */
async function policy(): Promise<ShortLeavePolicy | null> {
  try {
    const row = await db.shortLeavePolicy.findUnique({ where: { id: "global" } });
    return row ? { maxMinutes: row.maxMinutes, perMonth: row.perMonth } : DEFAULT_SHORT_LEAVE_POLICY;
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

/** Their own manager, or somebody holding the blanket approval permission — never themselves, as leave. */
async function canDecide(deciderId: string, requesterId: string) {
  if (deciderId === requesterId) return false;
  if (await hasEffectivePermission(deciderId, "hr.approveLeave")) return true;
  return (await getDownlineUserIds(deciderId)).includes(requesterId);
}

export async function applyForShortLeave(input: ShortLeaveDraft): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("hr");
  const rules = await policy();
  if (!rules) return { ok: false, error: "Short leave isn't set up in this workspace yet." };
  const clock = await workspaceClock();
  const today = clock.today();
  const hours = await officeHours();

  const parsed = draftOrRefusal(input, { today, policy: rules, hours });
  if (!parsed.ok) return parsed;
  const { date, fromMinute, toMinute, reason } = parsed.value;
  const day = dateOnly(date);

  const [holidays, leave] = await Promise.all([
    db.holiday.findMany({ where: { date: day }, select: { date: true, optional: true } }),
    db.leaveRequest.findFirst({
      where: { userId: user.id, status: { in: [...LIVE] }, fromDate: { lte: day }, toDate: { gte: day } },
      select: { id: true },
    }),
  ]);
  const offDay = isWeekOff(day) ? ("week off" as const) : closedDates(holidays).has(date) ? ("holiday" as const) : null;
  const { from, to } = monthRange(day.getUTCFullYear(), day.getUTCMonth() + 1);

  // The count and the insert under one lock per person: two requests sent at once would otherwise
  // both see one left.
  const outcome = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`deskzo:short-leave:${user.id}`}))`;
    const [sameDay, usedInMonth] = await Promise.all([
      tx.shortLeaveRequest.findFirst({ where: { userId: user.id, date: day, status: { in: [...LIVE] } }, select: { id: true } }),
      tx.shortLeaveRequest.count({ where: { userId: user.id, status: { in: [...LIVE] }, date: { gte: from, lte: to } } }),
    ]);
    const refusal = limitsRefusal({ date, today, perMonth: rules.perMonth, offDay, onLeave: !!leave, sameDay: !!sameDay, usedInMonth });
    if (refusal) return { ok: false as const, error: refusal };
    const me = await tx.user.findUnique({ where: { id: user.id }, select: { managerId: true, name: true } });
    const created = await tx.shortLeaveRequest.create({
      data: { userId: user.id, date: day, fromMinute, toMinute, reason, approverId: me?.managerId ?? null },
      select: { id: true },
    });
    return { ok: true as const, id: created.id, managerId: me?.managerId ?? null, name: me?.name ?? user.name };
  });
  if (!outcome.ok) return outcome;

  const words = `${clock.date(day)}, ${spanWords({ fromMinute, toMinute })}`;
  if (outcome.managerId) {
    await notifyUser({
      userId: outcome.managerId,
      type: "LEAVE_REQUESTED",
      title: "Short leave request",
      message: `${outcome.name} has asked for a short leave on ${words}.`,
      link: "/people/leave#short-leave",
      // Not on the Deskzo app's Approvals screen (src/lib/app/daily.ts), so not pushed to an iPhone as if it were.
      awaitsDecision: false,
    });
  }
  await recordAudit({ userId: user.id, action: "CREATE", entityType: "ShortLeaveRequest", entityId: outcome.id, entityLabel: `Short leave ${words}` });
  revalidatePath("/people/leave");
  revalidatePath("/people/attendance");
  return { ok: true, data: { id: outcome.id } };
}

export async function decideShortLeave(input: unknown): Promise<ActionResult<null>> {
  const user = await requireModuleUser("hr");
  const parsed = leaveDecisionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { id, approve, note } = parsed.data;

  const request = await db.shortLeaveRequest.findUnique({ where: { id }, include: { user: { select: { name: true } } } });
  if (!request) return { ok: false, error: "That request no longer exists." };
  if (request.status !== "PENDING") return { ok: false, error: `That request was already ${request.status.toLowerCase()}.` };
  if (!(await canDecide(user.id, request.userId))) return { ok: false, error: "You can't decide this request." };

  // Only while it's still pending, so two approvers at once can't both decide it.
  const decided = await db.shortLeaveRequest.updateMany({
    where: { id, status: "PENDING" },
    data: { status: approve ? "APPROVED" : "REJECTED", approverId: user.id, decidedAt: new Date(), decisionNote: note?.trim() || null },
  });
  if (decided.count === 0) return { ok: false, error: "Somebody decided it a moment ago." };

  const clock = await workspaceClock();
  const words = `${clock.date(request.date)}, ${spanWords(request)}`;
  await notifyUser({
    userId: request.userId,
    type: "LEAVE_DECIDED",
    title: `Short leave ${approve ? "approved" : "rejected"}`,
    message: `${user.name} ${approve ? "approved" : "rejected"} your short leave on ${words}${note ? `: ${note}` : "."}`,
    link: "/people/leave#short-leave",
  });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "ShortLeaveRequest",
    entityId: id,
    entityLabel: `${approve ? "Approved" : "Rejected"} short leave ${words} for ${request.user.name}`,
  });
  revalidatePath("/people/leave");
  revalidatePath("/people/attendance");
  return { ok: true, data: null };
}

/**
 * Withdrawing one's own. A pending request can always be withdrawn; an approved one only before its
 * day — after that it has excused a mark somebody may have read, and undoing it is HR's correction.
 */
export async function cancelShortLeave(id: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("hr");
  const request = await db.shortLeaveRequest.findUnique({ where: { id } });
  if (!request) return { ok: false, error: "That request no longer exists." };
  if (request.userId !== user.id) return { ok: false, error: "That isn't your request." };
  if (request.status !== "PENDING" && request.status !== "APPROVED") return { ok: false, error: `It's already ${request.status.toLowerCase()}.` };
  const clock = await workspaceClock();
  if (request.status === "APPROVED" && toKey(request.date) <= clock.today()) {
    return { ok: false, error: "That short leave's day has come — ask HR to correct it." };
  }
  await db.shortLeaveRequest.update({ where: { id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "ShortLeaveRequest",
    entityId: id,
    entityLabel: `Withdrew short leave ${clock.date(request.date)}, ${spanWords(request)}`,
  });
  revalidatePath("/people/leave");
  revalidatePath("/people/attendance");
  return { ok: true, data: null };
}

/** The company's rules, set by whoever manages HR. */
export async function saveShortLeavePolicy(input: { maxMinutes: unknown; perMonth: unknown }): Promise<ActionResult<ShortLeavePolicy>> {
  const user = await requireModuleUser("hr");
  if (!(await hasEffectivePermission(user.id, "hr.manage"))) return { ok: false, error: "Only whoever manages HR can change the short leave rules." };
  const parsed = policyOrRefusal(input);
  if (!parsed.ok) return parsed;
  const data = { ...parsed.policy, updatedById: user.id };
  await db.shortLeavePolicy.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "ShortLeavePolicy",
    entityId: "global",
    entityLabel: `Short leave up to ${parsed.policy.maxMinutes} minutes, ${parsed.policy.perMonth} a month`,
  });
  revalidatePath("/people/leave");
  return { ok: true, data: parsed.policy };
}

const requestSelect = {
  id: true,
  date: true,
  fromMinute: true,
  toMinute: true,
  reason: true,
  status: true,
  decidedAt: true,
  decisionNote: true,
  user: { select: { id: true, userSeq: true, name: true } },
  approver: { select: { id: true, name: true } },
} as const;

/**
 * Everything the leave page's short-leave panel shows: the rules, the month's count, the signed-in
 * person's requests from this month on, and what waits on them. Null while the tables aren't there.
 */
export async function shortLeaveOverview() {
  const user = await requireModuleUser("hr");
  const rules = await policy();
  if (!rules) return null;
  const clock = await workspaceClock();
  const today = clock.today();
  const { from, to } = monthRange(Number(today.slice(0, 4)), Number(today.slice(5, 7)));

  const [canApproveAnyone, downline, canManage, hours] = await Promise.all([
    hasEffectivePermission(user.id, "hr.approveLeave"),
    getDownlineUserIds(user.id),
    hasEffectivePermission(user.id, "hr.manage"),
    officeHours(),
  ]);
  const scope = canApproveAnyone ? { userId: { not: user.id } } : { userId: { in: downline } };

  const [mine, usedThisMonth, pending, recent] = await Promise.all([
    db.shortLeaveRequest.findMany({ where: { userId: user.id, date: { gte: from } }, orderBy: { date: "asc" }, take: 50, select: requestSelect }),
    db.shortLeaveRequest.count({ where: { userId: user.id, status: { in: [...LIVE] }, date: { gte: from, lte: to } } }),
    db.shortLeaveRequest.findMany({ where: { ...scope, status: "PENDING" }, orderBy: { date: "asc" }, select: requestSelect }),
    db.shortLeaveRequest.findMany({ where: { ...scope, status: { in: ["APPROVED", "REJECTED"] } }, orderBy: { decidedAt: "desc" }, take: 10, select: requestSelect }),
  ]);
  return toPlain({ policy: rules, usedThisMonth, mine, pending, recent, canManage, hours, today });
}

export type ShortLeaveFilters = {
  status?: string;
  userId?: string;
  departmentId?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
};

/**
 * Everybody's short leave the viewer may see, as leave's register is (owner, 21 Oct 2026: HR had only
 * what was waiting and the last ten decided): everyone's for HR — `hr.viewAll` or `hr.manage` — their
 * own and their team's for anybody else. Newest first; null while the tables aren't there.
 */
export async function allShortLeaves(filters?: ShortLeaveFilters) {
  const user = await requireModuleUser("hr");
  if (!(await policy())) return null;
  const everyone = (await hasEffectivePermission(user.id, "hr.viewAll")) || (await hasEffectivePermission(user.id, "hr.manage"));
  const allowed = everyone ? null : [user.id, ...(await getDownlineUserIds(user.id))];
  const statuses = ["PENDING", "APPROVED", "REJECTED", "CANCELLED"];
  const where = {
    ...(allowed ? { userId: { in: allowed } } : {}),
    ...(filters?.status && statuses.includes(filters.status) ? { status: filters.status as LeaveStatus } : {}),
    ...(filters?.userId ? { userId: allowed && !allowed.includes(filters.userId) ? "__nobody__" : filters.userId } : {}),
    ...(filters?.departmentId ? { user: { departmentId: filters.departmentId } } : {}),
    ...(filters?.from || filters?.to
      ? { date: { ...(filters?.from ? { gte: dateOnly(filters.from) } : {}), ...(filters?.to ? { lte: dateOnly(filters.to) } : {}) } }
      : {}),
  };
  const page = filters?.page ?? 1;
  const pageSize = filters?.pageSize ?? 50;
  const [rows, total, pendingCount] = await Promise.all([
    db.shortLeaveRequest.findMany({ where, orderBy: [{ date: "desc" }, { fromMinute: "desc" }], skip: (page - 1) * pageSize, take: pageSize, select: requestSelect }),
    db.shortLeaveRequest.count({ where }),
    db.shortLeaveRequest.count({ where: { ...where, status: "PENDING" } }),
  ]);
  return { rows: toPlain(rows), total, pendingCount, everyone };
}

"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { toPlain } from "@/lib/serialize";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { hasEffectivePermission } from "@/actions/permission";
import { getDownlineUserIds } from "@/lib/org-chart";
import { addDays, countLeaveDays, dateOnly, eachDay, financialYearOf, toKey } from "@/lib/hr/calendar";
import { workspaceClock } from "@/lib/time/workspace";
import { leaveDecisionSchema, leaveRequestSchema } from "@/lib/validation/hr";
import type { ActionResult } from "@/actions/company";

/**
 * Applying for leave, approving it, and keeping the balances honest.
 *
 * The rule that shapes everything here: a balance only moves when a request is approved. A pending
 * request shows as pending and nothing else, because deducting on submission means a rejected
 * request has to be refunded, and every refund path is a chance to lose half a day that somebody
 * will notice at the end of the year.
 */

const n = (value: Prisma.Decimal | number) => Number(value);

async function visibleUserIds(userId: string): Promise<string[] | null> {
  if (await hasEffectivePermission(userId, "hr.viewAll")) return null;
  if (await hasEffectivePermission(userId, "hr.manage")) return null;
  return [userId, ...(await getDownlineUserIds(userId))];
}

/**
 * Who may decide this request.
 *
 * Their own manager, or somebody holding the blanket approval permission. Never themselves — a
 * system where you approve your own leave is a spreadsheet with extra steps.
 */
async function canDecide(deciderId: string, requesterId: string) {
  if (deciderId === requesterId) return false;
  if (await hasEffectivePermission(deciderId, "hr.approveLeave")) return true;
  const downline = await getDownlineUserIds(deciderId);
  return downline.includes(requesterId);
}

// ─── Balances ─────────────────────────────────────────────────────────────────

/**
 * The balance row for one person, type and year, created on first use.
 *
 * Credited is filled from the type's quota — the whole thing for an annual grant, or a twelfth per
 * elapsed month for one that accrues. Accrual is computed rather than run by a scheduled job,
 * because this app has no scheduler and a balance that silently depends on a cron having fired is
 * worse than one that is worked out when somebody looks at it.
 *
 * `today` is the workspace's day, as a `@db.Date` holds it — `clock.calendarDate(new Date())`. The
 * UTC day credited a month's accrual five and a half hours late in India.
 */
async function ensureBalance(userId: string, typeId: string, year: number, today: Date) {
  const existing = await db.leaveBalance.findUnique({
    where: { userId_typeId_year: { userId, typeId, year } },
  });
  const type = await db.leaveType.findUnique({ where: { id: typeId } });
  if (!type) return null;

  const credited = accruedTo(type, year, today);
  if (!existing) {
    return db.leaveBalance.create({
      data: { userId, typeId, year, credited: new Prisma.Decimal(credited), opening: new Prisma.Decimal(0) },
    });
  }
  // Top up as months pass, never down — taking back leave somebody has already been granted (and
  // may already have booked) because a quota was edited mid-year is not something to do silently.
  if (credited > n(existing.credited)) {
    return db.leaveBalance.update({
      where: { id: existing.id },
      data: { credited: new Prisma.Decimal(credited) },
    });
  }
  return existing;
}

function accruedTo(type: { annualQuota: Prisma.Decimal; accrual: string }, year: number, on: Date) {
  const quota = n(type.annualQuota);
  if (type.accrual === "ANNUAL") return quota;
  // The financial year starts in April, so April is month 1 of 12.
  const fyStart = new Date(Date.UTC(year, 3, 1));
  if (on < fyStart) return 0;
  const months = Math.min(12, (on.getUTCFullYear() - year) * 12 + (on.getUTCMonth() - 3) + 1);
  return Math.round((quota / 12) * months * 100) / 100;
}

export type BalanceRow = {
  typeId: string;
  code: string;
  name: string;
  paid: boolean;
  opening: number;
  credited: number;
  used: number;
  adjustment: number;
  available: number;
  /** Days sitting in requests nobody has decided yet. */
  pending: number;
};

export async function leaveBalances(userId: string, year?: number): Promise<BalanceRow[]> {
  const user = await requireModuleUser("hr");
  const allowed = await visibleUserIds(user.id);
  if (allowed && !allowed.includes(userId)) return [];

  const today = (await workspaceClock()).calendarDate(new Date());
  const fy = year ?? financialYearOf(today);
  const types = await db.leaveType.findMany({ where: { active: true }, orderBy: [{ sortOrder: "asc" }, { code: "asc" }] });

  const rows: BalanceRow[] = [];
  for (const type of types) {
    const balance = await ensureBalance(userId, type.id, fy, today);
    if (!balance) continue;
    const pendingAgg = await db.leaveRequest.aggregate({
      where: { userId, typeId: type.id, status: "PENDING" },
      _sum: { days: true },
    });
    const opening = n(balance.opening);
    const credited = n(balance.credited);
    const used = n(balance.used);
    const adjustment = n(balance.adjustment);
    rows.push({
      typeId: type.id,
      code: type.code,
      name: type.name,
      paid: type.paid,
      opening,
      credited,
      used,
      adjustment,
      available: Math.round((opening + credited + adjustment - used) * 100) / 100,
      pending: n(pendingAgg._sum.days ?? 0),
    });
  }
  return rows;
}

// ─── Applying ─────────────────────────────────────────────────────────────────

/** What a span would cost, before anyone commits to it — drives the live count on the form. */
export async function previewLeaveDays(input: {
  fromDate: string;
  toDate: string;
  fromHalfDay?: boolean;
  toHalfDay?: boolean;
}) {
  await requireModuleUser("hr");
  if (!input.fromDate || !input.toDate) return { days: 0, skipped: [] as { date: string; why: string }[] };
  if (new Date(input.toDate) < new Date(input.fromDate)) return { days: 0, skipped: [] };

  const holidays = await db.holiday.findMany({
    where: { date: { gte: dateOnly(input.fromDate), lte: dateOnly(input.toDate) } },
    select: { date: true, optional: true },
  });
  const counted = countLeaveDays(
    { from: input.fromDate, to: input.toDate, fromHalfDay: input.fromHalfDay, toHalfDay: input.toHalfDay },
    holidays,
  );
  return { days: counted.days, skipped: counted.skipped };
}

export async function applyForLeave(input: unknown): Promise<ActionResult<{ id: string; days: number }>> {
  const user = await requireModuleUser("hr");
  const parsed = leaveRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;

  const type = await db.leaveType.findUnique({ where: { id: data.typeId } });
  if (!type || !type.active) return { ok: false, error: "That leave type is no longer available." };

  const holidays = await db.holiday.findMany({
    where: { date: { gte: dateOnly(data.fromDate), lte: dateOnly(data.toDate) } },
    select: { date: true, optional: true },
  });
  const counted = countLeaveDays(
    { from: data.fromDate, to: data.toDate, fromHalfDay: data.fromHalfDay, toHalfDay: data.toHalfDay },
    holidays,
  );
  if (counted.days <= 0) {
    return { ok: false, error: "Those dates are all weekends or holidays — there's no leave to take." };
  }

  // Overlap is checked against approved *and* pending requests: two pending applications for the
  // same week would both pass a balance check and then both be approved by different people.
  const clash = await db.leaveRequest.findFirst({
    where: {
      userId: user.id,
      status: { in: ["PENDING", "APPROVED"] },
      fromDate: { lte: dateOnly(data.toDate) },
      toDate: { gte: dateOnly(data.fromDate) },
    },
    select: { fromDate: true, toDate: true, status: true },
  });
  if (clash) {
    return {
      ok: false,
      error: `You already have ${clash.status.toLowerCase()} leave covering ${toKey(clash.fromDate)} to ${toKey(clash.toDate)}.`,
    };
  }

  // Unpaid leave has no balance to run out of, so it is never blocked — it costs pay instead.
  if (type.paid) {
    const fy = financialYearOf(data.fromDate);
    const balances = await leaveBalances(user.id, fy);
    const row = balances.find((b) => b.typeId === type.id);
    const remaining = (row?.available ?? 0) - (row?.pending ?? 0);
    if (counted.days > remaining) {
      return {
        ok: false,
        error: `That's ${counted.days} day(s) but you have ${Math.max(remaining, 0)} left of ${type.name}${(row?.pending ?? 0) > 0 ? ` (${row?.pending} already awaiting approval)` : ""}.`,
      };
    }
  }

  const approver = await db.user.findUnique({ where: { id: user.id }, select: { managerId: true, name: true } });

  const created = await db.leaveRequest.create({
    data: {
      userId: user.id,
      typeId: type.id,
      fromDate: dateOnly(data.fromDate),
      toDate: dateOnly(data.toDate),
      fromHalfDay: data.fromHalfDay,
      toHalfDay: data.toHalfDay,
      days: new Prisma.Decimal(counted.days),
      reason: data.reason.trim(),
      approverId: approver?.managerId ?? null,
    },
    select: { id: true },
  });

  if (approver?.managerId) {
    await notifyUser({
      userId: approver.managerId,
      type: "LEAVE_REQUESTED",
      title: "Leave request",
      message: `${approver.name} has applied for ${counted.days} day(s) of ${type.name} from ${data.fromDate}.`,
      link: "/people/leave?view=approvals",
    });
  }

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "LeaveRequest",
    entityId: created.id,
    entityLabel: `${counted.days} day(s) ${type.code} from ${data.fromDate}`,
  });
  revalidatePath("/people/leave");
  return { ok: true, data: { id: created.id, days: counted.days } };
}

/**
 * Approving or rejecting.
 *
 * The balance moves and the attendance days are written in one transaction with the decision, so
 * there is no window in which a request is approved but the days it consumed are not recorded.
 */
export async function decideLeave(input: unknown): Promise<ActionResult<null>> {
  const user = await requireModuleUser("hr");
  const parsed = leaveDecisionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { id, approve, note } = parsed.data;

  const request = await db.leaveRequest.findUnique({
    where: { id },
    include: { type: true, user: { select: { id: true, name: true } } },
  });
  if (!request) return { ok: false, error: "That request no longer exists." };
  if (request.status !== "PENDING") {
    return { ok: false, error: `That request was already ${request.status.toLowerCase()}.` };
  }
  if (!(await canDecide(user.id, request.userId))) {
    return { ok: false, error: "You can't decide this request." };
  }

  const days = n(request.days);
  const fy = financialYearOf(request.fromDate);

  if (approve) {
    await ensureBalance(request.userId, request.typeId, fy, (await workspaceClock()).calendarDate(new Date()));

    const holidays = await db.holiday.findMany({
      where: { date: { gte: request.fromDate, lte: request.toDate } },
      select: { date: true, optional: true },
    });
    const counted = countLeaveDays(
      { from: request.fromDate, to: request.toDate, fromHalfDay: request.fromHalfDay, toHalfDay: request.toHalfDay },
      holidays,
    );
    const workingSet = new Set(counted.workingDates);

    await db.$transaction(async (tx) => {
      await tx.leaveRequest.update({
        where: { id },
        data: { status: "APPROVED", approverId: user.id, decidedAt: new Date(), decisionNote: note?.trim() || null },
      });
      for (const op of (request.type.paid
        ? [
            tx.leaveBalance.update({
              where: { userId_typeId_year: { userId: request.userId, typeId: request.typeId, year: fy } },
              data: { used: { increment: new Prisma.Decimal(days) } },
            }),
          ]
        : [])) await op;
      for (const op of eachDay(request.fromDate, request.toDate)
        .filter((d) => workingSet.has(toKey(d)))
        .map((d) =>
          tx.attendanceDay.upsert({
            where: { userId_date: { userId: request.userId, date: d } },
            create: {
              userId: request.userId,
              date: d,
              status: halfDayOn(d, request) ? "HALF_DAY" : "ON_LEAVE",
              leaveRequestId: id,
            },
            update: {
              status: halfDayOn(d, request) ? "HALF_DAY" : "ON_LEAVE",
              leaveRequestId: id,
            },
          }),
        )) await op;
    });
  } else {
    await db.leaveRequest.update({
      where: { id },
      data: { status: "REJECTED", approverId: user.id, decidedAt: new Date(), decisionNote: note?.trim() || null },
    });
  }

  await notifyUser({
    userId: request.userId,
    type: "LEAVE_DECIDED",
    title: `Leave ${approve ? "approved" : "rejected"}`,
    message: `${user.name} ${approve ? "approved" : "rejected"} your ${days} day(s) of ${request.type.name}${note ? `: ${note}` : "."}`,
    link: "/people/leave",
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "LeaveRequest",
    entityId: id,
    entityLabel: `${approve ? "Approved" : "Rejected"} ${days} day(s) ${request.type.code} for ${request.user.name}`,
  });
  revalidatePath("/people/leave");
  revalidatePath("/people/attendance");
  return { ok: true, data: null };
}

function halfDayOn(day: Date, request: { fromDate: Date; toDate: Date; fromHalfDay: boolean; toHalfDay: boolean }) {
  const key = toKey(day);
  if (request.fromHalfDay && key === toKey(request.fromDate)) return true;
  if (request.toHalfDay && key === toKey(request.toDate)) return true;
  return false;
}

/**
 * Withdrawing a request.
 *
 * Allowed after approval as well as before, because plans change — but only for leave that has not
 * started. Cancelling days already taken would mean unwinding attendance somebody has been paid
 * against, which is an HR correction, not a self-service action.
 */
export async function cancelLeave(id: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("hr");
  const request = await db.leaveRequest.findUnique({ where: { id }, include: { type: true } });
  if (!request) return { ok: false, error: "That request no longer exists." };
  if (request.userId !== user.id) return { ok: false, error: "That isn't your request." };
  if (request.status === "CANCELLED") return { ok: false, error: "It's already cancelled." };
  if (request.status === "REJECTED") return { ok: false, error: "A rejected request can't be cancelled." };

  // The workspace's today; UTC's was still yesterday until 05:30 in India.
  const today = (await workspaceClock()).calendarDate(new Date());
  if (request.fromDate <= today) {
    return { ok: false, error: "That leave has already started — ask HR to correct it." };
  }

  const wasApproved = request.status === "APPROVED";
  const fy = financialYearOf(request.fromDate);

  await db.$transaction(async (tx) => {
    await tx.leaveRequest.update({ where: { id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    for (const op of (wasApproved && request.type.paid
      ? [
          tx.leaveBalance.update({
            where: { userId_typeId_year: { userId: request.userId, typeId: request.typeId, year: fy } },
            data: { used: { decrement: request.days } },
          }),
        ]
      : [])) await op;
    for (const op of (wasApproved ? [tx.attendanceDay.deleteMany({ where: { leaveRequestId: id } })] : [])) await op;
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "LeaveRequest",
    entityId: id,
    entityLabel: `Cancelled ${n(request.days)} day(s) ${request.type.code}`,
  });
  revalidatePath("/people/leave");
  revalidatePath("/people/attendance");
  return { ok: true, data: null };
}

// ─── Reading ──────────────────────────────────────────────────────────────────

const requestSelect = {
  id: true,
  fromDate: true,
  toDate: true,
  fromHalfDay: true,
  toHalfDay: true,
  days: true,
  reason: true,
  status: true,
  decidedAt: true,
  decisionNote: true,
  createdAt: true,
  type: { select: { id: true, code: true, name: true, paid: true } },
  user: { select: { id: true, userSeq: true, name: true } },
  approver: { select: { id: true, name: true } },
} satisfies Prisma.LeaveRequestSelect;

export type LeaveFilters = {
  status?: string;
  typeId?: string;
  userId?: string;
  departmentId?: string;
  from?: string;
  to?: string;
};

/**
 * Turns the filter bar into a where clause.
 *
 * Dates are treated as an overlap rather than a containment: a request running 28 August to
 * 2 September belongs in a search for August, and asking whether it *starts* in August would
 * quietly drop exactly the requests somebody is looking for.
 */
function leaveWhere(filters?: LeaveFilters): Prisma.LeaveRequestWhereInput {
  return {
    ...(filters?.status ? { status: filters.status as never } : {}),
    ...(filters?.typeId ? { typeId: filters.typeId } : {}),
    ...(filters?.userId ? { userId: filters.userId } : {}),
    ...(filters?.departmentId ? { user: { departmentId: filters.departmentId } } : {}),
    ...(filters?.from ? { toDate: { gte: dateOnly(filters.from) } } : {}),
    ...(filters?.to ? { fromDate: { lte: dateOnly(filters.to) } } : {}),
  };
}

export async function myLeaveRequests(filters?: LeaveFilters) {
  const user = await requireModuleUser("hr");
  return toPlain(
    await db.leaveRequest.findMany({
      where: { ...leaveWhere(filters), userId: user.id },
      orderBy: { fromDate: "desc" },
      take: 100,
      select: requestSelect,
    }),
  );
}

/**
 * Everybody's leave, for HR and managers — the view that was missing entirely.
 *
 * Scoped through the same `visibleUserIds` as every other leave read, so a manager sees their team
 * and HR sees the company; the filters narrow that, they never widen it.
 */
export async function allLeaveRequests(filters?: LeaveFilters & { page?: number; pageSize?: number }) {
  const user = await requireModuleUser("hr");
  const allowed = await visibleUserIds(user.id);
  const where: Prisma.LeaveRequestWhereInput = {
    ...leaveWhere(filters),
    ...(allowed ? { userId: { in: allowed } } : {}),
  };
  const page = filters?.page ?? 1;
  const pageSize = filters?.pageSize ?? 50;

  const [rows, total, pendingCount] = await Promise.all([
    db.leaveRequest.findMany({
      where,
      orderBy: { fromDate: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: requestSelect,
    }),
    db.leaveRequest.count({ where }),
    db.leaveRequest.count({ where: { ...where, status: "PENDING" } }),
  ]);
  return { rows: toPlain(rows), total, pendingCount };
}

/** Requests waiting on this user, plus what they have decided recently. */
export async function leaveApprovalQueue(filters?: LeaveFilters) {
  const user = await requireModuleUser("hr");
  const canApproveAnyone = await hasEffectivePermission(user.id, "hr.approveLeave");
  const downline = await getDownlineUserIds(user.id);
  // Never your own, whatever else is true.
  const scope = canApproveAnyone ? { userId: { not: user.id } } : { userId: { in: downline } };
  // The status filter belongs to the list below, not to the queue — a queue of approved requests
  // is not a queue. Everything else narrows it as expected.
  const narrowed = { ...leaveWhere(filters), status: undefined };

  const [pending, recent] = await Promise.all([
    db.leaveRequest.findMany({ where: { ...narrowed, ...scope, status: "PENDING" }, orderBy: { fromDate: "asc" }, select: requestSelect }),
    db.leaveRequest.findMany({
      where: { ...scope, status: { in: ["APPROVED", "REJECTED"] } },
      orderBy: { decidedAt: "desc" },
      take: 15,
      select: requestSelect,
    }),
  ]);
  return { pending: toPlain(pending), recent: toPlain(recent) };
}

/** Who is off, for the next few weeks — the thing a manager actually plans around. */
export async function upcomingLeave(days = 30) {
  const user = await requireModuleUser("hr");
  const allowed = await visibleUserIds(user.id);
  const from = (await workspaceClock()).calendarDate(new Date());
  const to = addDays(from, days);

  return toPlain(
    await db.leaveRequest.findMany({
      where: {
        ...(allowed ? { userId: { in: allowed } } : {}),
        status: "APPROVED",
        toDate: { gte: from },
        fromDate: { lte: to },
      },
      orderBy: { fromDate: "asc" },
      select: requestSelect,
    }),
  );
}

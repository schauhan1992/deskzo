"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type AttendanceStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { toPlain } from "@/lib/serialize";
import { recordAudit } from "@/lib/audit";
import { hasEffectivePermission } from "@/actions/permission";
import { getDownlineUserIds } from "@/lib/org-chart";
import { closedDates, dateOnly, eachDay, isWeekOff, monthRange, toKey } from "@/lib/hr/calendar";
import { workspaceClock } from "@/lib/time/workspace";
import { attendanceMarkSchema } from "@/lib/validation/hr";
import { officeHours } from "@/lib/hr/office-hours";
import { dayTiming, officeDayMinutes, officeHoursOrRefusal, workedMinutesOf, type OfficeHours } from "@/lib/hr/office-hours-rules";
import type { ActionResult } from "@/actions/company";

/**
 * Daily attendance: clocking in and out, and the month grid HR reads it from.
 *
 * A row is written only when something is known about a day. Days with no row are "not recorded",
 * which the grid shows as blank — deliberately distinct from ABSENT, because pre-filling a year of
 * absences would make every new employee look like they never turned up.
 */

async function visibleUserIds(userId: string): Promise<string[] | null> {
  if (await hasEffectivePermission(userId, "hr.viewAll")) return null;
  if (await hasEffectivePermission(userId, "hr.manage")) return null;
  return [userId, ...(await getDownlineUserIds(userId))];
}

async function canMarkFor(actorId: string, targetId: string) {
  if (actorId === targetId) return true;
  if (await hasEffectivePermission(actorId, "hr.manage")) return true;
  return (await getDownlineUserIds(actorId)).includes(targetId);
}

function minutesBetween(from: Date, to: Date) {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 60000));
}

// ─── Clocking ─────────────────────────────────────────────────────────────────

/**
 * Today's row for the signed-in user, or null before they have clocked in.
 *
 * "Today" is the workspace's day. It was UTC's (`dateOnly(new Date())`), so in India a clock-in before
 * 05:30 landed on yesterday's row.
 */
export async function myToday() {
  const user = await requireModuleUser("hr");
  const today = (await workspaceClock()).calendarDate(new Date());
  const row = await db.attendanceDay.findUnique({
    where: { userId_date: { userId: user.id, date: today } },
  });
  return row ? toPlain(row) : null;
}

export async function clockIn(): Promise<ActionResult<{ at: string }>> {
  const user = await requireModuleUser("hr");
  const now = new Date();
  const today = (await workspaceClock()).calendarDate(now);

  const existing = await db.attendanceDay.findUnique({ where: { userId_date: { userId: user.id, date: today } } });
  if (existing?.checkInAt) {
    return { ok: false, error: "You're already clocked in today." };
  }
  // Leave already booked for today wins: clocking in on approved leave is almost always a mistake,
  // and silently overwriting it would quietly hand back a day of leave that was already deducted.
  if (existing && (existing.status === "ON_LEAVE" || existing.status === "HALF_DAY") && existing.leaveRequestId) {
    return { ok: false, error: "You're on approved leave today. Cancel the leave first if you're working." };
  }

  await db.attendanceDay.upsert({
    where: { userId_date: { userId: user.id, date: today } },
    create: { userId: user.id, date: today, status: "PRESENT", checkInAt: now },
    update: { status: "PRESENT", checkInAt: now },
  });
  revalidatePath("/people/attendance");
  return { ok: true, data: { at: now.toISOString() } };
}

export async function clockOut(): Promise<ActionResult<{ minutes: number }>> {
  const user = await requireModuleUser("hr");
  const now = new Date();
  const today = (await workspaceClock()).calendarDate(now);

  const existing = await db.attendanceDay.findUnique({ where: { userId_date: { userId: user.id, date: today } } });
  if (!existing?.checkInAt) return { ok: false, error: "You haven't clocked in today." };

  const minutes = minutesBetween(existing.checkInAt, now);
  await db.attendanceDay.update({
    where: { id: existing.id },
    data: { checkOutAt: now, workedMinutes: minutes },
  });
  revalidatePath("/people/attendance");
  return { ok: true, data: { minutes } };
}

/**
 * HR or a manager setting a day directly.
 *
 * Every correction is stamped with who made it, because "my attendance says absent and I was here"
 * is a conversation that needs an answer.
 */
export async function markAttendance(input: unknown): Promise<ActionResult<null>> {
  const user = await requireModuleUser("hr");
  const parsed = attendanceMarkSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;

  if (!(await canMarkFor(user.id, data.userId))) {
    return { ok: false, error: "You can't change that person's attendance." };
  }

  const date = dateOnly(data.date);
  const existing = await db.attendanceDay.findUnique({ where: { userId_date: { userId: data.userId, date } } });
  if (existing?.leaveRequestId && data.status !== "ON_LEAVE" && data.status !== "HALF_DAY") {
    return {
      ok: false,
      error: "That day is covered by approved leave. Cancel or correct the leave request instead.",
    };
  }

  // The times are the workspace's wall clock on that day. Built as a bare string they were read in the
  // server's zone, which is UTC in production.
  const clock = await workspaceClock();
  const checkInAt = data.checkInAt ? clock.parseInput(`${data.date}T${data.checkInAt}`) : null;
  const checkOutAt = data.checkOutAt ? clock.parseInput(`${data.date}T${data.checkOutAt}`) : null;
  if ((data.checkInAt && !checkInAt) || (data.checkOutAt && !checkOutAt)) {
    return { ok: false, error: "Enter the times as hh:mm." };
  }
  const worked = checkInAt && checkOutAt ? minutesBetween(checkInAt, checkOutAt) : null;

  const isCorrection = user.id !== data.userId || !!existing;
  await db.attendanceDay.upsert({
    where: { userId_date: { userId: data.userId, date } },
    create: {
      userId: data.userId,
      date,
      status: data.status as AttendanceStatus,
      checkInAt,
      checkOutAt,
      workedMinutes: worked,
      note: data.note?.trim() || null,
      ...(isCorrection ? { regularisedById: user.id, regularisedAt: new Date() } : {}),
    },
    update: {
      status: data.status as AttendanceStatus,
      checkInAt,
      checkOutAt,
      workedMinutes: worked,
      note: data.note?.trim() || null,
      regularisedById: user.id,
      regularisedAt: new Date(),
    },
  });

  const target = await db.user.findUnique({ where: { id: data.userId }, select: { name: true } });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "AttendanceDay",
    entityId: `${data.userId}:${data.date}`,
    entityLabel: `${target?.name ?? "Someone"} marked ${data.status.toLowerCase().replaceAll("_", " ")} on ${data.date}`,
  });
  revalidatePath("/people/attendance");
  return { ok: true, data: null };
}

// ─── The month grid ───────────────────────────────────────────────────────────

export type MonthCell = {
  date: string;
  status: AttendanceStatus | null;
  workedMinutes: number | null;
  /** Neither a working day nor a recorded one — shown greyed rather than as a gap. */
  offDay: "week off" | "holiday" | null;
  note: string | null;
  regularised: boolean;
  checkInAt: string | null;
  checkOutAt: string | null;
  /** Still to come — nothing to say about it yet. */
  future: boolean;
  /** A correction asked for and not yet decided. */
  pending: boolean;
  /** Against the office hours, when they're set (src/lib/hr/office-hours-rules.ts). */
  late: boolean;
  early: boolean;
  overtime: boolean;
};

export type MonthRow = {
  userId: string;
  userSeq: number;
  name: string;
  designation: string | null;
  cells: MonthCell[];
  present: number;
  leave: number;
  absent: number;
  /** Working days with nothing recorded — the number HR chases. */
  unrecorded: number;
  photoUpdatedAt: string | null;
  /** The month's working days: neither a week off nor a holiday. */
  workingDays: number;
  /** Hours worked, and hours the working days less leave come to — null while office hours aren't set. */
  workedHours: number | null;
  expectedHours: number | null;
};

/**
 * One month, everyone the viewer may see, one row each.
 *
 * Built by walking the calendar rather than the rows: a month with three records should still show
 * thirty-one columns, and the empty ones are the useful part.
 */
export async function attendanceMonth(params: {
  year: number;
  month: number;
  userId?: string;
  departmentId?: string;
  search?: string;
  /** "absent" | "unrecorded" | "leave" — narrows to rows worth chasing. */
  flag?: string;
}) {
  const user = await requireModuleUser("hr");
  const allowed = await visibleUserIds(user.id);
  const { from, to } = monthRange(params.year, params.month);

  const where: Prisma.UserWhereInput = {
    active: true,
    ...(allowed ? { id: { in: allowed } } : {}),
    ...(params.userId ? { id: params.userId } : {}),
    ...(params.departmentId ? { departmentId: params.departmentId } : {}),
    ...(params.search
      ? {
          OR: [
            { name: { contains: params.search, mode: "insensitive" as const } },
            { employeeProfile: { employeeCode: { contains: params.search, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };
  const people = await db.user.findMany({
    where,
    orderBy: { name: "asc" },
    select: { id: true, userSeq: true, name: true, photoUpdatedAt: true, employeeProfile: { select: { designation: true } } },
  });

  const [records, holidays, pendingRows, hours] = await Promise.all([
    db.attendanceDay.findMany({
      where: { userId: { in: people.map((p) => p.id) }, date: { gte: from, lte: to } },
      select: { userId: true, date: true, status: true, workedMinutes: true, note: true, regularisedAt: true, checkInAt: true, checkOutAt: true },
    }),
    db.holiday.findMany({ where: { date: { gte: from, lte: to } }, select: { date: true, optional: true } }),
    db.attendanceRegularisation.findMany({
      where: { userId: { in: people.map((p) => p.id) }, date: { gte: from, lte: to }, status: "PENDING" },
      select: { userId: true, date: true },
    }),
    officeHours(),
  ]);
  const pending = new Set(pendingRows.map((r) => `${r.userId}:${toKey(r.date)}`));

  const closed = closedDates(holidays);
  const byUser = new Map<string, Map<string, (typeof records)[number]>>();
  for (const r of records) {
    const key = r.userId;
    if (!byUser.has(key)) byUser.set(key, new Map());
    byUser.get(key)!.set(toKey(r.date), r);
  }

  const days = eachDay(from, to);
  const clock = await workspaceClock();
  const today = clock.calendarDate(new Date());
  // A clock-in as minutes from midnight on the workspace's clock, which is what office hours are in.
  const minuteOf = (at: Date) => {
    const p = clock.parts(at);
    return p.hour * 60 + p.minute;
  };
  const rows: MonthRow[] = people.map((person) => {
    const own = byUser.get(person.id) ?? new Map();
    let present = 0;
    let leave = 0;
    let absent = 0;
    let unrecorded = 0;
    let workingDays = 0;
    let workedMinutes = 0;

    const cells: MonthCell[] = days.map((day) => {
      const key = toKey(day);
      const record = own.get(key);
      const offDay = isWeekOff(day) ? ("week off" as const) : closed.has(key) ? ("holiday" as const) : null;
      if (!offDay) workingDays += 1;
      if (record && hours) workedMinutes += workedMinutesOf(record, hours);

      if (record) {
        if (record.status === "PRESENT" || record.status === "WORK_FROM_HOME") present += 1;
        else if (record.status === "HALF_DAY") { present += 0.5; leave += 0.5; }
        else if (record.status === "ON_LEAVE") leave += 1;
        else if (record.status === "ABSENT") absent += 1;
      } else if (!offDay && day <= today) {
        // Only days that have actually happened count as unrecorded — the rest of the month is
        // simply the future, not a gap anybody has to explain.
        unrecorded += 1;
      }

      return {
        date: key,
        status: record?.status ?? null,
        workedMinutes: record?.workedMinutes ?? null,
        offDay,
        note: record?.note ?? null,
        regularised: !!record?.regularisedAt,
        checkInAt: record?.checkInAt ? record.checkInAt.toISOString() : null,
        checkOutAt: record?.checkOutAt ? record.checkOutAt.toISOString() : null,
        future: day > today,
        pending: pending.has(`${person.id}:${key}`),
        ...dayTiming(record ?? { status: null, checkInAt: null, checkOutAt: null, workedMinutes: null }, hours, minuteOf),
      };
    });
    // Hours worked against the hours the working days come to, less leave taken (owner, 16 Oct 2026).
    const round1 = (n: number) => Math.round(n * 10) / 10;

    return {
      userId: person.id,
      userSeq: person.userSeq,
      name: person.name,
      designation: person.employeeProfile?.designation ?? null,
      cells,
      present,
      leave,
      absent,
      unrecorded,
      photoUpdatedAt: person.photoUpdatedAt ? person.photoUpdatedAt.toISOString() : null,
      workingDays,
      workedHours: hours ? round1(workedMinutes / 60) : null,
      expectedHours: hours ? round1((Math.max(0, workingDays - leave) * officeDayMinutes(hours)) / 60) : null,
    };
  });

  // Applied after the rows are built, because "who was absent this month" is a property of the
  // finished row rather than something the database can answer while it is still counting.
  const filtered =
    params.flag === "absent"
      ? rows.filter((r) => r.absent > 0)
      : params.flag === "unrecorded"
        ? rows.filter((r) => r.unrecorded > 0)
        : params.flag === "leave"
          ? rows.filter((r) => r.leave > 0)
          : rows;

  return { days: days.map(toKey), rows: filtered, totalPeople: rows.length, officeHours: hours };
}

/**
 * Sets the company's office hours — what Late, Early, Overtime and hours worked are measured against
 * (owner, 16 Oct 2026). Whoever manages HR; `null` clears them.
 */
export async function saveOfficeHours(input: { start: string; end: string; grace: number } | null): Promise<ActionResult<OfficeHours | null>> {
  const user = await requireModuleUser("hr");
  if (!(await hasEffectivePermission(user.id, "hr.manage"))) return { ok: false, error: "Only whoever manages HR can set office hours." };
  if (input === null) {
    await db.attendanceSettings.deleteMany({ where: { id: "global" } });
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "AttendanceSettings", entityId: "global", entityLabel: "Office hours cleared" });
    revalidatePath("/people/attendance");
    return { ok: true, data: null };
  }
  const parsed = officeHoursOrRefusal({ start: String(input?.start ?? ""), end: String(input?.end ?? ""), grace: input?.grace });
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const data = { ...parsed.hours, updatedById: user.id };
  await db.attendanceSettings.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "AttendanceSettings",
    entityId: "global",
    entityLabel: `Office hours ${input.start}–${input.end}, ${parsed.hours.graceMinutes} minutes' grace`,
  });
  revalidatePath("/people/attendance");
  return { ok: true, data: parsed.hours };
}

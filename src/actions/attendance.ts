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
import { monthShortLeaves } from "@/lib/hr/short-leave";
import { spanWords, timingWithShortLeave } from "@/lib/hr/short-leave-rules";
import type { ActionResult } from "@/actions/company";
import { clockPolicyFor, recordClock, type ClockOutcome, type ClockPolicy, type ClockRefusal } from "@/lib/hr/clock";
import { readReading } from "@/lib/hr/geofence";
import { punchInstant } from "@/lib/hr/punch-rollup";
import { PUNCH_TYPE_LABELS, VERIFY_MODE_LABELS } from "@/lib/hr/iclock";

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

/**
 * A clocking's answer: the action's own, and where it was refused for the office's location, why — so the screen
 * can say so in its own words and offer to ask for an exception (src/lib/hr/clock.ts).
 */
export type ClockResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: ClockRefusal; canRequestException?: boolean; distanceM?: number };

const refusedClock = (outcome: Extract<ClockOutcome, { ok: false }>) => ({
  ok: false as const,
  error: outcome.error,
  code: outcome.code,
  canRequestException: outcome.canRequestException,
  ...(outcome.distanceM !== undefined ? { distanceM: outcome.distanceM } : {}),
});

/**
 * Clocking in from the web. `location` is what the browser read — needed only where the person's office enforces
 * its location, and checked on the server whatever it says (src/lib/hr/clock.ts, the app's door too).
 */
export async function clockIn(location?: unknown): Promise<ClockResult<{ at: string }>> {
  const user = await requireModuleUser("hr");
  const outcome = await recordClock({ userId: user.id, action: "in", reading: readReading(asRecord(location)) });
  if (!outcome.ok) return refusedClock(outcome);
  return { ok: true, data: { at: outcome.at.toISOString() } };
}

export async function clockOut(location?: unknown): Promise<ClockResult<{ minutes: number }>> {
  const user = await requireModuleUser("hr");
  const outcome = await recordClock({ userId: user.id, action: "out", reading: readReading(asRecord(location)) });
  if (!outcome.ok) return refusedClock(outcome);
  return { ok: true, data: { minutes: outcome.minutes ?? 0 } };
}

/** The attendance rule that applies to the person signed in — whether their clock-in needs their location. */
export async function myClockPolicy(): Promise<ClockPolicy> {
  const user = await requireModuleUser("hr");
  return clockPolicyFor(user.id);
}

const asRecord = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

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
  /**
   * The day's short leave, pending or approved (src/lib/hr/short-leave-rules.ts): its hours in words,
   * and whether it cleared a Late or Left early mark.
   */
  shortLeave: { words: string; approved: boolean; excused: boolean } | null;
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

  // The Person filter narrows what the viewer may see — never past it. Spread after `allowed` as it was, a
  // `?userId=` of anybody replaced the limit and showed that person's month to whoever asked.
  const ids = allowed ? (params.userId ? allowed.filter((id) => id === params.userId) : allowed) : params.userId ? [params.userId] : null;
  const where: Prisma.UserWhereInput = {
    active: true,
    ...(ids ? { id: { in: ids } } : {}),
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

  const [records, holidays, pendingRows, hours, shortLeaves] = await Promise.all([
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
    monthShortLeaves(people.map((p) => p.id), from, to),
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

      const asRecorded = record ?? { status: null, checkInAt: null, checkOutAt: null, workedMinutes: null };
      // An approved short leave clears the Late or Left early mark it covers (owner, 18 Oct 2026).
      const short = shortLeaves.get(`${person.id}:${key}`) ?? null;
      const { excused, ...timing } = timingWithShortLeave(dayTiming(asRecorded, hours, minuteOf), asRecorded, short, hours, minuteOf);

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
        ...timing,
        shortLeave: short ? { words: spanWords(short), approved: short.approved, excused } : null,
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

  return {
    days: days.map(toKey),
    rows: filtered,
    totalPeople: rows.length,
    officeHours: hours,
    /**
     * Whose attendance this viewer may see: "self" — only their own (no HR permission, nobody reporting to
     * them); "team" — theirs and their reports'; "all" — everyone's.
     */
    scope: (allowed === null ? "all" : allowed.length <= 1 ? "self" : "team") as "self" | "team" | "all",
    /** The people the Person filter may offer — everyone, when null. */
    visibleIds: allowed,
  };
}

export type MyPunchDay = {
  /** yyyy-mm-dd */
  date: string;
  status: AttendanceStatus | null;
  checkInAt: string | null;
  checkOutAt: string | null;
  workedMinutes: number | null;
  /** Corrected by HR or a manager. */
  regularised: boolean;
  punches: { at: string; type: string | null; verifiedBy: string | null; terminal: string }[];
};

/**
 * The signed-in person's own days for one month — in, out, hours, and every terminal punch behind them —
 * newest first, up to today (owner, 22 Oct 2026: everybody sees their own punches, when in and when out).
 *
 * Only ever the caller's own: there is no person to pass. A day is listed when something is known about it
 * — an attendance record or a punch.
 */
export async function myPunches(params: { year: number; month: number }): Promise<MyPunchDay[]> {
  const user = await requireModuleUser("hr");
  const year = Math.min(2100, Math.max(2000, Math.trunc(params.year) || 2000));
  const month = Math.min(12, Math.max(1, Math.trunc(params.month) || 1));
  const { from, to } = monthRange(year, month);
  // Punches are kept as the terminal's wall-clock reading, so the month is matched in that reading too.
  const end = new Date(to.getTime() + 24 * 60 * 60 * 1000 - 1);

  const [records, punches] = await Promise.all([
    db.attendanceDay.findMany({
      where: { userId: user.id, date: { gte: from, lte: to } },
      select: { date: true, status: true, checkInAt: true, checkOutAt: true, workedMinutes: true, regularisedAt: true },
    }),
    db.biometricPunch.findMany({
      where: { userId: user.id, punchedAt: { gte: from, lte: end } },
      orderBy: { punchedAt: "asc" },
      select: { punchedAt: true, punchType: true, verifyMode: true, device: { select: { name: true, timezone: true } } },
    }),
  ]);

  const byDay = new Map<string, MyPunchDay>();
  const dayOf = (key: string): MyPunchDay => {
    let day = byDay.get(key);
    if (!day) {
      day = { date: key, status: null, checkInAt: null, checkOutAt: null, workedMinutes: null, regularised: false, punches: [] };
      byDay.set(key, day);
    }
    return day;
  };
  for (const r of records) {
    const day = dayOf(toKey(r.date));
    day.status = r.status;
    day.checkInAt = r.checkInAt ? r.checkInAt.toISOString() : null;
    day.checkOutAt = r.checkOutAt ? r.checkOutAt.toISOString() : null;
    day.workedMinutes = r.workedMinutes;
    day.regularised = !!r.regularisedAt;
  }
  for (const p of punches) {
    dayOf(toKey(dateOnly(p.punchedAt))).punches.push({
      at: punchInstant(p.punchedAt, p.device.timezone).toISOString(),
      type: p.punchType != null ? (PUNCH_TYPE_LABELS[p.punchType] ?? null) : null,
      verifiedBy: p.verifyMode != null ? (VERIFY_MODE_LABELS[p.verifyMode] ?? null) : null,
      terminal: p.device.name,
    });
  }

  return [...byDay.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
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

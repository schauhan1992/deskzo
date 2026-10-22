"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { AttendanceExceptionScope, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { toPlain } from "@/lib/serialize";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { hasEffectivePermission } from "@/actions/permission";
import { peopleHolding } from "@/lib/orders/handoff";
import { PEOPLE_ONLY } from "@/lib/people";
import { notMigratedYet } from "@/lib/not-migrated";
import { workspaceClock } from "@/lib/time/workspace";
import { officePolicyFor } from "@/lib/hr/clock";
import { EXCEPTION_REASON_LABELS, EXCEPTION_SCOPE_LABELS, checkGeofence, readReading, type GeofenceOutcome } from "@/lib/hr/geofence";
import type { ActionResult } from "@/actions/company";

/**
 * Attendance location exceptions (owner, 22 Oct 2026): leave for one person to clock in, out, or both, away from
 * their office's GPS area — within a window, once each way. src/lib/hr/clock.ts spends one only when the location
 * check itself fails, so an exception never stands in for being at the office when the person is.
 *
 * Two ways one comes to be:
 *   · the person asks, from the clock-in screen that refused them — PENDING, for today, until somebody holding
 *     "Approve attendance location exceptions" approves or refuses it;
 *   · an approver grants one for somebody — APPROVED from the start, for the window they set.
 * Never one's own, either way: the person can ask, and withdraw while it waits; nobody decides, grants or revokes
 * their own. Every step is audited and tells the person concerned. An approved one not yet fully used can be
 * revoked; one used, expired, refused or revoked is history and never counts again.
 */

const PERMISSION = "hr.approveAttendanceExceptions";
/** The longest window an approver may grant — one use each way within it, however long it is. */
const MAX_WINDOW_DAYS = 7;

const scopeValues = ["IN", "OUT", "IN_AND_OUT"] as const;
const reasonValues = ["ALTERNATE_LOCATION", "GPS_UNAVAILABLE", "CORRECTION", "OTHER"] as const;
const reasonText = z.string({ message: "Say why — whoever decides needs a reason." }).trim().min(3, "Say why — whoever decides needs a reason.").max(500, "Keep the reason under 500 characters.");

const pickScope = { message: "Say whether it is for clocking in, out, or both." };
const pickReason = { message: "Pick a reason." };

const requestSchema = z.object({
  scope: z.enum(scopeValues, pickScope),
  reasonCode: z.enum(reasonValues, pickReason),
  reason: reasonText,
  /** Where the phone or browser was when it was refused, if it knew — the server works the distance out itself. */
  location: z.record(z.string(), z.unknown()).nullish(),
});

const grantSchema = z.object({
  userId: z.string({ message: "Pick the person." }).min(1, "Pick the person."),
  scope: z.enum(scopeValues, pickScope),
  reasonCode: z.enum(reasonValues, pickReason),
  reason: reasonText,
  /** yyyy-mm-dd, the workspace's days, both included. */
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick the first day."),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick the last day."),
});

const decisionSchema = z.object({
  id: z.string().min(1),
  approve: z.boolean(),
  note: z.string().trim().max(300).optional().or(z.literal("")),
});

const revokeSchema = z.object({ id: z.string().min(1), reason: reasonText });

const selectShape = {
  id: true,
  scope: true,
  reasonCode: true,
  reason: true,
  status: true,
  validFrom: true,
  validUntil: true,
  requestedAt: true,
  attemptDistanceM: true,
  attemptAccuracyM: true,
  attemptProblem: true,
  decidedAt: true,
  decisionNote: true,
  revokedAt: true,
  revokeReason: true,
  usedInAt: true,
  usedOutAt: true,
  user: { select: { id: true, name: true } },
  requestedBy: { select: { id: true, name: true } },
  decidedBy: { select: { id: true, name: true } },
  revokedBy: { select: { id: true, name: true } },
} satisfies Prisma.AttendanceExceptionSelect;

type Row = Prisma.AttendanceExceptionGetPayload<{ select: typeof selectShape }>;

/** What a row is now, which its status alone doesn't say: approved but past its window is expired, and so on. */
export type ExceptionState = "PENDING" | "LAPSED" | "APPROVED" | "PARTLY_USED" | "USED" | "EXPIRED" | "REJECTED" | "REVOKED";

function stateOf(row: Pick<Row, "status" | "scope" | "validUntil" | "usedInAt" | "usedOutAt">, now: Date): ExceptionState {
  if (row.status === "REJECTED" || row.status === "REVOKED") return row.status;
  if (row.status === "PENDING") return row.validUntil <= now ? "LAPSED" : "PENDING";
  const wantsIn = row.scope !== "OUT";
  const wantsOut = row.scope !== "IN";
  const done = (!wantsIn || row.usedInAt) && (!wantsOut || row.usedOutAt);
  if (done) return "USED";
  if (row.validUntil <= now) return "EXPIRED";
  return row.usedInAt || row.usedOutAt ? "PARTLY_USED" : "APPROVED";
}

const withState = (rows: Row[], now = new Date()) => toPlain(rows.map((r) => ({ ...r, state: stateOf(r, now) })));
export type ExceptionView = ReturnType<typeof withState>[number];

/** Whether `deciderId` may decide, grant or revoke an exception for `subjectId` — never their own. */
async function canDecide(deciderId: string, subjectId: string) {
  if (deciderId === subjectId) return false;
  return hasEffectivePermission(deciderId, PERMISSION);
}

class Refusal extends Error {}

const notMigrated = { ok: false as const, error: "GPS attendance isn't set up in this workspace yet." };

function revalidate() {
  revalidatePath("/people/attendance");
  revalidatePath("/people/attendance/exceptions");
  revalidatePath("/people/me");
}

/**
 * The person asks for leave to clock in or out away from the office, today. Where they were, if the phone or
 * browser knew, goes with it — the distance is the server's own sum against the office, never the phone's.
 */
export async function requestAttendanceException(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("hr");
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;

  const policy = await officePolicyFor(user.id);
  if (!policy.migrated) return notMigrated;
  if (!policy.enforced) return { ok: false, error: "Your office doesn't check location — clock in as usual, no exception needed." };
  if (!policy.exceptionsAllowed) return { ok: false, error: "Your office doesn't allow attendance exceptions. Please contact HR." };
  // An office with no point refuses every clocking, exception or not, until HR sets it — asking would change nothing.
  if (!policy.configured) return { ok: false, error: "Office location has not been configured. Please contact your administrator." };

  const now = new Date();
  const clock = await workspaceClock();
  const today = clock.today(now);
  const validUntil = clock.endOfDay(today)!;

  // What the person was refused for, worked out here — only the distance, accuracy and why; no coordinates kept.
  const reading = readReading(data.location ?? null);
  const where: GeofenceOutcome =
    reading === "invalid"
      ? { ok: false, problem: "invalid_location" }
      : checkGeofence({ latitude: policy.latitude!, longitude: policy.longitude!, radiusM: policy.radiusM, maxAccuracyM: policy.maxAccuracyM }, reading);
  const attempt = {
    attemptDistanceM: where.distanceM ?? null,
    attemptAccuracyM: reading && reading !== "invalid" ? reading.accuracy : null,
    attemptProblem: where.ok ? null : where.problem,
  };

  const me = await db.user.findUnique({ where: { id: user.id }, select: { name: true } });
  let created: { id: string };
  try {
    created = await db.$transaction(async (tx) => {
      // One request at a time per person, and none while an approved one still covers this.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`deskzo:attendance-exception:${user.id}`}))`;
      const open = await tx.attendanceException.findFirst({
        where: { userId: user.id, status: "PENDING", validUntil: { gt: now } },
        select: { id: true },
      });
      if (open) throw new Refusal("You already have a request awaiting a decision today.");
      const approved = await tx.attendanceException.findMany({
        where: { userId: user.id, status: "APPROVED", validFrom: { lte: now }, validUntil: { gt: now } },
        select: { scope: true, validUntil: true, usedInAt: true, usedOutAt: true, status: true },
      });
      const wanted = (s: AttendanceExceptionScope) => ({ in: s !== "OUT", out: s !== "IN" });
      const ask = wanted(data.scope);
      const covered = approved.some((a) => {
        const has = wanted(a.scope);
        return (!ask.in || (has.in && !a.usedInAt)) && (!ask.out || (has.out && !a.usedOutAt));
      });
      if (covered) throw new Refusal("You already have an approved exception for this — clock in or out now.");
      return tx.attendanceException.create({
        data: {
          userId: user.id,
          scope: data.scope,
          reasonCode: data.reasonCode,
          reason: data.reason,
          status: "PENDING",
          validFrom: now,
          validUntil,
          requestedById: user.id,
          requestedAt: now,
          ...attempt,
        },
        select: { id: true },
      });
    });
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, error: err.message };
    if (notMigratedYet(err)) return notMigrated;
    throw err;
  }

  for (const approverId of await peopleHolding(PERMISSION, [user.id])) {
    await notifyUser({
      userId: approverId,
      type: "ATTENDANCE_EXCEPTION_REQUESTED",
      title: "Clock-in away from the office requested",
      message: `${me?.name ?? "Somebody"} asks to ${EXCEPTION_SCOPE_LABELS[data.scope].toLowerCase()} away from ${policy.officeName ?? "the office"} today — ${EXCEPTION_REASON_LABELS[data.reasonCode].toLowerCase()}.`,
      link: "/people/attendance/exceptions",
    });
  }
  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "AttendanceException",
    entityId: created.id,
    entityLabel: `Asked to ${EXCEPTION_SCOPE_LABELS[data.scope].toLowerCase()} away from the office on ${today} (${EXCEPTION_REASON_LABELS[data.reasonCode]})`,
  });
  revalidate();
  return { ok: true, data: created };
}


/** An approver grants somebody an exception for a window of days — approved from the start, recorded as theirs. */
export async function grantAttendanceException(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("hr");
  const parsed = grantSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;
  if (data.userId === user.id) return { ok: false, error: "You can't grant yourself an exception — ask another approver." };
  if (!(await canDecide(user.id, data.userId))) return { ok: false, error: "You can't grant attendance exceptions." };

  const subject = await db.user.findFirst({ where: { id: data.userId, active: true, ...PEOPLE_ONLY }, select: { id: true, name: true } });
  if (!subject) return { ok: false, error: "That person isn't an active employee." };
  const policy = await officePolicyFor(subject.id);
  if (!policy.migrated) return notMigrated;
  if (!policy.exceptionsAllowed) return { ok: false, error: `${policy.officeName ?? "Their office"} doesn't allow attendance exceptions — turn them on in its attendance location first.` };

  const clock = await workspaceClock();
  const now = new Date();
  const start = clock.startOfDay(data.fromDate);
  const end = clock.endOfDay(data.toDate);
  if (!start || !end) return { ok: false, error: "Pick real days." };
  if (end <= start) return { ok: false, error: "The last day is before the first." };
  if (end <= now) return { ok: false, error: "That window has already passed." };
  if (clock.daysBetween(start, end) > MAX_WINDOW_DAYS) return { ok: false, error: `Grant at most ${MAX_WINDOW_DAYS} days at a time.` };
  // A window that began earlier today still starts now — an exception isn't for clockings already made.
  const validFrom = start < now ? now : start;

  let created: { id: string };
  try {
    created = await db.attendanceException.create({
      data: {
        userId: subject.id,
        scope: data.scope,
        reasonCode: data.reasonCode,
        reason: data.reason,
        status: "APPROVED",
        validFrom,
        validUntil: end,
        requestedById: user.id,
        requestedAt: now,
        decidedById: user.id,
        decidedAt: now,
        decisionNote: "Granted by an approver",
      },
      select: { id: true },
    });
  } catch (err) {
    if (notMigratedYet(err)) return notMigrated;
    throw err;
  }

  const window = data.fromDate === data.toDate ? data.fromDate : `${data.fromDate} to ${data.toDate}`;
  await notifyUser({
    userId: subject.id,
    type: "ATTENDANCE_EXCEPTION_DECIDED",
    title: "You may clock in away from the office",
    message: `${user.name} granted you an exception to ${EXCEPTION_SCOPE_LABELS[data.scope].toLowerCase()} away from the office, ${window} — once each way.`,
    link: "/people/me",
  });
  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "AttendanceException",
    entityId: created.id,
    entityLabel: `Granted ${subject.name} an exception to ${EXCEPTION_SCOPE_LABELS[data.scope].toLowerCase()} away from the office, ${window} (${EXCEPTION_REASON_LABELS[data.reasonCode]})`,
  });
  revalidate();
  return { ok: true, data: created };
}

/** Approves or refuses a request waiting on a decision — never one's own; one decision, whoever is first. */
export async function decideAttendanceException(input: unknown): Promise<ActionResult<null>> {
  const user = await requireModuleUser("hr");
  const parsed = decisionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { id, approve } = parsed.data;
  const note = parsed.data.note?.trim() || null;

  const request = await findException(id);
  if (!request) return { ok: false, error: "That request no longer exists." };
  if (request.userId === user.id) return { ok: false, error: "You can't decide your own exception." };
  if (!(await canDecide(user.id, request.userId))) return { ok: false, error: "You can't decide attendance exceptions." };
  if (request.status !== "PENDING") return { ok: false, error: `It was already ${request.status.toLowerCase()}.` };
  const now = new Date();
  if (approve && request.validUntil <= now) return { ok: false, error: "The day it was for has passed — it can only be refused now." };

  const decided = await db.attendanceException.updateMany({
    where: { id, status: "PENDING" },
    data: { status: approve ? "APPROVED" : "REJECTED", decidedById: user.id, decidedAt: now, decisionNote: note },
  });
  if (decided.count === 0) return { ok: false, error: "Somebody else decided it first." };

  await notifyUser({
    userId: request.userId,
    type: "ATTENDANCE_EXCEPTION_DECIDED",
    title: `Clock-in away from the office ${approve ? "approved" : "refused"}`,
    message: `${user.name} ${approve ? "approved" : "refused"} your request to ${EXCEPTION_SCOPE_LABELS[request.scope].toLowerCase()} away from the office${note ? `: ${note}` : "."}${approve ? " You can clock now." : ""}`,
    link: "/people/me",
  });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "AttendanceException",
    entityId: id,
    entityLabel: `${approve ? "Approved" : "Refused"} ${request.user.name}'s request to ${EXCEPTION_SCOPE_LABELS[request.scope].toLowerCase()} away from the office`,
  });
  revalidate();
  return { ok: true, data: null };
}

/** Takes back an approved exception before it is fully used — what it already allowed stays as it was. */
export async function revokeAttendanceException(input: unknown): Promise<ActionResult<null>> {
  const user = await requireModuleUser("hr");
  const parsed = revokeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { id, reason } = parsed.data;

  const row = await findException(id);
  if (!row) return { ok: false, error: "That exception no longer exists." };
  if (row.userId === user.id) return { ok: false, error: "You can't revoke your own exception — ask another approver." };
  if (!(await canDecide(user.id, row.userId))) return { ok: false, error: "You can't revoke attendance exceptions." };
  const now = new Date();
  const state = stateOf(row, now);
  if (state !== "APPROVED" && state !== "PARTLY_USED") {
    return { ok: false, error: state === "USED" ? "It has already been used in full." : state === "EXPIRED" ? "It has already expired." : "Only an approved exception can be revoked." };
  }

  // Conditional on still being unused for some part — a clocking spending it at this moment wins, or this does.
  const revoked = await db.attendanceException.updateMany({
    where: {
      id,
      status: "APPROVED",
      ...(row.scope === "IN" ? { usedInAt: null } : row.scope === "OUT" ? { usedOutAt: null } : { OR: [{ usedInAt: null }, { usedOutAt: null }] }),
    },
    data: { status: "REVOKED", revokedById: user.id, revokedAt: now, revokeReason: reason },
  });
  if (revoked.count === 0) return { ok: false, error: "It was used in full just now — nothing left to revoke." };

  await notifyUser({
    userId: row.userId,
    type: "ATTENDANCE_EXCEPTION_DECIDED",
    title: "Attendance exception revoked",
    message: `${user.name} revoked your exception to ${EXCEPTION_SCOPE_LABELS[row.scope].toLowerCase()} away from the office: ${reason}`,
    link: "/people/me",
  });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "AttendanceException",
    entityId: id,
    entityLabel: `Revoked ${row.user.name}'s exception to ${EXCEPTION_SCOPE_LABELS[row.scope].toLowerCase()} away from the office`,
  });
  revalidate();
  return { ok: true, data: null };
}

/** The person withdraws their own request while it still waits. */
export async function withdrawAttendanceException(id: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("hr");
  const row = await findException(String(id ?? ""));
  if (!row) return { ok: false, error: "That request no longer exists." };
  if (row.userId !== user.id) return { ok: false, error: "That isn't your request." };
  const withdrawn = await db.attendanceException.updateMany({
    where: { id: row.id, userId: user.id, status: "PENDING" },
    data: { status: "REVOKED", revokedById: user.id, revokedAt: new Date(), revokeReason: "Withdrawn by the person who asked" },
  });
  if (withdrawn.count === 0) return { ok: false, error: "Only a request still awaiting a decision can be withdrawn." };
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "AttendanceException", entityId: row.id, entityLabel: "Withdrew a request to clock in away from the office" });
  revalidate();
  return { ok: true, data: null };
}

async function findException(id: string) {
  try {
    return await db.attendanceException.findUnique({ where: { id }, select: { ...selectShape, userId: true } });
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

/** The signed-in person's own exceptions, newest first. */
export async function myAttendanceExceptions() {
  const user = await requireModuleUser("hr");
  try {
    return withState(await db.attendanceException.findMany({ where: { userId: user.id }, orderBy: { requestedAt: "desc" }, take: 20, select: selectShape }));
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

/** Whether the signed-in person decides attendance exceptions — what shows the queue and the grant form. */
export async function canApproveAttendanceExceptions(): Promise<boolean> {
  const user = await requireModuleUser("hr");
  return hasEffectivePermission(user.id, PERMISSION);
}

/** Requests waiting on a decision the signed-in person may make — everybody's but their own. */
export async function attendanceExceptionQueue() {
  const user = await requireModuleUser("hr");
  if (!(await hasEffectivePermission(user.id, PERMISSION))) return [];
  try {
    const now = new Date();
    return withState(
      await db.attendanceException.findMany({
        where: { status: "PENDING", userId: { not: user.id }, validUntil: { gt: now } },
        orderBy: { requestedAt: "asc" },
        take: 100,
        select: selectShape,
      }),
      now,
    );
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

const historyFilter = z.object({
  userId: z.string().optional(),
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "REVOKED"]).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
});

/** Every exception, for an approver's audit — who asked, who decided, what it was used for. */
export async function attendanceExceptionHistory(input: unknown = {}) {
  const user = await requireModuleUser("hr");
  if (!(await hasEffectivePermission(user.id, PERMISSION))) return [];
  const filter = historyFilter.safeParse(input ?? {});
  const f = filter.success ? filter.data : {};
  const clock = await workspaceClock();
  const range = clock.dayRange(f.from || null, f.to || null);
  try {
    return withState(
      await db.attendanceException.findMany({
        where: { ...(f.userId ? { userId: f.userId } : {}), ...(f.status ? { status: f.status } : {}), ...(range ? { requestedAt: range } : {}) },
        orderBy: { requestedAt: "desc" },
        take: 200,
        select: selectShape,
      }),
    );
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

/** Who an approver may grant an exception to: every active employee but themselves. Empty for anybody else. */
export async function attendanceExceptionCandidates(): Promise<{ id: string; name: string; email: string | null }[]> {
  const user = await requireModuleUser("hr");
  if (!(await hasEffectivePermission(user.id, PERMISSION))) return [];
  return db.user.findMany({ where: { active: true, id: { not: user.id }, ...PEOPLE_ONLY }, orderBy: { name: "asc" }, select: { id: true, name: true, email: true } });
}

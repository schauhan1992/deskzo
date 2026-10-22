import type { AttendanceGeoCheck, AttendanceExceptionScope, Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { notMigratedYet } from "@/lib/not-migrated";
import { workspaceClock } from "@/lib/time/workspace";
import { PROBLEM_WORDS, checkGeofence, type GeofenceOutcome, type GeofenceProblem, type Reading } from "@/lib/hr/geofence";

/**
 * Clocking in and out — the one door, from the web's buttons (src/actions/attendance.ts) and from the Deskzo app
 * (src/lib/app/daily.ts), so neither can get round the other's rules (owner, 22 Oct 2026).
 *
 * In one transaction, holding the person's day:
 *   1. the day's own rules, as they always were — not twice in, not on approved leave, not out before in; out
 *      again moves the clock-out on;
 *   2. where the person's office enforces its location (src/lib/hr/geofence.ts): a reading inside its radius,
 *      sure enough — or, failing that, an approved exception for this action, valid now and unused, which is
 *      spent in the same statement that checks it;
 *   3. the day written, and the clocking kept — where it happened, if the phone said, and how it was checked:
 *      INSIDE, EXCEPTION or NOT_ENFORCED. A terminal's punches later the same day are merged with it.
 * A refusal writes nothing at all: no day, no location, no exception spent.
 *
 * The office is the person's own branch, or the head office when they have none; its point, radius and switches
 * are read here from the database — nothing the phone or browser sends can change them.
 */

type Tx = Prisma.TransactionClient;

export type ClockAction = "in" | "out";

export type ClockRefusal = GeofenceProblem | "office_not_configured" | "exception_needed" | "already_clocked_in" | "not_clocked_in" | "on_leave";

export type ClockOutcome =
  | { ok: true; at: Date; minutes: number | null; check: AttendanceGeoCheck | null; distanceM: number | null; exceptionId: string | null }
  | { ok: false; code: ClockRefusal; error: string; distanceM?: number; canRequestException: boolean };

export type OfficePolicy = {
  /** The office whose rule applies, if the person has one. */
  branchId: string | null;
  officeName: string | null;
  enforced: boolean;
  configured: boolean;
  latitude: number | null;
  longitude: number | null;
  radiusM: number;
  maxAccuracyM: number;
  exceptionsAllowed: boolean;
  /** False where the workspace's database doesn't have GPS attendance yet — everything then as before. */
  migrated: boolean;
};

const NO_POLICY: OfficePolicy = {
  branchId: null,
  officeName: null,
  enforced: false,
  configured: false,
  latitude: null,
  longitude: null,
  radiusM: 100,
  maxAccuracyM: 50,
  exceptionsAllowed: true,
  migrated: true,
};

const OFFICE_SELECT = {
  id: true,
  name: true,
  active: true,
  latitude: true,
  longitude: true,
  geofenceRadiusM: true,
  geoMaxAccuracyM: true,
  geofenceEnforced: true,
  geoExceptionsAllowed: true,
} as const;

/** The office whose attendance rule applies to somebody: their own branch if it's open, else the head office. */
export async function officePolicyFor(userId: string, client: Pick<Tx, "user" | "branch"> = db): Promise<OfficePolicy> {
  try {
    const user = await client.user.findUnique({ where: { id: userId }, select: { branchId: true } });
    const own = user?.branchId ? await client.branch.findUnique({ where: { id: user.branchId }, select: OFFICE_SELECT }) : null;
    const office = own?.active ? own : await client.branch.findFirst({ where: { isHeadOffice: true, active: true }, select: OFFICE_SELECT });
    if (!office) return NO_POLICY;
    const configured = office.latitude !== null && office.longitude !== null;
    return {
      branchId: office.id,
      officeName: office.name,
      enforced: office.geofenceEnforced,
      configured,
      latitude: office.latitude,
      longitude: office.longitude,
      radiusM: office.geofenceRadiusM,
      maxAccuracyM: office.geoMaxAccuracyM,
      exceptionsAllowed: office.geoExceptionsAllowed,
      migrated: true,
    };
  } catch (err) {
    if (notMigratedYet(err)) return { ...NO_POLICY, migrated: false };
    throw err;
  }
}

const covers = (scope: AttendanceExceptionScope, action: ClockAction) => scope === "IN_AND_OUT" || scope === (action === "in" ? "IN" : "OUT");
const usedField = (action: ClockAction) => (action === "in" ? "usedInAt" : "usedOutAt");

/** An approved exception that would let this person clock this way now: valid now, and not yet used for it. */
export async function usableException(userId: string, action: ClockAction, now = new Date(), client: Pick<Tx, "attendanceException"> = db) {
  const rows = await client.attendanceException.findMany({
    where: { userId, status: "APPROVED", validFrom: { lte: now }, validUntil: { gt: now }, ...(action === "in" ? { usedInAt: null } : { usedOutAt: null }) },
    orderBy: { validUntil: "asc" },
    select: { id: true, scope: true, reasonCode: true, reason: true, validUntil: true },
  });
  return rows.find((r) => covers(r.scope, action)) ?? null;
}

class Refused extends Error {
  constructor(readonly outcome: Extract<ClockOutcome, { ok: false }>) {
    super(outcome.error);
  }
}

const refuse = (code: ClockRefusal, error: string, extra: { distanceM?: number; canRequestException?: boolean } = {}): Extract<ClockOutcome, { ok: false }> => ({
  ok: false,
  code,
  error,
  canRequestException: extra.canRequestException ?? false,
  ...(extra.distanceM !== undefined ? { distanceM: extra.distanceM } : {}),
});

const minutesBetween = (from: Date, to: Date) => Math.max(0, Math.round((to.getTime() - from.getTime()) / 60000));

/**
 * Clocks somebody in or out, by the rules above. `reading` is what their phone or browser sent ("invalid" when it
 * sent something that isn't a place); `appDeviceId` is the paired phone it came from, known to the server.
 */
export async function recordClock(params: { userId: string; action: ClockAction; reading: Reading | null | "invalid"; appDeviceId?: string | null }): Promise<ClockOutcome> {
  const { userId, action } = params;
  const now = new Date();
  const clock = await workspaceClock();
  const date = clock.calendarDate(now);
  // Read before the transaction: a workspace not migrated yet answers "not enforced" rather than aborting it.
  const policy = await officePolicyFor(userId);
  const reading = params.reading === "invalid" ? null : params.reading;

  try {
    const result = await db.$transaction(async (tx) => {
      // The person's day, one clocking at a time: two taps at once are one clocking and a refusal.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`deskzo:clock:${userId}:${date.toISOString().slice(0, 10)}`}))`;
      const day = await tx.attendanceDay.findUnique({ where: { userId_date: { userId, date } } });

      // 1. The day's own rules — first, so "already clocked in" is said whatever the location.
      if (action === "in") {
        if (day?.checkInAt) throw new Refused(refuse("already_clocked_in", "You're already clocked in today."));
        // Leave already booked for today wins: clocking in on approved leave is almost always a mistake, and
        // silently overwriting it would quietly hand back a day of leave that was already deducted.
        if (day && (day.status === "ON_LEAVE" || day.status === "HALF_DAY") && day.leaveRequestId) {
          throw new Refused(refuse("on_leave", "You're on approved leave today. Cancel the leave first if you're working."));
        }
      } else {
        if (!day?.checkInAt) throw new Refused(refuse("not_clocked_in", "You haven't clocked in today."));
        // Out again is allowed, and moves the clock-out on (owner, 22 Oct 2026): a terminal's punch during the
        // day may already have filled it (src/lib/hr/punch-rollup.ts), and the person still clocks out at the end.
      }

      // 2. Where the office enforces its location: inside it, or an approved exception.
      let check: AttendanceGeoCheck | null = policy.migrated ? "NOT_ENFORCED" : null;
      let distanceM: number | null = null;
      let exceptionId: string | null = null;
      if (policy.migrated && policy.configured && reading) {
        const where = checkGeofence({ latitude: policy.latitude!, longitude: policy.longitude!, radiusM: policy.radiusM, maxAccuracyM: policy.maxAccuracyM }, reading);
        distanceM = where.distanceM ?? null;
      }
      if (policy.migrated && policy.enforced) {
        if (!policy.configured) throw new Refused(refuse("office_not_configured", PROBLEM_WORDS.office_not_configured));
        const office = { latitude: policy.latitude!, longitude: policy.longitude!, radiusM: policy.radiusM, maxAccuracyM: policy.maxAccuracyM };
        const where: GeofenceOutcome = params.reading === "invalid" ? { ok: false, problem: "invalid_location" } : checkGeofence(office, reading);
        if (where.ok) {
          check = "INSIDE";
        } else {
          const exception = policy.exceptionsAllowed ? await usableException(userId, action, now, tx) : null;
          if (!exception) {
            throw new Refused(
              refuse(where.problem, PROBLEM_WORDS[where.problem], { distanceM: where.distanceM, canRequestException: policy.exceptionsAllowed }),
            );
          }
          // Spent in the statement that checks it is still good, so two clockings can't share one exception.
          const spent = await tx.attendanceException.updateMany({
            where: { id: exception.id, status: "APPROVED", validFrom: { lte: now }, validUntil: { gt: now }, [usedField(action)]: null },
            data: { [usedField(action)]: now },
          });
          if (spent.count === 0) throw new Refused(refuse("exception_needed", PROBLEM_WORDS.exception_needed, { canRequestException: policy.exceptionsAllowed }));
          check = "EXCEPTION";
          exceptionId = exception.id;
        }
      }

      // 3. The day, and where it happened.
      let minutes: number | null = null;
      if (action === "in") {
        await tx.attendanceDay.upsert({
          where: { userId_date: { userId, date } },
          create: { userId, date, status: "PRESENT", checkInAt: now },
          update: { status: "PRESENT", checkInAt: now },
        });
      } else {
        // Never earlier than a clock-out already there — a terminal whose clock runs a minute ahead included.
        const outAt = day!.checkOutAt && day!.checkOutAt > now ? day!.checkOutAt : now;
        minutes = minutesBetween(day!.checkInAt!, outAt);
        await tx.attendanceDay.update({ where: { id: day!.id }, data: { checkOutAt: outAt, workedMinutes: minutes } });
      }
      // Every clocking is kept where the workspace can hold one without a location: a terminal's punches for the
      // same day are merged with it later (src/lib/hr/punch-rollup.ts) rather than written over it.
      if (reading || exceptionId || policy.migrated) {
        await tx.attendanceLocation.create({
          data: {
            userId,
            date,
            kind: action === "in" ? "IN" : "OUT",
            at: now,
            latitude: reading?.latitude ?? null,
            longitude: reading?.longitude ?? null,
            accuracyM: reading?.accuracy ?? null,
            appDeviceId: params.appDeviceId ?? null,
            // Only where the workspace has the columns: as it always was, otherwise.
            ...(policy.migrated
              ? { check, branchId: policy.branchId, distanceM, radiusM: policy.configured ? policy.radiusM : null, mocked: reading?.mocked ?? null, exceptionId }
              : {}),
          },
          select: { id: true },
        });
      }
      return { ok: true as const, at: now, minutes, check, distanceM, exceptionId };
    });
    if (result.exceptionId) {
      await recordAudit({
        userId,
        action: "UPDATE",
        entityType: "AttendanceException",
        entityId: result.exceptionId,
        entityLabel: `Clocked ${action} under an approved attendance exception, not at the office${result.distanceM !== null ? ` (${result.distanceM} m away)` : ""}`,
      });
    }
    revalidatePath("/people/attendance");
    revalidatePath("/people/me");
    return result;
  } catch (err) {
    if (err instanceof Refused) return err.outcome;
    throw err;
  }
}

/** The attendance rule that applies to somebody now, for their clock-in screens — no office coordinates in it. */
export async function clockPolicyFor(userId: string) {
  const policy = await officePolicyFor(userId);
  let exception: { id: string; status: "APPROVED" | "PENDING"; scope: AttendanceExceptionScope; validUntil: Date; usedIn: boolean; usedOut: boolean } | null = null;
  if (policy.migrated && policy.enforced) {
    try {
      const now = new Date();
      const row = await db.attendanceException.findFirst({
        where: { userId, OR: [{ status: "APPROVED", validFrom: { lte: now }, validUntil: { gt: now } }, { status: "PENDING", validUntil: { gte: now } }] },
        // APPROVED sorts after PENDING in the enum: an approved one, usable now, is the one to show.
        orderBy: [{ status: "desc" }, { validUntil: "asc" }],
        select: { id: true, status: true, scope: true, validUntil: true, usedInAt: true, usedOutAt: true },
      });
      if (row && (row.status === "APPROVED" || row.status === "PENDING")) {
        exception = { id: row.id, status: row.status, scope: row.scope, validUntil: row.validUntil, usedIn: !!row.usedInAt, usedOut: !!row.usedOutAt };
      }
    } catch (err) {
      if (!notMigratedYet(err)) throw err;
    }
  }
  return {
    required: policy.migrated && policy.enforced,
    configured: policy.configured,
    officeName: policy.officeName,
    radiusM: policy.enforced ? policy.radiusM : null,
    exceptionsAllowed: policy.exceptionsAllowed,
    exception,
  };
}

export type ClockPolicy = Awaited<ReturnType<typeof clockPolicyFor>>;

import { db } from "@/lib/db";
import { dateOnly, toKey } from "@/lib/hr/calendar";
import { clockFor } from "@/lib/time/zone";

/**
 * Folding raw punches into attendance days.
 *
 * Deliberately NOT in a "use server" module: every export from one becomes a client-callable
 * endpoint, and this writes attendance — which feeds loss of pay, which feeds salary. It is called
 * from the device endpoint (which authenticates by registered serial) and from the actions file
 * (which checks permissions first).
 *
 * The rules, in order of how much damage getting them wrong would do:
 *
 *   1. A day already covered by approved leave is never touched. Somebody who came in for an hour
 *      on their day off must not silently lose the leave they booked and were deducted for.
 *   2. A day HR corrected by hand is never touched. A device re-sending its buffer three weeks
 *      later must not quietly undo a decision a person made.
 *   3. Nothing is ever marked ABSENT. A missing punch is not proof of absence — they may have been
 *      at a customer site, or the terminal may have been unplugged — and this app already treats an
 *      unrecorded day as unrecorded rather than as an accusation.
 */

/**
 * The real moment a punch happened.
 *
 * A terminal sends its own wall-clock reading with no zone, and it is stored as read — "09:00" is kept as
 * 09:00 UTC (src/lib/hr/iclock.ts). An attendance day's check-in and check-out are real instants, as a
 * clock-in from the app is, and every screen shows them on the workspace's clock; so the reading is placed
 * in the terminal's own zone first. Written as read, a 09:00 punch in India showed as 14:30.
 */
export function punchInstant(punchedAt: Date, zone: string | null | undefined): Date {
  const at = clockFor(zone).at(
    punchedAt.getUTCFullYear(),
    punchedAt.getUTCMonth(),
    punchedAt.getUTCDate(),
    punchedAt.getUTCHours(),
    punchedAt.getUTCMinutes(),
  );
  return new Date(at.getTime() + punchedAt.getUTCSeconds() * 1000 + punchedAt.getUTCMilliseconds());
}

export type RollupResult = {
  daysWritten: number;
  punchesProcessed: number;
  skipped: { date: string; userId: string; why: string }[];
};

/**
 * Rebuilds attendance for whichever days the unprocessed punches touch.
 *
 * Works day by day from every punch on that day, not incrementally from the new ones: a late
 * arriving batch can contain a punch earlier than one already recorded, and an incremental update
 * would leave the check-in time wrong with nothing to show why.
 */
export async function rollupPunches(options?: { userId?: string; from?: Date; to?: Date; rebuild?: boolean }): Promise<RollupResult> {
  // Rebuilding: every day a mapped punch touches is worked out again, not only the new ones — how days
  // written before a fix to these rules are put right. Leave and hand-corrected days are still left alone.
  if (options?.rebuild) {
    await db.biometricPunch.updateMany({ where: { userId: options.userId ?? { not: null }, processedAt: { not: null } }, data: { processedAt: null } });
  }
  const pending = await db.biometricPunch.findMany({
    where: {
      processedAt: null,
      userId: options?.userId ?? { not: null },
      ...(options?.from || options?.to
        ? { punchedAt: { ...(options.from ? { gte: options.from } : {}), ...(options.to ? { lte: options.to } : {}) } }
        : {}),
    },
    select: { id: true, userId: true, punchedAt: true },
    orderBy: { punchedAt: "asc" },
  });

  if (pending.length === 0) return { daysWritten: 0, punchesProcessed: 0, skipped: [] };

  // Group into the (person, day) buckets that need rebuilding.
  const buckets = new Map<string, { userId: string; date: Date }>();
  for (const punch of pending) {
    if (!punch.userId) continue;
    const date = dateOnly(punch.punchedAt);
    buckets.set(`${punch.userId}:${toKey(date)}`, { userId: punch.userId, date });
  }

  const skipped: RollupResult["skipped"] = [];
  let daysWritten = 0;

  for (const { userId, date } of buckets.values()) {
    const written = await rollupDay(userId, date, skipped);
    if (written) daysWritten += 1;
  }

  await db.biometricPunch.updateMany({
    where: { id: { in: pending.map((p) => p.id) } },
    data: { processedAt: new Date() },
  });

  return { daysWritten, punchesProcessed: pending.length, skipped };
}

async function rollupDay(userId: string, date: Date, skipped: RollupResult["skipped"]): Promise<boolean> {
  const dayStart = date;
  const dayEnd = new Date(date.getTime() + 24 * 60 * 60 * 1000 - 1);

  const existing = await db.attendanceDay.findUnique({
    where: { userId_date: { userId, date } },
    select: { id: true, leaveRequestId: true, regularisedAt: true, status: true },
  });

  if (existing?.leaveRequestId) {
    skipped.push({ date: toKey(date), userId, why: "approved leave — punches recorded but the day was left as leave" });
    return false;
  }
  if (existing?.regularisedAt) {
    skipped.push({ date: toKey(date), userId, why: "corrected by hand — a device re-sync does not undo that" });
    return false;
  }

  const punches = await db.biometricPunch.findMany({
    where: { userId, punchedAt: { gte: dayStart, lte: dayEnd } },
    select: { punchedAt: true, device: { select: { timezone: true } } },
    orderBy: { punchedAt: "asc" },
  });
  if (punches.length === 0) return false;

  const first = punches[0];
  const last = punches[punches.length - 1];
  const checkInAt = punchInstant(first.punchedAt, first.device.timezone);
  // A single punch means they clocked in and never clocked out. Recording the same stamp as both
  // would claim a zero-minute day, which reads as a bug rather than as the missing punch it is.
  const checkOutAt = punches.length > 1 ? punchInstant(last.punchedAt, last.device.timezone) : null;
  const workedMinutes = checkOutAt
    ? Math.max(0, Math.round((checkOutAt.getTime() - checkInAt.getTime()) / 60000))
    : null;

  await db.attendanceDay.upsert({
    where: { userId_date: { userId, date } },
    create: { userId, date, status: "PRESENT", checkInAt, checkOutAt, workedMinutes },
    update: { status: "PRESENT", checkInAt, checkOutAt, workedMinutes },
  });
  return true;
}

/**
 * Attaches punches to people, by matching the terminal's enrolment number.
 *
 * Run after every batch and again whenever somebody is newly mapped, which is the point of keeping
 * unmatched punches rather than discarding them: enrol a finger today, map the number next week,
 * and the week's attendance appears rather than being lost.
 */
export async function linkPunchesToUsers(deviceUserIds?: string[]): Promise<number> {
  const unlinked = await db.biometricPunch.findMany({
    where: { userId: null, ...(deviceUserIds ? { deviceUserId: { in: deviceUserIds } } : {}) },
    select: { id: true, deviceUserId: true },
  });
  if (unlinked.length === 0) return 0;

  const ids = [...new Set(unlinked.map((p) => p.deviceUserId))];
  const profiles = await db.employeeProfile.findMany({
    where: { biometricId: { in: ids } },
    select: { userId: true, biometricId: true },
  });
  if (profiles.length === 0) return 0;

  const byBiometricId = new Map(profiles.map((p) => [p.biometricId!, p.userId]));

  let linked = 0;
  for (const [biometricId, userId] of byBiometricId) {
    const result = await db.biometricPunch.updateMany({
      where: { userId: null, deviceUserId: biometricId },
      data: { userId },
    });
    linked += result.count;
  }
  return linked;
}

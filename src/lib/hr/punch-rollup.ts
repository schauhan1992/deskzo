import { db } from "@/lib/db";
import { dateOnly, toKey } from "@/lib/hr/calendar";
import { clockFor } from "@/lib/time/zone";
import { notMigratedYet } from "@/lib/not-migrated";

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
 *   4. A clocking from the app or the web the same day is never written over (owner, 22 Oct 2026): the day
 *      runs from the earliest of the punches and the clockings to the latest. Clocked in on the phone at 09:30
 *      and punched out at the terminal at 18:30 is in at 09:30 and out at 18:30 — not "in at 18:30", as when
 *      the punches alone decided.
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
    const written = await rollupDay(userId, date, skipped, !!options?.rebuild);
    if (written) daysWritten += 1;
  }

  await db.biometricPunch.updateMany({
    where: { id: { in: pending.map((p) => p.id) } },
    data: { processedAt: new Date() },
  });

  return { daysWritten, punchesProcessed: pending.length, skipped };
}

async function rollupDay(userId: string, date: Date, skipped: RollupResult["skipped"], rebuild: boolean): Promise<boolean> {
  const dayStart = date;
  const dayEnd = new Date(date.getTime() + 24 * 60 * 60 * 1000 - 1);

  const existing = await db.attendanceDay.findUnique({
    where: { userId_date: { userId, date } },
    select: { id: true, leaveRequestId: true, regularisedAt: true, status: true, checkInAt: true, checkOutAt: true },
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

  const punched = punches.map((p) => punchInstant(p.punchedAt, p.device.timezone));
  // The app's and the web's clockings that day — each one kept by src/lib/hr/clock.ts, location or not.
  const clocked = await db.attendanceLocation
    .findMany({ where: { userId, date }, select: { at: true } })
    .then((rows) => rows.map((c) => c.at))
    .catch((err) => {
      if (notMigratedYet(err)) return [] as Date[];
      throw err;
    });
  // What the day already says counts too: a clocking from before each one was kept. Rebuilding — to put right
  // days the punches alone once wrote wrong — only an earlier clock-in than every punch is taken from it, which
  // no punch can have written.
  const firstPunch = Math.min(...punched.map((d) => d.getTime()));
  const already = rebuild
    ? [existing?.checkInAt].filter((d): d is Date => !!d && d.getTime() < firstPunch)
    : [existing?.checkInAt, existing?.checkOutAt].filter((d): d is Date => !!d);
  const moments = [...punched, ...clocked, ...already].sort((a, b) => a.getTime() - b.getTime());

  const checkInAt = moments[0]!;
  const latest = moments[moments.length - 1]!;
  // A single moment means they clocked in and never clocked out. Recording the same stamp as both
  // would claim a zero-minute day, which reads as a bug rather than as the missing punch it is.
  const checkOutAt = latest.getTime() > checkInAt.getTime() ? latest : null;
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

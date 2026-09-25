import { db } from "@/lib/db";
import { getSecurityPolicy } from "@/lib/security/store";

/**
 * Deleting activity rows older than the retention the admin set.
 *
 * Without this, `retentionDays` on the settings screen would be a number that changes nothing — a
 * setting that claims a behaviour it does not have is worse than no setting, because somebody
 * eventually answers a compliance question with it.
 *
 * Two deliberate choices:
 *
 *   - It runs from the marketing tick rather than on its own schedule. That endpoint is already
 *     hit every few minutes by the external cron; adding a second thing to schedule is a second
 *     thing to notice has stopped.
 *   - It deletes in bounded batches. A year of accumulated rows deleted in one statement takes a
 *     long lock on the table that everything else writing to it then waits behind — and the things
 *     writing to it are sign-ins.
 */

const BATCH = 5_000;
/** Bounds a single run: the rest is caught by the next tick a few minutes later. */
const MAX_BATCHES = 10;

export async function purgeExpiredActivity(): Promise<{ deleted: number; cutoff: Date | null }> {
  const policy = await getSecurityPolicy();
  if (policy.retentionDays <= 0) return { deleted: 0, cutoff: null };

  const cutoff = new Date(Date.now() - policy.retentionDays * 24 * 60 * 60_000);
  let deleted = 0;

  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    // `deleteMany` has no LIMIT, so the ids are selected first and deleted by primary key. One
    // extra round trip per batch, in exchange for never holding a lock longer than 5,000 rows.
    const doomed = await db.activityLog.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true },
      take: BATCH,
    });
    if (doomed.length === 0) break;

    const result = await db.activityLog.deleteMany({ where: { id: { in: doomed.map((r) => r.id) } } });
    deleted += result.count;
    if (doomed.length < BATCH) break;
  }

  // Yesterday's screenshot counters are of no interest once the day is over — the evidence is the
  // activity row, which is subject to the retention above. Kept a fortnight so "how many did they
  // take last week" is still answerable directly.
  const allowanceCutoff = new Date(Date.now() - 14 * 24 * 60 * 60_000).toISOString().slice(0, 10);
  await db.screenshotAllowance.deleteMany({ where: { day: { lt: allowanceCutoff } } });

  // Sign-ins carry where somebody was — personal data about staff — so they are kept exactly as
  // long as the activity log and no longer. An address nobody has come from in that time goes too.
  // Sessions still open are left alone whatever their age: ending one depends on its row.
  const signIns = await db.signIn.deleteMany({ where: { at: { lt: cutoff }, OR: [{ endedAt: { not: null } }, { lastSeenAt: { lt: cutoff } }] } });
  await db.networkAddress.deleteMany({ where: { lastSeenAt: { lt: cutoff } } });
  deleted += signIns.count;

  return { deleted, cutoff };
}

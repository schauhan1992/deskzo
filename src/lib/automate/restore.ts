import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { requestWakeHere } from "@/lib/automate/wake";

/**
 * After a workspace's database is put back from a backup (scripts/restore-worker.ts), inside the
 * workspace (Deskzo Automate, Phase 8).
 *
 * Runs a worker was carrying when the backup was taken come back held by it: queued again, so any
 * worker takes them up now — and a worker still carrying that run from before the restore finds it no
 * longer holds it (its next checkpoint fails) and lets it go, rather than write its later state into
 * the earlier database. Then the workspace is woken, so what is due goes on without waiting for the
 * next sweep. Steps that went outside Deskzo after the backup are caught when the runs reach them
 * again (src/lib/automate/sent.ts).
 */
export async function afterRestore(now: Date = new Date()): Promise<{ released: number }> {
  let released = 0;
  try {
    released = (await db.automationRun.updateMany({ where: { status: "RUNNING" }, data: { status: "QUEUED", lockedBy: null, lockedUntil: null, runAfter: now } })).count;
    // Anything else still marked as held — a waiting run keeps its time.
    await db.automationRun.updateMany({ where: { lockedBy: { not: null } }, data: { lockedBy: null, lockedUntil: null } });
  } catch (err) {
    // A backup from before Automate: nothing of it to let go.
    if (!notMigratedYet(err)) throw err;
  }
  await requestWakeHere(now);
  return { released };
}

import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { advanceEnrolments, runEnrolments } from "@/lib/marketing/enrol";
import { sendQueued } from "@/lib/marketing/pipeline";
import { purgeExpiredActivity } from "@/lib/security/retention";

/**
 * One pass of the scheduler.
 *
 * Three phases, in this order and for a reason: find who should be in a sequence, move everyone
 * already in one, then send whatever is now due. Sending first would mean a message enrolled this
 * minute waits five more for no reason.
 *
 * The run is recorded whether it succeeds or not. A cron that silently stopped is the classic way
 * this whole module fails, and the only way to notice is to have written down that it ran.
 */

/** Past this with no completed run, the app says so rather than quietly sending nothing. */
export const STALE_AFTER_MINUTES = 30;

export type TickResult = {
  runId: string;
  enrolled: number;
  stepped: number;
  exited: number;
  claimed: number;
  sent: number;
  failed: number;
  tasks: number;
  ms: number;
};

export async function runMarketingTick(origin: string): Promise<TickResult> {
  const runId = randomBytes(8).toString("hex");
  const started = Date.now();
  const tick = await db.marketingTick.create({ data: { runId }, select: { id: true } });

  try {
    const { enrolled } = await runEnrolments();
    const moved = await advanceEnrolments(origin);
    const sent = await sendQueued(runId);

    // Piggy-backed on the one job that is already scheduled. Wrapped separately because expiring
    // old log rows is housekeeping: it must never be the reason a tick reports a failure and stops
    // sending mail.
    try {
      await purgeExpiredActivity();
    } catch (err) {
      console.error("purgeExpiredActivity failed", err);
    }

    await db.marketingTick.update({
      where: { id: tick.id },
      data: {
        finishedAt: new Date(),
        enrolled,
        claimed: sent.claimed,
        sent: sent.sent,
        failed: sent.failed,
      },
    });

    return {
      runId,
      enrolled,
      stepped: moved.stepped,
      exited: moved.exited,
      tasks: moved.tasks,
      claimed: sent.claimed,
      sent: sent.sent,
      failed: sent.failed,
      ms: Date.now() - started,
    };
  } catch (err) {
    // Recorded on the run rather than only logged, so a failing tick is visible in the app instead
    // of only in whatever is tailing stdout.
    await db.marketingTick.update({
      where: { id: tick.id },
      data: { finishedAt: new Date(), error: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}

export type TickHealth = {
  lastRunAt: Date | null;
  minutesAgo: number | null;
  stale: boolean;
  lastError: string | null;
  /** Queued messages whose send time has already passed — what the silence is costing. */
  waiting: number;
};

/** Whether the scheduler is actually running, for the banner on the marketing page. */
export async function tickHealth(): Promise<TickHealth> {
  const [last, waiting] = await Promise.all([
    db.marketingTick.findFirst({
      where: { finishedAt: { not: null } },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true, error: true },
    }),
    db.marketingMessage.count({ where: { status: "QUEUED", scheduledFor: { lte: new Date() } } }),
  ]);

  if (!last) {
    return { lastRunAt: null, minutesAgo: null, stale: true, lastError: null, waiting };
  }
  const minutesAgo = Math.floor((Date.now() - last.startedAt.getTime()) / 60000);
  return {
    lastRunAt: last.startedAt,
    minutesAgo,
    stale: minutesAgo > STALE_AFTER_MINUTES,
    lastError: last.error,
    waiting,
  };
}

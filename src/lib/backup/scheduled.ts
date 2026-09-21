import { db } from "@/lib/db";
import { runBackup, settleStaleRuns, type BackupOutcome } from "@/lib/backup/run";
import { DEFAULT_BACKUP_DIR, DEFAULT_KEEP_DAYS, DEFAULT_KEEP_MINIMUM } from "@/lib/backup/policy";
import path from "node:path";
import {
  DEFAULT_HOUR,
  DEFAULT_MINUTE,
  RUNNING_PRESUMED_DEAD_MINUTES,
  dueNow,
  nextRunAfter,
  normaliseSchedule,
  type Due,
  type Schedule,
  type ScheduleState,
} from "@/lib/backup/schedule";

/**
 * The schedule as stored, and the one function that acts on it.
 *
 * Deliberately not a `"use server"` module, for the same reason as `run.ts`: every export from one
 * is a public endpoint, and `runScheduledBackup` spawns pg_dump. The callable surface is
 * `src/actions/backup.ts` and the two drivers — `npm run db:backup -- --if-due` and the tick route.
 */

export type StoredSchedule = Schedule & {
  keepDays: number;
  keepMinimum: number;
  updatedAt: Date | null;
  updatedByName: string | null;
  /** True when nobody has ever saved one and these are just the defaults. */
  isDefault: boolean;
};

/**
 * Reads the schedule, falling back the whole way down.
 *
 * Row, then environment, then the constants — so an instance that has never opened the settings
 * page still behaves sensibly, and one configured through env vars before this table existed keeps
 * the behaviour it had.
 */
export async function loadSchedule(): Promise<StoredSchedule> {
  const row = await db.backupSchedule.findUnique({
    where: { id: "global" },
    include: { updatedBy: { select: { name: true } } },
  });

  const base = normaliseSchedule(
    row ? { enabled: row.enabled, hour: row.hour, minute: row.minute } : { hour: DEFAULT_HOUR, minute: DEFAULT_MINUTE },
  );

  return {
    ...base,
    keepDays: row?.keepDays ?? (Number(process.env.BACKUP_KEEP_DAYS) || DEFAULT_KEEP_DAYS),
    keepMinimum: row?.keepMinimum ?? (Number(process.env.BACKUP_KEEP_MINIMUM) || DEFAULT_KEEP_MINIMUM),
    updatedAt: row?.updatedAt ?? null,
    updatedByName: row?.updatedBy?.name ?? null,
    isDefault: !row,
  };
}

/** What the schedule needs to know about what has happened so far. */
export async function scheduleState(): Promise<ScheduleState> {
  const [succeeded, failed, running] = await Promise.all([
    db.backup.findFirst({
      where: { status: "SUCCEEDED" },
      orderBy: { finishedAt: "desc" },
      select: { finishedAt: true },
    }),
    db.backup.findFirst({
      where: { status: "FAILED" },
      orderBy: { finishedAt: "desc" },
      select: { finishedAt: true },
    }),
    // The *oldest* one still running, so a stuck row from last week is what gets judged against the
    // presumed-dead threshold rather than being hidden behind a newer one.
    db.backup.findFirst({ where: { status: "RUNNING" }, orderBy: { startedAt: "asc" }, select: { startedAt: true } }),
  ]);

  return {
    lastSucceededAt: succeeded?.finishedAt ?? null,
    lastFailedAt: failed?.finishedAt ?? null,
    runningSince: running?.startedAt ?? null,
  };
}

export type ScheduledRun =
  | { ran: true; reason: string; outcome: BackupOutcome }
  | { ran: false; reason: string; nextRunAt: Date | null };

/**
 * One knock.
 *
 * Called every few minutes by something outside the app, and almost every call does nothing. That
 * is the design working, not a wasted call: the cheap part runs constantly so the expensive part
 * can be decided here rather than in a scheduler nobody can see from the settings page.
 */
export async function runScheduledBackup(now = new Date()): Promise<ScheduledRun> {
  /**
   * Before anything is decided. A row stuck at RUNNING blocks the schedule, and the commonest cause
   * of one is a restore rather than a crash — so this has to run on the knock, not only after a
   * successful backup, or a restored instance would have to wait for a backup it will never take.
   */
  await settleStaleRuns(path.resolve(process.env.BACKUP_DIR?.trim() || DEFAULT_BACKUP_DIR), now);

  const schedule = await loadSchedule();
  const state = await scheduleState();
  const verdict: Due = dueNow(schedule, state, now);

  if (!verdict.due) {
    return { ran: false, reason: verdict.reason, nextRunAt: verdict.nextRunAt };
  }

  const outcome = await runBackup({
    // Null: not a person. The `via` column records which tool ran it.
    triggeredById: null,
    keepDays: schedule.keepDays,
    keepMinimum: schedule.keepMinimum,
  });

  return { ran: true, reason: verdict.reason, outcome };
}

/** For the settings page: when the next one is expected, or null if it never is. */
export function nextRunFor(schedule: Schedule, now = new Date()): Date | null {
  return schedule.enabled ? nextRunAfter(now, schedule) : null;
}

/** Exported so the page can explain a stuck `RUNNING` row in the same words the scheduler uses. */
export { RUNNING_PRESUMED_DEAD_MINUTES };

/**
 * When the automatic backup should run, and — more importantly — when it should not.
 *
 * ## The shape of this
 *
 * Nothing inside a Next.js app can wake itself up at two in the morning. Something outside has to
 * knock: a Windows scheduled task, a cron entry, a hosted pinger. The obvious design is to put the
 * time in that scheduler — and it is the wrong one, because then "back up at 2am" lives on the
 * server, changing it needs a login to the box, and the settings page can only lie about it.
 *
 * So the knock is deliberately dumb. Something hits `--if-due` (or the tick endpoint) every few
 * minutes, forever, and never changes. This file decides whether any given knock is the one that
 * takes a backup. The schedule is a row in the database, editable by whoever holds the permission.
 *
 * ## Catching up, which is the whole point
 *
 * The rule is *not* "fire at 02:00". It is "**a backup is due if none has succeeded since today's
 * scheduled time, and that time has passed**". Those differ on exactly the day it matters: the
 * machine was off at 2am, or the app was mid-deploy, or the dump failed. Under "fire at 02:00" that
 * day simply has no backup, and nobody finds out. Under this rule the next knock after the machine
 * comes back takes one.
 *
 * It also cannot double-fire, and that falls out of the same sentence rather than needing a lock:
 * the moment a backup succeeds, `lastSucceededAt` is after today's scheduled time, so it is no
 * longer due.
 *
 * Everything here is pure and covered by `scripts/check-backup.ts`.
 */

export const DEFAULT_HOUR = 2;
export const DEFAULT_MINUTE = 0;

/**
 * How long to leave a failed attempt alone.
 *
 * Without this, a backup that fails at 02:00 is still due at 02:05, and at 02:10, and every knock
 * until midnight — a few hundred attempts, a few hundred failure rows, and a log in which the one
 * useful fact is buried. An hour is long enough to stop the hammering and short enough that a
 * transient failure still produces a backup that night.
 */
export const RETRY_AFTER_MINUTES = 60;

/**
 * When a `RUNNING` row stops meaning "a backup is in progress" and starts meaning "something died".
 *
 * A dump holds a transaction and writes a file; starting a second one alongside it is how you get
 * two half-written files and a load spike. But a process killed mid-dump leaves its row `RUNNING`
 * for ever, and a schedule that respects that row for ever has quietly switched itself off. Two
 * hours is far longer than any dump this app takes and far shorter than a night.
 */
export const RUNNING_PRESUMED_DEAD_MINUTES = 120;

export type Schedule = {
  enabled: boolean;
  /** Local time on the machine that runs the backup — see `scheduledTimeOn`. */
  hour: number;
  minute: number;
};

export type ScheduleState = {
  lastSucceededAt: Date | null;
  lastFailedAt: Date | null;
  /** When the oldest run still marked `RUNNING` started, if there is one. */
  runningSince: Date | null;
};

export type Due =
  | { due: true; reason: string }
  | { due: false; reason: string; nextRunAt: Date | null };

/** Hour and minute forced into something a clock could show, so a bad row cannot wedge the schedule. */
export function normaliseSchedule(schedule: Partial<Schedule> | null | undefined): Schedule {
  const hour = Math.min(23, Math.max(0, Math.trunc(Number(schedule?.hour ?? DEFAULT_HOUR)) || 0));
  const minute = Math.min(59, Math.max(0, Math.trunc(Number(schedule?.minute ?? DEFAULT_MINUTE)) || 0));
  return { enabled: Boolean(schedule?.enabled), hour, minute };
}

/**
 * Today's scheduled moment, in the server's own time zone.
 *
 * Local rather than UTC, deliberately. "Two in the morning" means two in the morning where the
 * business is, and the whole reason for picking that time is that nobody is working — a schedule
 * that drifts an hour twice a year, or sits at 07:30 local because somebody thought in UTC, has
 * lost the only property that made the time worth choosing. `backupFilename` stamps local time for
 * the same reason, so a folder listing and this agree.
 */
export function scheduledTimeOn(day: Date, schedule: Schedule): Date {
  const at = new Date(day);
  at.setHours(schedule.hour, schedule.minute, 0, 0);
  return at;
}

/** The next moment it will fire, from `now`. Today's if that is still ahead, otherwise tomorrow's. */
export function nextRunAfter(now: Date, schedule: Schedule): Date {
  const today = scheduledTimeOn(now, schedule);
  if (today.getTime() > now.getTime()) return today;
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return scheduledTimeOn(tomorrow, schedule);
}

const minutes = (ms: number) => ms / 60000;

/**
 * Whether this knock is the one.
 *
 * Every refusal carries its reason, because the question somebody actually asks is never "is it
 * due" — it is "why has it not run". A boolean cannot answer that, and a scheduler that skips
 * silently is indistinguishable from one that is broken.
 */
export function dueNow(schedule: Schedule, state: ScheduleState, now: Date): Due {
  if (!schedule.enabled) {
    return { due: false, reason: "Automatic backups are switched off.", nextRunAt: null };
  }

  if (state.runningSince && minutes(now.getTime() - state.runningSince.getTime()) < RUNNING_PRESUMED_DEAD_MINUTES) {
    return { due: false, reason: "A backup is already running.", nextRunAt: null };
  }

  const todaysRun = scheduledTimeOn(now, schedule);

  if (now.getTime() < todaysRun.getTime()) {
    return { due: false, reason: "Today's backup is not due yet.", nextRunAt: todaysRun };
  }

  if (state.lastSucceededAt && state.lastSucceededAt.getTime() >= todaysRun.getTime()) {
    return {
      due: false,
      reason: "Today's backup has already been taken.",
      nextRunAt: nextRunAfter(now, schedule),
    };
  }

  if (state.lastFailedAt) {
    const since = minutes(now.getTime() - state.lastFailedAt.getTime());
    if (since >= 0 && since < RETRY_AFTER_MINUTES) {
      return {
        due: false,
        reason: `The last attempt failed. Waiting ${Math.ceil(RETRY_AFTER_MINUTES - since)} more minutes before trying again.`,
        nextRunAt: new Date(state.lastFailedAt.getTime() + RETRY_AFTER_MINUTES * 60000),
      };
    }
  }

  // Said two different ways because they are two different situations, and somebody reading the log
  // at nine in the morning needs to know which one they are looking at.
  const late = minutes(now.getTime() - todaysRun.getTime());
  return {
    due: true,
    reason:
      late < 15
        ? `Due at ${formatTimeOfDay(schedule.hour, schedule.minute)}.`
        : `Due at ${formatTimeOfDay(schedule.hour, schedule.minute)} and not taken — catching up.`,
  };
}

/** `"02:00"`, the value an `<input type="time">` reads and writes. */
export function formatTimeOfDay(hour: number, minute: number): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(hour)}:${p(minute)}`;
}

/**
 * Reads `"02:00"` back, or null.
 *
 * Null rather than a default, because this parses something a person typed. Silently turning an
 * unreadable time into 02:00 would tell them the schedule was saved and then run it at a time they
 * did not choose.
 */
export function parseTimeOfDay(value: string | null | undefined): { hour: number; minute: number } | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec((value ?? "").trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** One line for a settings page. */
export function describeSchedule(schedule: Schedule): string {
  if (!schedule.enabled) return "Automatic backups are off.";
  return `Every day at ${formatTimeOfDay(schedule.hour, schedule.minute)}, server time.`;
}

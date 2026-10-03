/**
 * The decisions a backup makes, separated from the process that runs one.
 *
 * Everything here is pure and covered by `scripts/check-backup.ts`, because the two things that go
 * wrong with backups are both decisions rather than mechanics: deleting the wrong old ones, and
 * restoring into an instance that cannot read what it just restored.
 */

/** Where dumps go when nothing says otherwise. Relative to the working directory. */
export const DEFAULT_BACKUP_DIR = "backups";

/** Anything older is pruned — unless keeping it is the only way to have any, see `prunable`. */
export const DEFAULT_KEEP_DAYS = 14;

/**
 * However old they are, this many are always kept.
 *
 * The case this exists for: the nightly job breaks in December and nobody notices until March. With
 * age alone, by March every backup has aged out and the folder is empty — the retention policy
 * having carefully destroyed the last copies of a database nobody was backing up any more. Keeping
 * a floor means a broken schedule leaves stale backups rather than none.
 */
export const DEFAULT_KEEP_MINIMUM = 3;

/** A warning appears once no successful backup has been taken for this long. */
export const STALE_AFTER_HOURS = 36;

/**
 * `deskzo-2026-09-20-1432.dump` — sortable, and obvious what it is a year later.
 *
 * Stamped in the server's own time: a file on the server's disk, read in its folder listings. The
 * schedule that takes it runs on the workspace's clock (src/lib/backup/schedule.ts), so on a server
 * in another zone the stamp and the scheduled time differ — the stamp names the file, it is not the
 * schedule.
 */
export function backupFilename(at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return [
    "deskzo",
    `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`,
    `${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`,
  ].join("-") + ".dump";
}

export type Connection = {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
};

/**
 * Pulls the connection apart, because `pg_dump` takes its pieces as flags rather than a URL.
 *
 * Returns null rather than throwing on anything it does not understand: a malformed `DATABASE_URL`
 * should produce "backups are not configured" on a settings page, not a crash on a page nobody was
 * asking about backups from.
 */
export function parseDatabaseUrl(url: string | undefined): Connection | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!parsed.protocol.startsWith("postgres")) return null;
    const database = parsed.pathname.replace(/^\//, "");
    if (!database) return null;
    return {
      host: parsed.hostname,
      port: parsed.port || "5432",
      user: decodeURIComponent(parsed.username),
      // Passwords routinely contain characters that have to be escaped in a URL.
      password: decodeURIComponent(parsed.password),
      database,
    };
  } catch {
    return null;
  }
}

export type BackupFile = {
  filename: string;
  takenAt: Date;
  /** A run still in progress, or one that failed. Never pruned by age — see below. */
  keep?: boolean;
};

/**
 * Which backups may be deleted.
 *
 * Three rules, and the order matters:
 *
 * 1. Anything marked `keep` is never touched. That covers a run still in progress, whose file is
 *    half written, and whose deletion would take the dump out from under pg_dump.
 * 2. The newest `keepMinimum` survive regardless of age.
 * 3. Whatever is left and older than `keepDays` goes.
 *
 * Expressed as "what to delete" rather than "what to keep" on purpose, so a caller cannot misread
 * the list and delete its complement. The function never returns everything: if the rules would
 * remove every file it returns none, because a retention policy that empties the folder has
 * misunderstood its job.
 */
export function prunable(
  files: BackupFile[],
  now: Date,
  options?: { keepDays?: number; keepMinimum?: number },
): BackupFile[] {
  const keepDays = options?.keepDays ?? DEFAULT_KEEP_DAYS;
  const keepMinimum = Math.max(1, options?.keepMinimum ?? DEFAULT_KEEP_MINIMUM);

  const newestFirst = [...files].sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime());
  const cutoff = now.getTime() - keepDays * 86400000;

  const doomed = newestFirst.filter((file, index) => {
    if (file.keep) return false;
    if (index < keepMinimum) return false;
    return file.takenAt.getTime() < cutoff;
  });

  // The belt to the braces above. Nothing should be able to produce an empty folder.
  return doomed.length >= files.length ? [] : doomed;
}

export type Staleness = { stale: boolean; hoursSince: number | null; message: string };

/**
 * Whether anybody should be told the backups have stopped.
 *
 * "Never" is worse than "old" and says so differently. A page showing the last backup as three days
 * ago is a prompt; a page saying nothing at all because there is nothing to show is how a system
 * goes a year without one.
 */
export function stalenessOf(lastSucceededAt: Date | null, now: Date, warnAfterHours = STALE_AFTER_HOURS): Staleness {
  if (!lastSucceededAt) {
    return { stale: true, hoursSince: null, message: "No backup has ever completed." };
  }
  const hoursSince = Math.floor((now.getTime() - lastSucceededAt.getTime()) / 3600000);
  if (hoursSince >= warnAfterHours) {
    const days = Math.floor(hoursSince / 24);
    return {
      stale: true,
      hoursSince,
      message: days >= 1 ? `The last backup was ${days} day${days === 1 ? "" : "s"} ago.` : `The last backup was ${hoursSince} hours ago.`,
    };
  }
  return { stale: false, hoursSince, message: "" };
}

/** Human sizes, for a list where the interesting thing is a file suddenly being much smaller. */
export function formatBytes(bytes: number | bigint | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

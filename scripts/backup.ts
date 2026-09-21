/**
 * Takes one backup, from the command line.
 *
 * This is what a scheduler calls. Windows Task Scheduler, cron, a systemd timer — the app has no
 * job runner of its own, and inventing one so that backups can be scheduled would put the most
 * important recurring job in the system inside the process most likely to be restarted.
 *
 *   npm run db:backup                 take one now, whatever the schedule says
 *   npm run db:backup -- --if-due     take one only if the stored schedule says it is time
 *
 * ## Which of those to put in the scheduler
 *
 * `--if-due`, every five or ten minutes. It looks wasteful and is the opposite: the scheduled task
 * becomes dumb and permanent, and *the time of day lives in the app*, where somebody with the
 * permission can change it without a login to the server. Set it once, never touch it again.
 *
 * Point the task at plain `npm run db:backup` instead and the time is in Task Scheduler, the
 * settings page can only lie about it, and the two drift the first time anybody changes one.
 *
 * It runs with the web app stopped, which is the other reason this is the recommended driver: the
 * only thing that has to be up is the database, and the database has to be up to be backed up.
 *
 * Exits non-zero when the backup failed, so a scheduler that watches exit codes notices. A backup
 * job that always exits zero is a backup job nobody is monitoring. A skipped run is *not* a
 * failure — `--if-due` exits zero when there is nothing to do, because almost every run is that.
 */
import "dotenv/config";
import { runBackup } from "../src/lib/backup/run";
import { runScheduledBackup } from "../src/lib/backup/scheduled";
import { formatBytes } from "../src/lib/backup/policy";
import { formatTimeOfDay } from "../src/lib/backup/schedule";
import { db } from "../src/lib/db";

function report(result: Awaited<ReturnType<typeof runBackup>>, seconds: number): void {
  if (!result.ok) {
    console.error(`\n  Backup FAILED after ${seconds}s\n`);
    console.error(`  ${result.error}\n`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n  ${result.filename}`);
  console.log(`  ${formatBytes(result.sizeBytes)} in ${seconds}s, via ${result.via}`);
  if (result.pruned > 0) console.log(`  ${result.pruned} older backup(s) pruned`);
  console.log(
    "\n  This file is on the same machine as the database it came from, which means it is not yet\n" +
      "  a backup. Copy it somewhere else.\n",
  );
}

async function main() {
  const ifDue = process.argv.slice(2).includes("--if-due");
  const started = Date.now();

  if (ifDue) {
    const run = await runScheduledBackup();
    if (!run.ran) {
      // One line, on purpose. This runs every few minutes for years; anything more and the log it
      // writes to becomes the largest file on the disk.
      const next = run.nextRunAt ? ` Next: ${formatTimeOfDay(run.nextRunAt.getHours(), run.nextRunAt.getMinutes())}.` : "";
      console.log(`Skipped — ${run.reason}${next}`);
      return;
    }
    console.log(`Scheduled backup — ${run.reason}`);
    report(run.outcome, Math.round((Date.now() - started) / 1000));
    return;
  }

  report(await runBackup(), Math.round((Date.now() - started) / 1000));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());

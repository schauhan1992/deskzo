"use server";

import path from "node:path";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { DEFAULT_BACKUP_DIR, stalenessOf } from "@/lib/backup/policy";
import { filesOnDisk, resolveDumpTool, runBackup } from "@/lib/backup/run";
import { loadSchedule, nextRunFor, scheduleState, type StoredSchedule } from "@/lib/backup/scheduled";
import { dueNow, parseTimeOfDay } from "@/lib/backup/schedule";
import type { ActionResult } from "@/actions/company";

/**
 * The backup log, and the button that takes one.
 *
 * Restoring is deliberately absent. It drops the schema out from under the connection pool this
 * very request is using, so the app cannot do it to itself — and a restore is a decision somebody
 * should be standing at a terminal to make, with the application stopped. `npm run db:restore` is
 * the whole of that story.
 *
 * Downloading is absent for a different reason: a dump is every order, every password hash and
 * every encrypted secret in one file, and serving that through a session cookie is a large thing to
 * put on the end of a URL. The files sit on the server and somebody copies them off.
 */

export type BackupRow = {
  id: string;
  filename: string;
  directory: string;
  status: "RUNNING" | "SUCCEEDED" | "FAILED";
  startedAt: Date;
  finishedAt: Date | null;
  sizeBytes: number | null;
  error: string | null;
  schemaVersion: string | null;
  via: string | null;
  triggeredByName: string | null;
  /** False when the row is there and the file is not — moved, or deleted by hand. */
  present: boolean;
};

export type BackupOverview = {
  rows: BackupRow[];
  directory: string;
  /** Null when nothing has ever succeeded. */
  lastSucceededAt: Date | null;
  staleness: ReturnType<typeof stalenessOf>;
  /** What the runner found, so a misconfigured box says so before somebody needs a backup. */
  tool: string | null;
  schedule: StoredSchedule;
  /** When the automatic backup is next expected, or null when it is switched off. */
  nextRunAt: Date | null;
  /**
   * What the scheduler would say if it knocked right now.
   *
   * Shown on the page because "it is on, and it has not run" is the state worth catching, and the
   * only way to catch it is to ask the same function the scheduler asks.
   */
  scheduleVerdict: string;
};

export async function backupOverview(): Promise<ActionResult<BackupOverview>> {
  const user = await requireUser();
  if (!(await can(user.id, "backups.manage"))) {
    return { ok: false, error: "You don't have access to backups." };
  }

  const directory = path.resolve(process.env.BACKUP_DIR?.trim() || DEFAULT_BACKUP_DIR);
  const [records, onDisk, tool, schedule, state] = await Promise.all([
    db.backup.findMany({
      orderBy: { startedAt: "desc" },
      take: 50,
      include: { triggeredBy: { select: { name: true } } },
    }),
    filesOnDisk(directory),
    resolveDumpTool("pg_dump"),
    loadSchedule(),
    scheduleState(),
  ]);

  const lastSucceeded = records.find((r) => r.status === "SUCCEEDED")?.finishedAt ?? null;

  return {
    ok: true,
    data: {
      directory,
      lastSucceededAt: lastSucceeded,
      staleness: stalenessOf(lastSucceeded, new Date()),
      tool: tool?.via ?? null,
      schedule,
      nextRunAt: nextRunFor(schedule),
      scheduleVerdict: dueNow(schedule, state, new Date()).reason,
      rows: records.map((r) => ({
        id: r.id,
        filename: r.filename,
        directory: r.directory,
        status: r.status,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        sizeBytes: r.sizeBytes === null ? null : Number(r.sizeBytes),
        error: r.error,
        schemaVersion: r.schemaVersion,
        via: r.via,
        triggeredByName: r.triggeredBy?.name ?? null,
        present: onDisk.has(r.filename),
      })),
    },
  };
}

/**
 * Takes one now.
 *
 * Audited, because "who took a copy of everything, and when" is a question worth being able to
 * answer — a backup is the one operation that produces a complete copy of the system in a file, and
 * an unexplained one appearing on a Sunday night is worth noticing.
 */
export async function takeBackupNow(): Promise<ActionResult<{ filename: string; sizeBytes: number }>> {
  const user = await requireUser();
  if (!(await can(user.id, "backups.manage"))) {
    return { ok: false, error: "You don't have access to backups." };
  }

  const result = await runBackup({ triggeredById: user.id });
  revalidatePath("/settings/backups");

  if (!result.ok) return { ok: false, error: result.error };

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "Backup",
    entityId: result.id,
    entityLabel: result.filename,
  });

  return { ok: true, data: { filename: result.filename, sizeBytes: result.sizeBytes } };
}

/**
 * Saves the schedule.
 *
 * Audited like a security setting, because that is what it is. Switching automatic backups off is
 * silent, invisible on every screen that is not this one, and discovered weeks later — so the log
 * has to remember who did it.
 */
export async function saveBackupSchedule(input: {
  enabled: boolean;
  /** "02:00" — what an <input type="time"> gives back. */
  time: string;
  keepDays: number;
  keepMinimum: number;
}): Promise<ActionResult<StoredSchedule>> {
  const user = await requireUser();
  if (!(await can(user.id, "backups.manage"))) {
    return { ok: false, error: "You don't have access to backups." };
  }

  const at = parseTimeOfDay(input.time);
  if (!at) return { ok: false, error: "That is not a time of day. Use 24-hour HH:MM, for example 02:00." };

  const keepDays = Math.trunc(Number(input.keepDays));
  const keepMinimum = Math.trunc(Number(input.keepMinimum));
  if (!Number.isFinite(keepDays) || keepDays < 1 || keepDays > 3650) {
    return { ok: false, error: "Keep backups for between 1 and 3650 days." };
  }
  /**
   * The floor cannot be zero. It is the rule that stops a broken schedule from ending with an empty
   * folder — see `prunable` — and a settings page that lets somebody type 0 into it has handed
   * them a way to switch that protection off without knowing it was there.
   */
  if (!Number.isFinite(keepMinimum) || keepMinimum < 1 || keepMinimum > 365) {
    return { ok: false, error: "Always keep at least 1 backup, and no more than 365." };
  }

  await db.backupSchedule.upsert({
    where: { id: "global" },
    create: { id: "global", enabled: input.enabled, hour: at.hour, minute: at.minute, keepDays, keepMinimum, updatedById: user.id },
    update: { enabled: input.enabled, hour: at.hour, minute: at.minute, keepDays, keepMinimum, updatedById: user.id },
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "BackupSchedule",
    entityId: "global",
    entityLabel: input.enabled ? `Daily at ${input.time}` : "Automatic backups off",
  });

  revalidatePath("/settings/backups");
  return { ok: true, data: await loadSchedule() };
}

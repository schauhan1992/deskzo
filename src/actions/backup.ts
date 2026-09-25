"use server";

import { revalidatePath } from "next/cache";
import type { BackupKind } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { stalenessOf } from "@/lib/backup/policy";
import { storeSize } from "@/lib/backup/chunks";
import { backupRoot } from "@/lib/backup/maintenance";
import { presentBackups, resolveDumpTool, runBackup } from "@/lib/backup/run";
import { loadSchedule, nextRunFor, scheduleState, type StoredSchedule } from "@/lib/backup/scheduled";
import { dueNow, parseTimeOfDay } from "@/lib/backup/schedule";
import type { ActionResult } from "@/actions/company";

/**
 * The backup log, the button that takes one, and the schedule.
 *
 * Restoring and downloading both exist now, and neither of them is here — they are route handlers
 * under `src/app/api/backups/`. Not for want of trying to keep them together: a server action
 * returns one serialised value over an RPC channel, and neither operation fits through that. A
 * download is the whole database and has to stream, or the server is one large backup away from an
 * OOM. A restore drops the schema the calling request's own connection is reading from, so there is
 * nothing left alive to return to; it hands off to a detached worker and the screen polls a status
 * file. Both need a raw request and response, so both live where one exists.
 *
 * What is left here is the part that genuinely is a form submission: reading the log, starting a
 * run, and saving the schedule.
 */

export type BackupRow = {
  id: string;
  filename: string;
  directory: string;
  status: "RUNNING" | "SUCCEEDED" | "FAILED";
  startedAt: Date;
  finishedAt: Date | null;
  /** The size of the snapshot, whichever way it was stored. */
  sizeBytes: number | null;
  /**
   * What this run actually added to disk, and null for anything taken before the column existed.
   *
   * The same as `sizeBytes` for a FULL backup. For a chunked one it is usually a small fraction of
   * it, and showing only `sizeBytes` would have the folder appear to hold forty times more than it
   * does — which is the question this whole feature exists to answer.
   */
  storedBytes: number | null;
  kind: BackupKind;
  error: string | null;
  schemaVersion: string | null;
  via: string | null;
  triggeredByName: string | null;
  /**
   * False when the row is there and its data is not — moved, or deleted by hand.
   *
   * Two different questions behind one flag: a FULL backup is a file in the folder, a chunked one is
   * a manifest naming pieces of the shared store. `presentBackups` knows which to ask.
   */
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
  /**
   * What the shared chunk store currently occupies.
   *
   * Reported on its own because it belongs to no single backup. Every chunked row's pieces live in
   * here together, so summing the rows neither explains the folder's size nor predicts what
   * deleting one would free — only the store total does.
   */
  store: { chunks: number; bytes: number };
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

  /**
   * One expression for the root, not two. The backup folder and the chunk store's root are the same
   * path by definition, and re-deriving it here is how they would drift: a store looked for beside
   * a folder it is not in reports zero chunks and marks every chunked backup missing.
   */
  const directory = await backupRoot();
  const [records, tool, schedule, state, store] = await Promise.all([
    db.backup.findMany({
      orderBy: { startedAt: "desc" },
      take: 50,
      include: { triggeredBy: { select: { name: true } } },
    }),
    resolveDumpTool("pg_dump"),
    loadSchedule(),
    scheduleState(),
    storeSize(directory),
  ]);

  // Needs the rows themselves: a chunked backup's data is found by row id, not by filename.
  const present = await presentBackups(
    directory,
    records.map((r) => ({ id: r.id, filename: r.filename, kind: r.kind })),
  );

  const lastSucceeded = records.find((r) => r.status === "SUCCEEDED")?.finishedAt ?? null;

  return {
    ok: true,
    data: {
      directory,
      lastSucceededAt: lastSucceeded,
      staleness: stalenessOf(lastSucceeded, new Date()),
      tool: tool?.via ?? null,
      store,
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
        // Both are Prisma BigInts, and a BigInt cannot be serialised across the server/client
        // boundary — left alone it throws at render rather than here.
        sizeBytes: r.sizeBytes === null ? null : Number(r.sizeBytes),
        storedBytes: r.storedBytes === null ? null : Number(r.storedBytes),
        kind: r.kind,
        error: r.error,
        schemaVersion: r.schemaVersion,
        via: r.via,
        triggeredByName: r.triggeredBy?.name ?? null,
        present: present.has(r.id),
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
 *
 * The kind goes in the label rather than being left to the entity id, because the two read nothing
 * alike to somebody scanning the log later: a FULL run is a standalone copy of the entire database
 * that can walk out of the building on a disk, while an INCREMENTAL one usually writes a few
 * hundred kilobytes into a store it cannot be separated from. A line that does not say which it was
 * makes the harmless one look like the serious one, every night.
 */
export async function takeBackupNow(
  kind: BackupKind = "FULL",
): Promise<ActionResult<{ filename: string; sizeBytes: number; storedBytes: number; kind: BackupKind }>> {
  const user = await requireUser();
  if (!(await can(user.id, "backups.manage"))) {
    return { ok: false, error: "You don't have access to backups." };
  }

  /**
   * An argument to a server action arrives from the browser, so the type is a claim rather than a
   * fact. Anything else would be carried all the way into a Prisma enum column and come back as a
   * database error on a half-created RUNNING row, instead of a refusal before anything was started.
   */
  if (kind !== "FULL" && kind !== "INCREMENTAL") {
    return { ok: false, error: "That is not a kind of backup." };
  }

  const result = await runBackup({ kind, triggeredById: user.id });
  revalidatePath("/settings/backups");

  if (!result.ok) return { ok: false, error: result.error };

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "Backup",
    entityId: result.id,
    entityLabel: `${result.kind === "FULL" ? "Full backup" : "Incremental backup"} — ${result.filename}`,
  });

  return {
    ok: true,
    data: {
      filename: result.filename,
      sizeBytes: result.sizeBytes,
      storedBytes: result.storedBytes,
      kind: result.kind,
    },
  };
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

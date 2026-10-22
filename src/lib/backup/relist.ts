import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { BackupKind, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { readSidecar } from "@/lib/backup/sidecar";
import { manifestDir, readManifest } from "@/lib/backup/chunks";
import { backupFilename } from "@/lib/backup/policy";

/**
 * Puts back in the list the backups this workspace's folder holds and its log doesn't (owner, 22 Oct 2026).
 *
 * The log is a table in the workspace's own database, so restoring last week's backup puts back last
 * week's log: every backup taken since — the safety copy taken a minute before the restore among them —
 * vanished from Settings › Backups while its file stayed in the folder. Nobody could restore it from the
 * screen, and the retention, which works from the log, never deleted it either.
 *
 * Every complete backup in the folder describes itself: a full one in the small file beside its dump
 * (src/lib/backup/sidecar.ts), a chunked one in its manifest (src/lib/backup/chunks.ts). A dump with no
 * description is one that never finished, and stays out of the list. Run by the restore worker once the
 * data is back; safe to run any time — a backup already listed is left as it is.
 */
export async function relistBackups(directory: string): Promise<{ full: number; chunked: number }> {
  const rows = await db.backup.findMany({ where: { directory }, select: { id: true, filename: true } });
  const listedNames = new Set(rows.map((r) => r.filename));
  const listedIds = new Set(rows.map((r) => r.id));
  const added = { full: 0, chunked: 0 };

  const files = await readdir(directory).catch(() => [] as string[]);
  for (const filename of files.filter((f) => f.endsWith(".dump") && !f.startsWith("."))) {
    if (listedNames.has(filename)) continue;
    const sidecar = await readSidecar(path.join(directory, filename));
    if (!sidecar) continue;
    const takenAt = new Date(sidecar.takenAt);
    if (Number.isNaN(takenAt.getTime())) continue;
    await addRow({
      filename,
      directory,
      kind: "FULL",
      status: "SUCCEEDED",
      startedAt: takenAt,
      finishedAt: takenAt,
      sizeBytes: sidecar.sizeBytes ? BigInt(sidecar.sizeBytes) : null,
      storedBytes: sidecar.sizeBytes ? BigInt(sidecar.sizeBytes) : null,
      schemaVersion: sidecar.schemaVersion,
      secretFingerprint: sidecar.secretFingerprint,
      via: sidecar.via,
    }, sidecar.reason ?? null, sidecar.keepUntil ?? null);
    added.full += 1;
  }

  const manifests = await readdir(manifestDir(directory)).catch(() => [] as string[]);
  for (const name of manifests.filter((f) => f.endsWith(".json"))) {
    const id = name.slice(0, -".json".length);
    if (listedIds.has(id)) continue;
    const manifest = await readManifest(directory, id);
    if (!manifest) continue;
    // Manifests written before these fields existed: the file's own time is when the backup finished.
    const takenAt = manifest.takenAt ? new Date(manifest.takenAt) : (await stat(path.join(manifestDir(directory), name))).mtime;
    const filename = manifest.filename ?? backupFilename(takenAt).replace(/\.dump$/, ".chunked");
    await addRow({
      id,
      filename,
      directory,
      kind: "INCREMENTAL" as BackupKind,
      status: "SUCCEEDED",
      startedAt: takenAt,
      finishedAt: takenAt,
      sizeBytes: BigInt(manifest.totalBytes),
      storedBytes: BigInt(manifest.newBytes),
      schemaVersion: manifest.schemaVersion ?? null,
      secretFingerprint: manifest.secretFingerprint ?? null,
      via: manifest.via ?? null,
    }, manifest.reason ?? null, manifest.keepUntil ?? null);
    added.chunked += 1;
  }
  return added;
}

/** With its reason and how long it is kept, when the database has those columns yet; without, when not. */
async function addRow(data: Prisma.BackupUncheckedCreateInput, reason: string | null, keepUntil: string | null) {
  const extra = { ...(reason ? { reason } : {}), ...(keepUntil ? { keepUntil: new Date(keepUntil) } : {}) };
  if (Object.keys(extra).length > 0) {
    try {
      await db.backup.create({ data: { ...data, ...extra }, select: { id: true } });
      return;
    } catch {
      // A workspace not migrated yet: listed without them.
    }
  }
  await db.backup.create({ data, select: { id: true } });
}

import path from "node:path";
import { copyFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { secretFingerprint } from "@/lib/backup/fingerprint";
import { readSidecar } from "@/lib/backup/sidecar";
import { MissingChunkError, readManifest, reassemble } from "@/lib/backup/chunks";
import {
  backupRoot,
  clearStaged,
  ensureRestoreDir,
  restoreInProgress,
  stagingPath,
  writeStagedMeta,
} from "@/lib/backup/maintenance";

/**
 * Stages one of this server's own backups for restore, so it can be put back without a round trip.
 *
 * Rolling back to last night is the common case, and making somebody download a file and upload the
 * same bytes again to do it would be ceremony rather than safety — the file never leaves the
 * server, so there is nothing for a passphrase to protect it from. The archive format exists for
 * the journey; this one is not a journey.
 *
 * ## It is copied, not pointed at
 *
 * The worker deletes the staged dump when it finishes, which is right for an upload and would be
 * catastrophic here: pointing it at the original would mean a successful restore *deletes the
 * backup it restored from*. The copy also puts the file out of reach of the pruner, which sweeps
 * the backup folder on a schedule and has no idea a restore is halfway through reading one.
 *
 * The cost is disk — briefly, twice the size of one dump. Worth it against either of those.
 *
 * ## A chunked backup is rebuilt rather than copied
 *
 * It has no file to copy: it is a list of hashes into the shared store, so the snapshot has to be
 * reassembled before a restore can read it. That rebuild writes straight into staging rather than to
 * a temporary file that is then copied — the copy would put a *third* complete database on disk for
 * no gain, and staging is already exactly what it is: a dump waiting to be confirmed, out of the
 * pruner's reach, cleared by the same code that clears every other staged restore.
 */

async function currentMigration(): Promise<string | null> {
  try {
    const rows = await db.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1
    `;
    return rows[0]?.migration_name ?? null;
  } catch {
    return null;
  }
}

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  if (!(await can(user.id, "backups.restore"))) {
    return NextResponse.json({ error: "You don't have access to restore backups." }, { status: 403 });
  }

  if (restoreInProgress()) {
    return NextResponse.json({ error: "A restore is already running." }, { status: 409 });
  }

  const { id } = await context.params;
  const row = await db.backup.findUnique({ where: { id } });
  if (!row || row.status !== "SUCCEEDED") {
    return NextResponse.json({ error: "There is no completed backup with that id." }, { status: 404 });
  }

  const root = backupRoot();
  const dumpPath = path.join(row.directory || root, row.filename);

  // A chunked backup never had a sidecar — there was no file for one to sit beside — so the facts it
  // would have carried are read off the row, which recorded them when the dump was taken.
  const sidecar = row.kind === "INCREMENTAL" ? null : await readSidecar(dumpPath);

  await ensureRestoreDir();
  const stagedId = randomUUID();
  const staged = stagingPath(stagedId, ".dump");

  /** What a restore of this produces, which is the size the confirmation screen quotes. */
  let dumpBytes: number;

  if (row.kind === "INCREMENTAL") {
    const manifest = await readManifest(root, row.id);
    if (!manifest) {
      // The manifest is this backup's equivalent of the file: without it the chunks are an unordered
      // heap and the snapshot is unrecoverable. Same answer as a deleted dump.
      return NextResponse.json(
        { error: "The pieces list for that backup is no longer on the server, so there is nothing to restore from." },
        { status: 410 },
      );
    }

    try {
      await reassemble(root, manifest, staged);
    } catch (err) {
      // A half-built dump in staging is worse than none — the confirmation screen would offer it as
      // restorable — so it goes, along with anything else this id had started to leave behind.
      await clearStaged(stagedId);
      // Its own answer rather than a 500: a pruned or half-copied store is a thing an operator can
      // act on, and the error already says which piece and why.
      if (err instanceof MissingChunkError) return NextResponse.json({ error: err.message }, { status: 410 });
      throw err;
    }
    // Verified by `reassemble` against the manifest's own checksum, so this is the length of the file
    // now in staging rather than a claim about it.
    dumpBytes = manifest.totalBytes;
  } else {
    const info = await stat(dumpPath).catch(() => null);
    if (!info?.isFile()) {
      return NextResponse.json(
        { error: "The file for that backup is no longer on the server, so there is nothing to restore from." },
        { status: 410 },
      );
    }
    await copyFile(dumpPath, staged);
    dumpBytes = info.size;
  }

  /** The secret the *dump* was written under, whichever of the two places still knows it. */
  const takenFingerprint = sidecar?.secretFingerprint ?? row.secretFingerprint ?? null;

  await writeStagedMeta(stagedId, {
    takenAt: (sidecar?.takenAt ?? row.startedAt.toISOString()) || null,
    schemaVersion: row.schemaVersion ?? sidecar?.schemaVersion ?? null,
    secretFingerprint: takenFingerprint,
    source: row.filename,
  });

  const running = secretFingerprint(process.env.AUTH_SECRET);
  const onSchema = await currentMigration();
  const archiveSchema = row.schemaVersion ?? sidecar?.schemaVersion ?? null;

  return NextResponse.json({
    ok: true,
    id: stagedId,
    needsPassphrase: false,
    archive: {
      takenAt: sidecar?.takenAt ?? row.startedAt.toISOString(),
      schemaVersion: archiveSchema,
      dumpBytes,
      via: row.via ?? sidecar?.via ?? null,
      app: "Wroffy ERP",
      /** A dump on this server is not sealed, so there is no key travelling with it — nor any need. */
      carriesSecret: false,
      sameInstance: takenFingerprint && running ? takenFingerprint === running : null,
    },
    database: {
      schemaVersion: onSchema,
      sameSchema: archiveSchema && onSchema ? archiveSchema === onSchema : null,
    },
    source: row.filename,
  });
}

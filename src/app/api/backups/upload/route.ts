import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { secretFingerprint } from "@/lib/backup/fingerprint";
import { ArchiveFormatError, readArchiveHeader } from "@/lib/backup/archive";
import { ensureRestoreDir, restoreInProgress, stagingPath } from "@/lib/backup/maintenance";

/**
 * Takes an uploaded archive and says what it is, without opening it.
 *
 * This is the step before the decision, and it deliberately asks for no passphrase. Everything on
 * the confirmation screen — when this backup was taken, which schema it holds, whether it came from
 * this installation — lives in the archive's plaintext header, so somebody can find out whether
 * they have the right file before they go looking for the passphrase to the wrong one.
 *
 * ## The body is the file
 *
 * Not multipart. A multipart parser has to understand the whole envelope before it can hand over
 * the part inside, which for a database-sized upload means either buffering it or pulling in a
 * streaming parser to save one header. Sending the file as the raw request body and its name in a
 * header does the same job: the browser streams a `File` body, and this streams it straight to
 * disk without ever holding more than a chunk.
 *
 * ## Where it lands
 *
 * `backups/.restore/staged-<id>.wbak`, not `backups/`. The pruner sweeps `backups/` by filename
 * pattern and deletes what is old; a half-finished restore staged in there could be swept away
 * underneath the confirmation screen, and — worse — an uploaded file would start to look like one
 * of this server's own backups in the log.
 */

/** A ceiling, so a wrong URL cannot fill the disk. Raise it with BACKUP_MAX_UPLOAD_BYTES. */
const DEFAULT_MAX_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024;

function maxUploadBytes(): number {
  const configured = Number(process.env.BACKUP_MAX_UPLOAD_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_UPLOAD_BYTES;
}

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

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  if (!(await can(user.id, "backups.restore"))) {
    return NextResponse.json({ error: "You don't have access to restore backups." }, { status: 403 });
  }

  if (restoreInProgress()) {
    return NextResponse.json({ error: "A restore is already running. Wait for it to finish." }, { status: 409 });
  }

  if (!request.body) return NextResponse.json({ error: "No file was sent." }, { status: 400 });

  const declared = Number(request.headers.get("content-length") ?? "0");
  const ceiling = maxUploadBytes();
  if (declared > ceiling) {
    return NextResponse.json({ error: `That file is larger than this server accepts (${ceiling} bytes).` }, { status: 413 });
  }

  await ensureRestoreDir();
  const id = randomUUID();
  const target = stagingPath(id, ".wbak");

  let received = 0;
  try {
    await pipeline(
      Readable.fromWeb(request.body as import("node:stream/web").ReadableStream),
      async function* (source) {
        for await (const chunk of source) {
          received += (chunk as Buffer).length;
          // Checked as it arrives, not only against the declared length: `Content-Length` is a
          // claim by the client, and a client that lies about it should still not fill the disk.
          if (received > ceiling) throw new Error("TOO_LARGE");
          yield chunk;
        }
      },
      createWriteStream(target),
    );
  } catch (err) {
    await rm(target, { force: true }).catch(() => {});
    if ((err as Error).message === "TOO_LARGE") {
      return NextResponse.json({ error: `That file is larger than this server accepts (${ceiling} bytes).` }, { status: 413 });
    }
    return NextResponse.json({ error: "The upload did not finish. Nothing has been staged." }, { status: 400 });
  }

  let header;
  try {
    header = await readArchiveHeader(target);
  } catch (err) {
    // An unreadable upload is deleted rather than kept: it is either not a backup, or a backup this
    // version cannot open, and in both cases leaving a database-sized file behind helps nobody.
    await rm(target, { force: true }).catch(() => {});
    const message = err instanceof ArchiveFormatError ? err.message : "That file could not be read as a backup archive.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const running = secretFingerprint(process.env.AUTH_SECRET);
  const onSchema = await currentMigration();

  return NextResponse.json({
    ok: true,
    id,
    uploadedBytes: received,
    archive: {
      takenAt: header.takenAt,
      schemaVersion: header.schemaVersion,
      dumpBytes: header.dumpBytes,
      via: header.via,
      app: header.app,
      /** Whether the file carries the key to its own encrypted columns. */
      carriesSecret: header.secret !== null,
      /**
       * Whether this archive was written by this installation.
       *
       * Null when either side has no fingerprint to compare — an archive from before fingerprints,
       * or a server with no AUTH_SECRET set. "Cannot tell" and "does not match" are different
       * answers and the screen says so differently.
       */
      sameInstance: header.secretFingerprint && running ? header.secretFingerprint === running : null,
    },
    database: {
      schemaVersion: onSchema,
      sameSchema: header.schemaVersion && onSchema ? header.schemaVersion === onSchema : null,
    },
  });
}

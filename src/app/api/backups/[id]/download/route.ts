import path from "node:path";
import { rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { logActivity } from "@/lib/activity";
import { secretFingerprint } from "@/lib/backup/fingerprint";
import { readSidecar } from "@/lib/backup/sidecar";
import { MissingChunkError, readManifest, reassemble } from "@/lib/backup/chunks";
import { backupRoot, ensureRestoreDir, restoreDir } from "@/lib/backup/maintenance";
import { ARCHIVE_EXTENSION, PassphraseError, passphraseProblem, sealToStream } from "@/lib/backup/archive";

/**
 * Hands one backup to the person who asked for it, sealed.
 *
 * ## Why this is a POST, and why the passphrase is in the body
 *
 * A GET would put this behind a URL, and a URL is the one place a secret must never be: it is typed
 * into address bars, kept in history, written to every proxy log between here and the browser, and
 * handed to whatever a page links to next in a `Referer`. It would also make the download something
 * any page on the internet could trigger in a logged-in admin's browser simply by pointing an
 * `<img>` at it. A POST with the passphrase in the body is neither of those things.
 *
 * The response is streamed rather than buffered. These files are the whole database, and reading
 * one into memory to send it would put the application one large backup away from an OOM. `sealToStream`
 * gives an exact length up front — AES-GCM is a counter mode, so the ciphertext is the same size as
 * the dump — which is what lets the browser draw a real progress bar instead of a spinner.
 *
 * ## What is recorded
 *
 * An activity row at WARNING, the same way a CSV export is recorded and for the same reason —
 * except this is the largest one there is: one request, and a complete copy of every customer,
 * order, payslip and password hash leaves the building. "Who took a copy, and when" has to be
 * answerable afterwards, from the log rather than from memory.
 *
 * Not an audit row. `AuditAction` is CREATE, UPDATE and DELETE — it records changes to records, and
 * nothing here changes. Filing a read under a mutation verb would make the audit trail say
 * something that did not happen.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  if (!(await can(user.id, "backups.download"))) {
    return NextResponse.json({ error: "You don't have access to download backups." }, { status: 403 });
  }

  const { id } = await context.params;
  const form = await request.formData().catch(() => null);
  const passphrase = typeof form?.get("passphrase") === "string" ? String(form.get("passphrase")) : "";

  const problem = passphraseProblem(passphrase);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  const row = await db.backup.findUnique({ where: { id } });
  if (!row || row.status !== "SUCCEEDED") {
    // A backup that never finished is not a backup. Same answer as a made-up id, so a guessed one
    // learns nothing about what exists.
    return NextResponse.json({ error: "There is no completed backup with that id." }, { status: 404 });
  }

  const root = backupRoot();

  /** The plaintext dump this request seals. For a chunked backup it does not exist yet. */
  let dumpPath: string;
  /**
   * Set only when this request built the file itself, and therefore owes its deletion.
   *
   * A reassembled dump is a complete, unencrypted copy of the entire business — every order, every
   * payslip, every password hash — and the only reason it is on disk is that the bytes have to come
   * from somewhere to be sealed. Leaving one behind would hand anybody with filesystem access
   * exactly what the passphrase on this download exists to keep from them, and it would do it once
   * per download, at the size of the database.
   */
  let rebuilt: string | null = null;

  if (row.kind === "INCREMENTAL") {
    const manifest = await readManifest(root, row.id);
    if (!manifest) {
      // The manifest is the chunked backup's equivalent of the file: without it the chunks are an
      // unordered heap and the snapshot is unrecoverable. Same answer as a deleted dump.
      return NextResponse.json(
        {
          error:
            "The pieces list for that backup is no longer on the server. The log row is still here, but there is nothing left to rebuild it from.",
        },
        { status: 410 },
      );
    }

    await ensureRestoreDir();
    /**
     * Rebuilt inside `.restore/`, dotted, under an id of its own.
     *
     * Not the backup folder: the pruner sweeps that on a schedule and the backup list reads it, so a
     * file there is either deleted underneath a live download or shown to somebody as a backup it is
     * not. The id is fresh rather than `row.id` because two people may download the same backup at
     * once — on a shared path the first to finish deletes the file the second is still streaming,
     * and that download ends truncated with no error anywhere.
     */
    rebuilt = path.join(restoreDir(), `.rebuilt-${randomUUID()}.dump`);
    try {
      await reassemble(root, manifest, rebuilt);
    } catch (err) {
      await rm(rebuilt, { force: true }).catch(() => {});
      // Its own answer rather than a 500: a pruned or half-copied store is a thing an operator can
      // act on, and the error already says which piece and why.
      if (err instanceof MissingChunkError) return NextResponse.json({ error: err.message }, { status: 410 });
      throw err;
    }
    dumpPath = rebuilt;
  } else {
    dumpPath = path.join(row.directory || root, row.filename);
    const info = await stat(dumpPath).catch(() => null);
    if (!info?.isFile()) {
      return NextResponse.json(
        { error: "The file for that backup is no longer on the server. The log row is still here, but the dump is gone." },
        { status: 410 },
      );
    }
  }

  /** Idempotent, because the stream's `close` and `error` usually both arrive. */
  let discarded = false;
  const discardRebuilt = async () => {
    if (!rebuilt || discarded) return;
    discarded = true;
    await rm(rebuilt, { force: true }).catch(() => {});
  };

  // A chunked backup never had a sidecar — there was no file for one to sit beside — and the facts
  // it would have carried were recorded on the row when the dump was taken.
  const sidecar = row.kind === "INCREMENTAL" ? null : await readSidecar(dumpPath);

  let sealed;
  try {
    sealed = await sealToStream({
      dumpPath,
      passphrase,
      meta: {
        takenAt: row.startedAt,
        schemaVersion: row.schemaVersion ?? sidecar?.schemaVersion ?? null,
        secretFingerprint: sidecar?.secretFingerprint ?? row.secretFingerprint ?? secretFingerprint(process.env.AUTH_SECRET),
        via: row.via ?? sidecar?.via ?? null,
        /**
         * The running secret travels inside the file, sealed under the passphrase.
         *
         * Without it this archive restores onto a fresh server as a database of unreadable
         * ciphertext — the vault, the two-factor secrets, the M365 and e-invoice logins all present
         * and all gibberish. With it, the passphrase is the only thing between this file and every
         * one of those, which is the trade the operator made when they chose a sealed archive.
         */
        includeSecret: process.env.AUTH_SECRET ?? null,
      },
    });
  } catch (err) {
    await discardRebuilt();
    if (err instanceof PassphraseError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }

  // Both extensions, because the archive is the same thing either way: a complete snapshot, sealed.
  // How it happened to be stored on this server is not a fact the downloaded file should carry.
  const outName = `${row.filename.replace(/\.(dump|chunked)$/i, "")}${ARCHIVE_EXTENSION}`;

  try {
    // Before the stream, not after: the response is handed to the runtime and finishes whenever the
    // client finishes reading it, so anything written afterwards races the download and is lost if
    // the connection drops. A recorded download that did not complete is the right way round.
    await logActivity({
      kind: "EXPORT",
      severity: "WARNING",
      summary: `${user.name} downloaded a complete backup — ${outName}`,
      metadata: {
        backupId: row.id,
        filename: outName,
        kind: row.kind,
        bytes: sealed.totalBytes,
        takenAt: row.startedAt.toISOString(),
      },
    });
  } catch (err) {
    // Nothing below this point runs, so nothing else will ever reach the cleanup hook.
    await discardRebuilt();
    throw err;
  }

  /**
   * The rebuilt copy has to outlive this function and die with the stream.
   *
   * Deleting it here is the obvious mistake and the worst one: the body is read after the handler
   * returns, so the download would truncate to whatever had already been pulled — silently, with a
   * `Content-Length` promising the rest. Never deleting it is the other failure, a database-sized
   * plaintext dump left behind per download.
   *
   * So cleanup hangs off the stream rather than off this function. `close` is the event a Readable
   * always reaches — after a normal end, and after a destroy when the client hangs up mid-download —
   * which makes it the only hook that covers both endings. `error` is attached beside it so a stream
   * that fails before the runtime starts reading still gets swept, and because an `error` with no
   * listener on a bare Readable is an uncaught exception rather than a failed download.
   */
  sealed.stream.once("close", () => void discardRebuilt());
  sealed.stream.once("error", () => void discardRebuilt());

  return new NextResponse(Readable.toWeb(sealed.stream) as ReadableStream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(sealed.totalBytes),
      "Content-Disposition": `attachment; filename="${outName}"`,
      // Never in a shared cache, and never in the browser's either: this is the whole database.
      "Cache-Control": "private, no-store",
    },
  });
}

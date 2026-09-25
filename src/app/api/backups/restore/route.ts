import { spawn } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { logActivity } from "@/lib/activity";
import { secretFingerprint } from "@/lib/backup/fingerprint";
import { ArchiveFormatError, PassphraseError, extractArchive } from "@/lib/backup/archive";
import { CONFIRM_PHRASE } from "@/lib/backup/archive-format";
import {
  clearStaged,
  ensureRestoreDir,
  readStagedMeta,
  releaseLock,
  restoreDir,
  restoreInProgress,
  stagingPath,
  takeLock,
  writeRestoreStatus,
} from "@/lib/backup/maintenance";

/**
 * Starts the restore, and gets out of the way.
 *
 * The order here is the whole design. Everything that can refuse — the permission, the typed
 * confirmation, the passphrase, the archive's own integrity — refuses *before* the lock is taken,
 * so the overwhelmingly common failure (a mistyped passphrase) costs a staged file and nothing else.
 * Only once a readable dump is sitting on disk does this take the lock, write the first status and
 * hand off to a detached worker.
 *
 * The request does not wait for the restore. It cannot: the first thing the worker does is drop the
 * schema this request's own connection is reading from, so waiting would mean waiting for a socket
 * that is about to die. The screen polls the status file instead.
 *
 * ## The passphrase stops here
 *
 * The archive is opened in this process, and the worker is handed a plain dump. A passphrase on a
 * child's command line is visible in `ps` to every user on the box; one in its environment is
 * readable from `/proc/<pid>/environ`. Neither is worth the convenience.
 */


/**
 * Resolved from the working directory rather than imported.
 *
 * `tsx` is a devDependency and the worker is a TypeScript file outside the Next build — neither can
 * be `import`ed from a route without dragging the whole script into the bundle. Both are plain
 * paths the spawned process resolves for itself.
 *
 * Worth knowing when deploying: this needs `tsx` present, so a production install that drops
 * devDependencies leaves the Restore button unable to start its worker. The same is true of every
 * other operational script in this repo, which all run through `tsx`.
 */
const TSX_CLI = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const WORKER_SCRIPT = path.join(process.cwd(), "scripts", "restore-worker.ts");

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  if (!(await can(user.id, "backups.restore"))) {
    return NextResponse.json({ error: "You don't have access to restore backups." }, { status: 403 });
  }

  if (restoreInProgress()) {
    return NextResponse.json({ error: "A restore is already running." }, { status: 409 });
  }

  const body = (await request.json().catch(() => null)) as
    | { id?: string; passphrase?: string; confirm?: string }
    | null;

  const id = typeof body?.id === "string" ? body.id : "";
  const passphrase = typeof body?.passphrase === "string" ? body.passphrase : "";
  const confirm = typeof body?.confirm === "string" ? body.confirm.trim() : "";

  if (!/^[a-z0-9-]{6,64}$/i.test(id)) {
    return NextResponse.json({ error: "That upload is no longer staged. Upload the file again." }, { status: 400 });
  }
  if (confirm !== CONFIRM_PHRASE) {
    return NextResponse.json({ error: `Type ${CONFIRM_PHRASE} to confirm.` }, { status: 400 });
  }

  const archivePath = stagingPath(id, ".wbak");
  const dumpPath = stagingPath(id, ".dump");

  /**
   * Two kinds of staging arrive here, and which one this is decides whether a passphrase is needed.
   *
   * An upload is a sealed `.wbak` that has to be opened. A backup staged from this server's own
   * folder is already a plain `.dump` with a small meta file beside it — it never left the machine,
   * so there is nothing for a passphrase to have protected it from, and demanding one would be a
   * ritual rather than a control.
   *
   * The meta file's presence is the discriminator rather than the request's say-so. A client that
   * claimed "no passphrase needed" for an uploaded archive would otherwise skip the one check that
   * proves the person starting a restore can also read what they are restoring.
   */
  const staged = await readStagedMeta(id);

  let takenAt: string;
  let schemaVersion: string | null;
  let sealedSecret: string | null = null;
  let archiveFingerprint: string | null = null;

  if (staged) {
    const info = await stat(dumpPath).catch(() => null);
    if (!info?.isFile()) {
      return NextResponse.json({ error: "That staged backup is gone. Start again." }, { status: 400 });
    }
    takenAt = staged.takenAt ?? new Date(0).toISOString();
    schemaVersion = staged.schemaVersion;
    archiveFingerprint = staged.secretFingerprint;
  } else {
    let opened;
    try {
      opened = await extractArchive({ archivePath, outDumpPath: dumpPath, passphrase });
    } catch (err) {
      if (err instanceof PassphraseError) {
        // The archive stays staged. A wrong passphrase is the one failure worth letting somebody
        // retry without uploading a database again.
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      await clearStaged(id);
      const message =
        err instanceof ArchiveFormatError ? err.message : "That archive could not be opened. Nothing has been changed.";
      return NextResponse.json({ error: message }, { status: 400 });
    }
    takenAt = opened.header.takenAt;
    schemaVersion = opened.header.schemaVersion;
    sealedSecret = opened.secret;
    archiveFingerprint = opened.header.secretFingerprint;
  }

  /**
   * If the archive's key is not this instance's key, the key is written out rather than shown.
   *
   * The data restores encrypted under whatever secret wrote it, and this process is running under a
   * different one — so the vault, the two-factor secrets and the stored portal credentials all come
   * back unreadable until `AUTH_SECRET` is changed to match and the app restarted. The application
   * cannot rewrite its own environment, so somebody has to.
   *
   * It goes to a file on the server, mode 0600, and the status carries only the path. Rendering it
   * into a page would put the key to every encrypted column into a browser, a screenshot and
   * whatever logs sit between here and there — which would undo the reason the archive was sealed.
   */
  let secretHandoffPath: string | null = null;
  const running = secretFingerprint(process.env.AUTH_SECRET);
  if (sealedSecret && secretFingerprint(sealedSecret) !== running) {
    await ensureRestoreDir();
    secretHandoffPath = path.join(restoreDir(), `restore-${id}-AUTH_SECRET.txt`);
    await writeFile(
      secretHandoffPath,
      `${sealedSecret}\n\n# The AUTH_SECRET this backup was taken under.\n` +
        `# Set it in the environment and restart, or every encrypted column stays unreadable.\n` +
        `# Delete this file once you have moved the value somewhere it belongs.\n`,
      { mode: 0o600 },
    );
  }

  const startedAt = new Date();
  await logActivity({
    kind: "EXPORT",
    severity: "CRITICAL",
    summary: `${user.name} started a full restore from ${
      staged ? `this server's backup ${staged.source}` : "an uploaded backup"
    }, taken ${takenAt}`,
    metadata: {
      restoreId: id,
      from: staged ? "server" : "upload",
      source: staged?.source ?? null,
      takenAt,
      schemaVersion,
      sameInstance: archiveFingerprint === running,
    },
  });

  await takeLock(id, startedAt);
  await writeRestoreStatus({
    id,
    phase: "staged",
    message: "Starting…",
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    archiveName: staged?.source ?? `uploaded backup taken ${takenAt}`,
    takenAt,
    secretHandoffPath,
    error: null,
  });

  try {
    /**
     * Detached, unreferenced, and without a shell.
     *
     * Without `detached` the worker dies with the web process, and the web process is about to lose
     * its database — exactly the moment a supervisor may decide to restart it. Without `unref` this
     * request's process would wait for the child before exiting. `stdio: "ignore"` because there is
     * nowhere for its output to go and a full pipe buffer would block it; everything worth knowing
     * goes to the status file.
     *
     * Node itself runs tsx's entry point, rather than `npx tsx`. `npx` is a shell script on Windows,
     * which forces `shell: true`, which concatenates arguments into a command line instead of
     * passing them as a vector — Node deprecated that combination for exactly the reason it sounds
     * like. `id` is already pattern-checked above, so nothing hostile could reach it, but a spawn
     * that cannot be injected into beats one that merely is not.
     */
    const child = spawn(process.execPath, [TSX_CLI, WORKER_SCRIPT, id], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
  } catch (err) {
    await releaseLock();
    await clearStaged(id);
    return NextResponse.json(
      { error: `The restore could not be started: ${(err as Error).message}. Nothing has been changed.` },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, id });
}

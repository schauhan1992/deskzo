import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, open, rename, rm, stat } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { platformKeyConfigured, platformKeyFor } from "@/lib/platform/kek";

/**
 * Backups encrypted on the server's disk (owner, 22 Oct 2026). A full backup's file and every piece of a
 * chunked one are AES-256-GCM under a key for that workspace alone, so a copy of the backup folder — a disk
 * snapshot, an off-site sync, somebody browsing the server — is unreadable without the platform's key.
 *
 * ## The key
 *
 * Derived from PLATFORM_MASTER_KEY and the workspace's id (src/lib/platform/kek.ts `platformKeyFor`), never
 * stored. Not from the workspace's own key bundle: a restore of another server's archive installs that
 * server's keys, and backups taken here under the old ones would be stranded. A server without a platform
 * key (the first workspace before adoption, check suites) derives one from AUTH_SECRET instead; the file says
 * which, so a backup taken before adoption still opens after it.
 *
 * ## The format
 *
 *   "DZBKENC1" (8) · key kind (1: 1 platform, 2 AUTH_SECRET) · IV (12) · ciphertext · GCM tag (16)
 *
 * with "<workspace id>|<what>" as associated data — a file moved into another workspace's folder doesn't
 * open there. A file without the magic is a backup from before this, read as it always was; nothing that
 * reads backups needs to know which it has. Downloads are sealed separately, under a passphrase of the
 * person's own (src/lib/backup/archive.ts) — this is only about what sits on the server.
 */

const MAGIC = Buffer.from("DZBKENC1", "latin1");
const HEADER = MAGIC.length + 1 + 12;
const TAG = 16;
type KeyKind = 1 | 2;
/** "log": an archived log (src/lib/logs/archive.ts); "file": a support attachment copied off-site (src/lib/offsite/support.ts). */
export type SealedWhat = "dump" | "chunk" | "log" | "file";

function keyFor(tenantId: string, kind: KeyKind): Buffer {
  if (kind === 1) return platformKeyFor(tenantId, "backup-at-rest");
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("This backup was encrypted under AUTH_SECRET, which isn't set here.");
  return Buffer.from(hkdfSync("sha256", secret, "deskzo/backup-at-rest/env", tenantId, 32));
}

/** The kind of key a new backup is encrypted under here. */
const currentKind = (): KeyKind => (platformKeyConfigured() ? 1 : 2);
const aad = (tenantId: string, what: SealedWhat) => Buffer.from(`${tenantId}|${what}`, "utf8");

export class SealedBackupError extends Error {
  constructor(message = "This backup is encrypted, and the key this server has doesn't open it — it was taken by another server, or for another workspace.") {
    super(message);
    this.name = "SealedBackupError";
  }
}

/** Whether these bytes (the first few of a file or a piece) are an encrypted backup. */
export function isSealed(head: Buffer): boolean {
  return head.length >= MAGIC.length && head.subarray(0, MAGIC.length).equals(MAGIC);
}

/** Whether the file on disk is an encrypted backup. */
export async function isSealedFile(file: string): Promise<boolean> {
  const handle = await open(file, "r");
  try {
    const head = Buffer.alloc(MAGIC.length);
    const { bytesRead } = await handle.read(head, 0, MAGIC.length, 0);
    return isSealed(head.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

/** A stream that encrypts what passes through it — pg_dump's output on its way to the backup file. */
export function sealingStream(tenantId: string, what: SealedWhat = "dump"): Transform {
  const kind = currentKind();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(tenantId, kind), iv);
  cipher.setAAD(aad(tenantId, what));
  let started = false;
  const start = (stream: Transform) => {
    if (started) return;
    started = true;
    stream.push(Buffer.concat([MAGIC, Buffer.from([kind]), iv]));
  };
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      start(this);
      done(null, cipher.update(chunk));
    },
    flush(done) {
      start(this);
      this.push(cipher.final());
      this.push(cipher.getAuthTag());
      done();
    },
  });
}

/** One piece, encrypted whole — a chunk of a chunked backup. */
export function sealBuffer(tenantId: string, data: Buffer, what: SealedWhat = "chunk"): Buffer {
  const kind = currentKind();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(tenantId, kind), iv);
  cipher.setAAD(aad(tenantId, what));
  return Buffer.concat([MAGIC, Buffer.from([kind]), iv, cipher.update(data), cipher.final(), cipher.getAuthTag()]);
}

/** One piece, opened — or returned as it is when it was never encrypted. */
export function openBuffer(tenantId: string, data: Buffer, what: SealedWhat = "chunk"): Buffer {
  if (!isSealed(data)) return data;
  if (data.length < HEADER + TAG) throw new SealedBackupError("An encrypted piece of this backup is cut short.");
  const kind = data[MAGIC.length] as KeyKind;
  const decipher = createDecipheriv("aes-256-gcm", keyFor(tenantId, kind), data.subarray(MAGIC.length + 1, HEADER));
  decipher.setAAD(aad(tenantId, what));
  decipher.setAuthTag(data.subarray(data.length - TAG));
  try {
    return Buffer.concat([decipher.update(data.subarray(HEADER, data.length - TAG)), decipher.final()]);
  } catch {
    throw new SealedBackupError();
  }
}

/**
 * The backup file at `source`, readable, at `target`: decrypted when it is encrypted, copied when it is
 * not. What every reader of a backup goes through — staging a restore, rebuilding a download. A wrong key
 * or a damaged file throws and leaves no `target` behind.
 */
export async function openBackupFileTo(tenantId: string, source: string, target: string, what: SealedWhat = "dump"): Promise<void> {
  if (!(await isSealedFile(source))) {
    await copyFile(source, target);
    return;
  }
  const { size } = await stat(source);
  if (size < HEADER + TAG) throw new SealedBackupError("This encrypted backup is cut short.");
  const handle = await open(source, "r");
  const head = Buffer.alloc(HEADER);
  const tag = Buffer.alloc(TAG);
  try {
    await handle.read(head, 0, HEADER, 0);
    await handle.read(tag, 0, TAG, size - TAG);
  } finally {
    await handle.close();
  }
  const kind = head[MAGIC.length] as KeyKind;
  const decipher = createDecipheriv("aes-256-gcm", keyFor(tenantId, kind), head.subarray(MAGIC.length + 1, HEADER));
  decipher.setAAD(aad(tenantId, what));
  decipher.setAuthTag(tag);
  try {
    // Empty when there is no ciphertext: a stream's `end` must not be before its `start`.
    if (size - TAG > HEADER) await pipeline(createReadStream(source, { start: HEADER, end: size - TAG - 1 }), decipher, createWriteStream(target));
    else await pipeline(async function* () {}, decipher, createWriteStream(target));
  } catch (err) {
    await rm(target, { force: true }).catch(() => {});
    if (err instanceof Error && /unable to authenticate|auth/i.test(err.message)) throw new SealedBackupError();
    throw err;
  }
}

/**
 * Encrypts a backup file that was written before this, in place — for `npm run db:backup -- --seal-existing`.
 * Written beside it and renamed over it, so a failure half way leaves the original. False when it was
 * already encrypted.
 */
export async function sealFileInPlace(tenantId: string, file: string, what: SealedWhat = "dump"): Promise<boolean> {
  if (await isSealedFile(file)) return false;
  const temp = `${file}.${process.pid}.sealing`;
  try {
    await pipeline(createReadStream(file), sealingStream(tenantId, what), createWriteStream(temp));
    await rename(temp, file);
    return true;
  } catch (err) {
    await rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}

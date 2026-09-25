import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { open, stat, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { passphraseProblem } from "@/lib/backup/archive-format";
import { platformHmac } from "@/lib/platform/kek";

/**
 * One file that is the whole system, and is safe to carry.
 *
 * A dump on its own is two problems. The first is that it travels as a *pair* — the `.dump` and the
 * `.dump.json` beside it — and the sidecar is the thing that says which encryption secret the data
 * was written under. An offsite rule matching `*.dump` silently drops it, and the restore that
 * follows months later reports success while every encrypted column comes back as noise. The second
 * is that the dump is readable: every order, every password hash, every ciphertext, in a file whose
 * whole purpose is to be copied somewhere else.
 *
 * So this is a single sealed container. The metadata cannot be separated from the data because they
 * are the same file, and the data cannot be read without the passphrase.
 *
 * ## Layout
 *
 *     magic      8 bytes    "WROFFYBK"
 *     version    1 byte     1
 *     headerLen  4 bytes    big-endian
 *     header     headerLen  UTF-8 JSON, PLAINTEXT
 *     body       ...        AES-256-GCM ciphertext of the pg_dump archive
 *     tag        16 bytes   the body's GCM authentication tag
 *     signature  32 bytes   version 2 only: the platform's HMAC over everything before it
 *
 * ## The platform's signature (version 2)
 *
 * A restore runs whatever SQL the dump holds, as the workspace's database. The passphrase proves
 * whoever uploads a file can read it, not that it is a backup this platform made: anybody can seal a
 * dump of their own under a passphrase of their own. So an archive downloaded from a workspace ends
 * with an HMAC over the whole file under a key derived from the platform key for that workspace
 * (src/lib/platform/kek.ts), and a workspace restores by itself only a file signed for it. Anything
 * else — another workspace's backup, a hand-made dump — goes through staff. The header names the
 * workspace it was signed for, in the clear, so the refusal can say so before anybody types a
 * passphrase.
 *
 * The header is deliberately in the clear. Somebody standing in front of a folder of these needs to
 * know which one to reach for — when it was taken, which schema it is from, which instance wrote it
 * — and making them type a passphrase to find out would mean typing it into every file in turn.
 * Nothing in the header is secret: the fingerprint identifies a key without being one, and the
 * sizes are visible from the file listing anyway.
 *
 * ## Why the tag is at the end
 *
 * GCM cannot produce its tag until it has seen the last byte, and these files are too big to hold
 * in memory. So the body streams through the cipher and the tag is appended after it. Reading goes
 * the other way: seek to the last 16 bytes first, hand them to the decipher, then stream.
 *
 * A wrong passphrase, a truncated download and a tampered file all fail the same way — at `final()`,
 * after the whole body has passed through. That is late, and late is exactly wrong for a restore,
 * where the next step drops the schema. Hence `verifier`: a few bytes sealed under the same key, so
 * the passphrase can be proved in microseconds before anything expensive or destructive starts.
 */

export const ARCHIVE_MAGIC = Buffer.from("WROFFYBK", "latin1");
/** Written: 2, signed by the platform. Read: 1 (from before signatures) and 2. */
export const ARCHIVE_VERSION = 2;
const READABLE_VERSIONS = new Set([1, 2]);

/**
 * Re-exported so server code has one import to reach for.
 *
 * A client component must import these from `archive-format` directly — reaching them through here
 * pulls `node:fs` into the browser bundle and the page stops building. See that file's header.
 */
export { ARCHIVE_EXTENSION, MIN_PASSPHRASE_LENGTH, CONFIRM_PHRASE, passphraseProblem } from "@/lib/backup/archive-format";
const TAG_BYTES = 16;
const SIGNATURE_BYTES = 32;
const PREAMBLE_BYTES = ARCHIVE_MAGIC.length + 1 + 4;
const trailerBytes = (header: Pick<ArchiveHeader, "signature">) => (header.signature ? SIGNATURE_BYTES : 0);

/** What `verifier` holds. Any fixed string works; this one says what it is in a hex dump. */
const VERIFIER_PLAINTEXT = "wroffy-backup-verifier-v1";

/**
 * Cost parameters, fixed here and recorded in every header.
 *
 * Recorded rather than assumed, because raising them later must not make yesterday's archives
 * unreadable — a reader derives with the parameters the file names, not the ones the code prefers.
 *
 * N = 2^15 puts scrypt's working set at 128 * N * r = 33.5 MB, which is over Node's default
 * `maxmem` of 32 MB, so every call passes an explicit ceiling. Getting that wrong throws
 * "Invalid scrypt params" at the moment somebody is trying to restore, which is the worst time to
 * discover a constant.
 */
const KDF = { name: "scrypt" as const, N: 1 << 15, r: 8, p: 1, keyLen: 32 };
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

type Sealed = { iv: string; tag: string; data: string };

export type ArchiveHeader = {
  app: string;
  format: number;
  /** ISO 8601, when the dump this wraps was started. */
  takenAt: string;
  /** The migration the source database was on, for the same check the sidecar used to carry. */
  schemaVersion: string | null;
  /** Identifies the keys the data was encrypted under without being them (src/lib/tenancy/keys.ts). */
  secretFingerprint: string | null;
  /** Length of the pg_dump archive inside, before encryption. */
  dumpBytes: number;
  /** How the dump was taken, e.g. "pg_dump (host)". Useful when a restore goes wrong. */
  via: string | null;
  kdf: { name: "scrypt"; N: number; r: number; p: number; keyLen: number; salt: string };
  cipher: { name: "aes-256-gcm"; iv: string };
  /** Proves the passphrase without touching the body. Always present. */
  verifier: Sealed;
  /**
   * The keys this database was encrypted under, sealed under the passphrase: the workspace's key
   * bundle (src/lib/tenancy/keys.ts — `archiveKeyMaterial`), or in a version 1 archive the
   * installation's AUTH_SECRET.
   *
   * Present when the operator chose to include it, which is what makes an archive restorable onto a
   * server that has never seen this workspace. It also makes the passphrase the only thing between
   * this file and the vault, which is why there is no way to write one of these unsealed.
   */
  secret: Sealed | null;
  /** Version 2: which workspace the platform signed this for. The signature is the file's last 32 bytes. */
  signature?: { alg: "hmac-sha256"; tenantId: string } | null;
};

/** Everything `writeArchive` needs that it cannot work out for itself. */
export type ArchiveMeta = {
  takenAt: Date;
  schemaVersion: string | null;
  secretFingerprint: string | null;
  via: string | null;
  /** The key material to seal into the file (`archiveKeyMaterial`), or null to leave it out. */
  includeSecret: string | null;
  /** The workspace to sign the file for. */
  signFor: string;
};

export class PassphraseError extends Error {
  constructor(message = "That passphrase does not open this archive.") {
    super(message);
    this.name = "PassphraseError";
  }
}

export class ArchiveFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveFormatError";
  }
}

function deriveKey(passphrase: string, kdf: ArchiveHeader["kdf"]): Buffer {
  return scryptSync(passphrase.normalize("NFKC"), Buffer.from(kdf.salt, "base64"), kdf.keyLen, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: SCRYPT_MAXMEM,
  });
}

function seal(key: Buffer, plaintext: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

function unseal(key: Buffer, sealed: Sealed): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new PassphraseError();
  }
}

/**
 * Seals a dump into a stream, without ever putting the sealed copy on disk.
 *
 * This is what a download uses. The alternative — write the archive to a temporary file, stream the
 * file, delete it — needs twice the disk for the duration and leaves a complete copy of the business
 * lying in a temp directory if the process dies halfway. Neither is acceptable on a container with a
 * small ephemeral disk, and the second is not acceptable anywhere.
 *
 * `totalBytes` is exact rather than estimated, because GCM is a counter mode: the ciphertext is the
 * same length as the plaintext, so the whole file is preamble + header + dump + tag and nothing has
 * to be buffered to find out. That is what lets the response carry a `Content-Length`, which is the
 * difference between a browser showing a progress bar and showing a spinner for four minutes.
 */
export async function sealToStream(input: {
  dumpPath: string;
  passphrase: string;
  meta: ArchiveMeta;
}): Promise<{ header: ArchiveHeader; stream: Readable; totalBytes: number }> {
  const problem = passphraseProblem(input.passphrase);
  if (problem) throw new PassphraseError(problem);

  const info = await stat(input.dumpPath);
  const kdf = { ...KDF, salt: randomBytes(16).toString("base64") };
  const key = deriveKey(input.passphrase, kdf);
  const iv = randomBytes(12);

  const header: ArchiveHeader = {
    app: "Wroffy ERP",
    format: ARCHIVE_VERSION,
    takenAt: input.meta.takenAt.toISOString(),
    schemaVersion: input.meta.schemaVersion,
    secretFingerprint: input.meta.secretFingerprint,
    dumpBytes: info.size,
    via: input.meta.via,
    kdf,
    cipher: { name: "aes-256-gcm", iv: iv.toString("base64") },
    verifier: seal(key, VERIFIER_PLAINTEXT),
    secret: input.meta.includeSecret ? seal(key, input.meta.includeSecret) : null,
    signature: { alg: "hmac-sha256", tenantId: input.meta.signFor },
  };

  const headerJson = Buffer.from(JSON.stringify(header), "utf8");
  const preamble = Buffer.alloc(PREAMBLE_BYTES);
  ARCHIVE_MAGIC.copy(preamble, 0);
  preamble.writeUInt8(ARCHIVE_VERSION, ARCHIVE_MAGIC.length);
  preamble.writeUInt32BE(headerJson.length, ARCHIVE_MAGIC.length + 1);

  const source = createReadStream(input.dumpPath);
  const signer = platformHmac(input.meta.signFor, "backup-archive");
  const stream = Readable.from(
    (async function* () {
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const out = (bytes: Buffer) => {
        signer.update(bytes);
        return bytes;
      };
      yield out(preamble);
      yield out(headerJson);
      for await (const chunk of source) yield out(cipher.update(chunk as Buffer));
      const last = cipher.final();
      if (last.length > 0) yield out(last);
      yield out(cipher.getAuthTag());
      yield signer.digest();
    })(),
  );

  return { header, stream, totalBytes: preamble.length + headerJson.length + info.size + TAG_BYTES + SIGNATURE_BYTES };
}

/**
 * Wraps a finished pg_dump into a sealed archive on disk.
 *
 * The dump is read, never moved: the caller still owns the file it passed, and a failure here leaves
 * it exactly where it was.
 */
export async function writeArchive(input: {
  dumpPath: string;
  outPath: string;
  passphrase: string;
  meta: ArchiveMeta;
}): Promise<{ header: ArchiveHeader; bytesWritten: number }> {
  const { header, stream } = await sealToStream(input);

  try {
    await pipeline(stream, createWriteStream(input.outPath));
  } catch (err) {
    // A half-written archive is worse than none: it looks like a backup in a file listing.
    await rm(input.outPath, { force: true }).catch(() => {});
    throw err;
  }

  const written = await stat(input.outPath);
  return { header, bytesWritten: written.size };
}

/**
 * Reads the header without needing the passphrase.
 *
 * This is what the upload screen calls first, so it can say "taken on the 14th, from this
 * installation, 41 MB" before asking anybody to type anything.
 */
export async function readArchiveHeader(archivePath: string): Promise<ArchiveHeader> {
  const info = await stat(archivePath).catch(() => null);
  if (!info?.isFile()) throw new ArchiveFormatError("There is no file there.");
  if (info.size < PREAMBLE_BYTES + TAG_BYTES) throw new ArchiveFormatError("That file is too small to be a backup.");

  const handle = await open(archivePath, "r");
  try {
    const preamble = Buffer.alloc(PREAMBLE_BYTES);
    await handle.read(preamble, 0, PREAMBLE_BYTES, 0);

    if (!preamble.subarray(0, ARCHIVE_MAGIC.length).equals(ARCHIVE_MAGIC)) {
      // Named separately because it is the common mistake: the raw dump, not the sealed archive.
      const looksLikeRawDump = preamble.subarray(0, 5).toString("latin1") === "PGDMP";
      throw new ArchiveFormatError(
        looksLikeRawDump
          ? "That is a raw pg_dump file, not a Wroffy backup archive. Restore it with npm run db:restore."
          : "That is not a Wroffy backup archive.",
      );
    }

    const version = preamble.readUInt8(ARCHIVE_MAGIC.length);
    if (!READABLE_VERSIONS.has(version)) {
      throw new ArchiveFormatError(`That archive is format ${version}; this app reads formats ${[...READABLE_VERSIONS].join(" and ")}.`);
    }

    const headerLen = preamble.readUInt32BE(ARCHIVE_MAGIC.length + 1);
    if (headerLen <= 0 || headerLen > 1_000_000 || PREAMBLE_BYTES + headerLen + TAG_BYTES > info.size) {
      throw new ArchiveFormatError("That archive's header is damaged.");
    }

    const headerBuf = Buffer.alloc(headerLen);
    await handle.read(headerBuf, 0, headerLen, PREAMBLE_BYTES);

    let header: ArchiveHeader;
    try {
      header = JSON.parse(headerBuf.toString("utf8")) as ArchiveHeader;
    } catch {
      throw new ArchiveFormatError("That archive's header is not readable.");
    }
    if (!header?.kdf?.salt || !header?.cipher?.iv || !header?.verifier) {
      throw new ArchiveFormatError("That archive's header is missing the fields needed to open it.");
    }
    // The header's claim to a signature must match the format, or the body's end is misplaced.
    if ((version === 2) !== !!header.signature) throw new ArchiveFormatError("That archive's header is damaged.");
    if (PREAMBLE_BYTES + headerLen + TAG_BYTES + trailerBytes(header) > info.size) throw new ArchiveFormatError("That archive is truncated.");
    return header;
  } finally {
    await handle.close();
  }
}

/**
 * Proves a passphrase against an archive, in microseconds, touching nothing.
 *
 * Separate from `extractArchive` on purpose. The alternative is finding out the passphrase was
 * wrong after streaming forty megabytes — or worse, designing a flow where that discovery happens
 * anywhere near the database.
 */
export function checkPassphrase(header: ArchiveHeader, passphrase: string): boolean {
  try {
    const key = deriveKey(passphrase, header.kdf);
    const opened = Buffer.from(unseal(key, header.verifier), "utf8");
    const expected = Buffer.from(VERIFIER_PLAINTEXT, "utf8");
    return opened.length === expected.length && timingSafeEqual(opened, expected);
  } catch {
    return false;
  }
}

/**
 * Unseals the archive into a plain pg_dump file, and hands back what was sealed beside it.
 *
 * Nothing destructive happens here and nothing should happen after it until it has returned: a
 * corrupt or truncated archive fails at the authentication tag, and the only casualty is the
 * staging file this deletes on its way out.
 */
export async function extractArchive(input: {
  archivePath: string;
  outDumpPath: string;
  passphrase: string;
}): Promise<{ header: ArchiveHeader; secret: string | null; sha256: string }> {
  const header = await readArchiveHeader(input.archivePath);
  if (!checkPassphrase(header, input.passphrase)) throw new PassphraseError();

  const key = deriveKey(input.passphrase, header.kdf);
  const secret = header.secret ? unseal(key, header.secret) : null;

  const info = await stat(input.archivePath);
  // Where the body starts is read back off the file rather than recomputed from the parsed header:
  // JSON.stringify does not promise a byte-identical round trip, and being one byte out here would
  // decrypt garbage instead of failing cleanly.
  const handle = await open(input.archivePath, "r");
  let bodyStart: number;
  let tag: Buffer;
  try {
    const preamble = Buffer.alloc(PREAMBLE_BYTES);
    await handle.read(preamble, 0, PREAMBLE_BYTES, 0);
    bodyStart = PREAMBLE_BYTES + preamble.readUInt32BE(ARCHIVE_MAGIC.length + 1);
    tag = Buffer.alloc(TAG_BYTES);
    await handle.read(tag, 0, TAG_BYTES, info.size - trailerBytes(header) - TAG_BYTES);
  } finally {
    await handle.close();
  }

  const bodyEnd = info.size - trailerBytes(header) - TAG_BYTES - 1;
  if (bodyEnd < bodyStart) throw new ArchiveFormatError("That archive has no contents.");

  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(header.cipher.iv, "base64"));
  decipher.setAuthTag(tag);

  const hash = createHash("sha256");
  const out = createWriteStream(input.outDumpPath);

  try {
    await pipeline(
      createReadStream(input.archivePath, { start: bodyStart, end: bodyEnd }),
      decipher,
      async function* (source) {
        for await (const chunk of source) {
          hash.update(chunk as Buffer);
          yield chunk;
        }
      },
      out,
    );
  } catch {
    await rm(input.outDumpPath, { force: true }).catch(() => {});
    // GCM reports every kind of damage the same way. Say what it means rather than what it is.
    throw new ArchiveFormatError(
      "That archive did not survive its integrity check — it is truncated, altered, or was not fully uploaded. Nothing has been changed.",
    );
  }

  const produced = await stat(input.outDumpPath);
  if (produced.size !== header.dumpBytes) {
    await rm(input.outDumpPath, { force: true }).catch(() => {});
    throw new ArchiveFormatError(
      `The archive says it holds ${header.dumpBytes} bytes and produced ${produced.size}. Nothing has been changed.`,
    );
  }

  return { header, secret, sha256: hash.digest("hex") };
}

/**
 * Whether the platform signed this archive for this workspace — the whole file, checked against its
 * last 32 bytes. False for a version 1 archive, one signed for another workspace, and one altered
 * after it was written. Reads the file once; call it before anything is extracted.
 */
export async function verifyArchiveSignature(archivePath: string, tenantId: string): Promise<boolean> {
  let header: ArchiveHeader;
  try {
    header = await readArchiveHeader(archivePath);
  } catch {
    return false;
  }
  if (header.signature?.alg !== "hmac-sha256" || header.signature.tenantId !== tenantId) return false;
  const info = await stat(archivePath);
  const signedEnd = info.size - SIGNATURE_BYTES;
  const given = Buffer.alloc(SIGNATURE_BYTES);
  const handle = await open(archivePath, "r");
  try {
    await handle.read(given, 0, SIGNATURE_BYTES, signedEnd);
  } finally {
    await handle.close();
  }
  const signer = platformHmac(tenantId, "backup-archive");
  for await (const chunk of createReadStream(archivePath, { start: 0, end: signedEnd - 1 })) signer.update(chunk as Buffer);
  return timingSafeEqual(signer.digest(), given);
}

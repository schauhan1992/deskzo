import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

/**
 * Storing the same database forty times without storing it forty times.
 *
 * `pg_dump` has no incremental mode — every dump is a complete snapshot, and no flag changes that.
 * Postgres's own incremental options are closed here too: `pg_basebackup --incremental` is a
 * PostgreSQL 17 feature and this runs on 16, and WAL archiving needs `archive_mode = on`, a server
 * restart, and a restore that stops the server and replaces its data directory — which an
 * application talking to Postgres over TCP cannot do, and which a managed Postgres will not let
 * anybody do.
 *
 * So the saving is made downstream of the dump rather than inside it. A dump is split into
 * variable-length chunks, each stored once under the hash of its contents, and a backup becomes a
 * *list of hashes*. Two dumps taken a day apart share almost every chunk, so the second one writes
 * only what changed — while still being a complete, independently restorable snapshot, because its
 * list names every chunk it needs.
 *
 * ## Why the boundaries are content-defined
 *
 * Splitting every 1 MiB at fixed offsets would deduplicate nothing. Insert one row near the start
 * of a dump and every byte after it shifts, so every fixed-size chunk downstream has different
 * contents and a different hash — the classic result is a "incremental" backup that stores 100% of
 * the data every time.
 *
 * Instead a rolling hash runs over the bytes and a boundary is cut wherever the low bits of that
 * hash happen to be zero. Because the decision depends only on the last few dozen bytes, inserting
 * data shifts *one* boundary and leaves every later one exactly where it was.
 *
 * ## The dump must not be compressed
 *
 * This is the detail that decides whether any of it works. A dump taken with `--compress=6` has a
 * deflate stream over the whole file: change one row and every compressed byte after it differs,
 * which destroys the similarity this depends on. So chunked backups dump with `--compress=0` and
 * compression is applied to each stored chunk instead — same total saving, and the chunks still
 * match between runs.
 */

/**
 * Average chunk size, as a power-of-two mask over the rolling hash.
 *
 * 2^18 ≈ 256 KiB. Chunk size is the *granularity floor* of an incremental backup, and that is not
 * obvious until you measure it: at a 1 MiB average this database's 6.5 MB dump split into four
 * chunks, so changing one row could never cost less than a quarter of a full backup. The content
 * chunker was working perfectly — one boundary moved, not four — and the result was still 26%,
 * because four is all the resolution there was.
 *
 * 256 KiB gives roughly twenty-six chunks at today's size and still only forty thousand at ten
 * gigabytes, which is a manageable number of files to keep in a fanned-out directory. Borg and
 * restic sit nearer a megabyte because they are built for repositories far larger than this one.
 *
 * Changing these numbers does not corrupt anything, but it does end deduplication against every
 * backup taken before the change: different boundaries, different hashes, nothing shared. Treat it
 * as a decision that costs one full backup.
 */
const AVERAGE_BITS = 18;
const BOUNDARY_MASK = (1 << AVERAGE_BITS) - 1;

/** No chunk smaller than this, so a pathological input cannot produce millions of tiny files. */
const MIN_CHUNK = 64 * 1024;
/** And none larger, so a run of bytes that never hits a boundary still gets cut. */
const MAX_CHUNK = 1024 * 1024;

/** How far back the rolling hash looks. 48 bytes is the conventional window. */
const WINDOW = 48;

/**
 * The gear table: one random 32-bit value per byte value.
 *
 * Fixed, not generated — the boundaries a dump produces must be identical on every machine and in
 * every future version, or a backup taken today deduplicates against nothing taken tomorrow.
 * Derived deterministically from a fixed seed so the table is reproducible rather than 256 magic
 * numbers nobody can check.
 */
const GEAR = (() => {
  const table = new Uint32Array(256);
  // xorshift32 from a fixed seed: deterministic, well-spread, and three lines.
  let x = 0x9e3779b9;
  for (let i = 0; i < 256; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    table[i] = x;
  }
  return table;
})();

export type Manifest = {
  format: 1;
  /** Ordered. Reassembly is a concatenation, so the order is the file. */
  chunks: string[];
  /** Length of the reassembled dump, for verifying it came back whole. */
  totalBytes: number;
  /** sha256 of the reassembled dump, for verifying it came back correct. */
  sha256: string;
  /** Bytes this run actually added to the store — what "incremental" means in the log. */
  newBytes: number;
  newChunks: number;
};

export function chunkDir(root: string): string {
  return path.join(root, ".chunks");
}

export function manifestDir(root: string): string {
  return path.join(root, ".manifests");
}

export function manifestPath(root: string, id: string): string {
  return path.join(manifestDir(root), `${id}.json`);
}

/**
 * Where a chunk lives: `.chunks/ab/abcdef…gz`.
 *
 * Fanned out by the first byte of the hash because a single directory holding a hundred thousand
 * files is slow to list on every filesystem and hostile on some.
 */
function chunkPath(root: string, hash: string): string {
  return path.join(chunkDir(root), hash.slice(0, 2), `${hash}.gz`);
}

/**
 * Splits a stream into content-defined chunks.
 *
 * Emits Buffers. The rolling hash is computed over the raw bytes; the caller decides what to do
 * with each piece.
 */
function chunker(): Transform {
  let pending: Buffer[] = [];
  let pendingLength = 0;

  const cut = (buf: Buffer, from: number): number => {
    // Returns the offset just past a boundary, or -1 if none is found before MAX_CHUNK.
    let hash = 0;
    const limit = Math.min(buf.length, from + MAX_CHUNK - pendingLength);
    for (let i = from; i < limit; i++) {
      hash = (((hash << 1) >>> 0) + GEAR[buf[i]!]!) >>> 0;
      const soFar = pendingLength + (i - from) + 1;
      if (soFar < MIN_CHUNK) continue;
      if (soFar >= MAX_CHUNK) return i + 1;
      // Only the window's worth of bytes influences the decision, which is what makes a boundary
      // survive an insertion earlier in the file.
      if (i - from >= WINDOW - 1 && (hash & BOUNDARY_MASK) === 0) return i + 1;
    }
    return -1;
  };

  return new Transform({
    readableObjectMode: true,
    transform(piece: Buffer, _enc, done) {
      let offset = 0;
      while (offset < piece.length) {
        const end = cut(piece, offset);
        if (end === -1) {
          const tail = piece.subarray(offset);
          pending.push(tail);
          pendingLength += tail.length;
          break;
        }
        const slice = piece.subarray(offset, end);
        this.push(Buffer.concat([...pending, slice]));
        pending = [];
        pendingLength = 0;
        offset = end;
      }
      done();
    },
    flush(done) {
      if (pendingLength > 0) this.push(Buffer.concat(pending));
      done();
    },
  });
}

async function chunkExists(root: string, hash: string): Promise<boolean> {
  return !!(await stat(chunkPath(root, hash)).catch(() => null));
}

/**
 * Writes one chunk, compressed, and only if it is not already there.
 *
 * Written to a temporary name and renamed into place. A chunk is addressed by the hash of its
 * contents, so a half-written one is not merely incomplete — it is a *lie*, a file whose name
 * promises bytes it does not contain, and every future backup that sees the name would skip
 * writing the real thing.
 */
async function putChunk(root: string, hash: string, data: Buffer): Promise<number> {
  const target = chunkPath(root, hash);
  if (await chunkExists(root, hash)) return 0;

  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  await pipeline(Readable.from([data]), createGzip({ level: 6 }), createWriteStream(temp));
  await rename(temp, target);
  return (await stat(target)).size;
}

/**
 * Splits a dump into the store and returns the manifest describing it.
 *
 * The dump file itself is untouched; the caller decides whether to keep or delete it.
 */
export async function storeDump(root: string, dumpPath: string): Promise<Manifest> {
  await mkdir(chunkDir(root), { recursive: true });
  await mkdir(manifestDir(root), { recursive: true });

  const chunks: string[] = [];
  const whole = createHash("sha256");
  let totalBytes = 0;
  let newBytes = 0;
  let newChunks = 0;

  const source = createReadStream(dumpPath);
  const split = source.pipe(chunker());

  for await (const piece of split as AsyncIterable<Buffer>) {
    whole.update(piece);
    totalBytes += piece.length;
    const hash = createHash("sha256").update(piece).digest("hex");
    const written = await putChunk(root, hash, piece);
    if (written > 0) {
      newBytes += written;
      newChunks += 1;
    }
    chunks.push(hash);
  }

  return { format: 1, chunks, totalBytes, sha256: whole.digest("hex"), newBytes, newChunks };
}

export async function writeManifest(root: string, id: string, manifest: Manifest): Promise<void> {
  await mkdir(manifestDir(root), { recursive: true });
  await writeFile(manifestPath(root, id), JSON.stringify(manifest), "utf8");
}

/**
 * Whether a chunked backup's index is still there.
 *
 * The equivalent of "is the file still in the folder" for a backup that has no file. Only the
 * manifest is checked, not every chunk it names: a listing screen asks this once per row, and
 * verifying thousands of chunks to paint a table would be slow enough to matter and still not be a
 * guarantee by the time anybody clicked. `reassemble` is where a missing piece is caught, before a
 * restore rather than in a list.
 */
export async function manifestExists(root: string, id: string): Promise<boolean> {
  return !!(await stat(manifestPath(root, id)).catch(() => null));
}

export async function readManifest(root: string, id: string): Promise<Manifest | null> {
  try {
    const parsed = JSON.parse(await readFile(manifestPath(root, id), "utf8")) as Partial<Manifest>;
    if (!Array.isArray(parsed.chunks) || typeof parsed.sha256 !== "string") return null;
    return {
      format: 1,
      chunks: parsed.chunks,
      totalBytes: parsed.totalBytes ?? 0,
      sha256: parsed.sha256,
      newBytes: parsed.newBytes ?? 0,
      newChunks: parsed.newChunks ?? 0,
    };
  } catch {
    return null;
  }
}

export class MissingChunkError extends Error {
  constructor(hash: string) {
    super(
      `This backup needs a piece that is no longer in the store (${hash.slice(0, 12)}…). ` +
        "Chunked backups share their pieces, so a store that has been pruned or partly copied cannot rebuild them.",
    );
    this.name = "MissingChunkError";
  }
}

/**
 * Rebuilds the dump a manifest describes.
 *
 * Verified on the way out rather than trusted. Every chunk was written under the hash of its own
 * contents and the manifest carries the hash of the whole, so a store that has been pruned, copied
 * incompletely or corrupted is caught here — before the file reaches a restore, which is the last
 * place anybody wants to discover it.
 */
export async function reassemble(root: string, manifest: Manifest, outPath: string): Promise<void> {
  const out = createWriteStream(outPath);
  const whole = createHash("sha256");

  try {
    for (const hash of manifest.chunks) {
      const file = chunkPath(root, hash);
      if (!(await stat(file).catch(() => null))) throw new MissingChunkError(hash);

      const parts: Buffer[] = [];
      await pipeline(createReadStream(file), createGunzip(), async function* (source) {
        for await (const piece of source) parts.push(piece as Buffer);
      });
      const data = Buffer.concat(parts);

      const actual = createHash("sha256").update(data).digest("hex");
      if (actual !== hash) {
        throw new Error(`A stored piece does not match its own name (${hash.slice(0, 12)}…). The store is damaged.`);
      }

      whole.update(data);
      await new Promise<void>((resolve, reject) => {
        out.write(data, (err) => (err ? reject(err) : resolve()));
      });
    }

    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));

    if (whole.digest("hex") !== manifest.sha256) {
      throw new Error("The rebuilt backup does not match the checksum recorded when it was taken.");
    }
  } catch (err) {
    out.destroy();
    await rm(outPath, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Deletes chunks no surviving manifest names.
 *
 * Mark-and-sweep, and the order is the safety: every manifest still on disk is read *first* to
 * build the set of hashes that must live, and only then is anything deleted. Doing it the other way
 * — deleting a backup's chunks when the backup is pruned — silently destroys every other backup
 * that shared them, which is most of them, and the damage is invisible until a restore.
 *
 * Returns what it removed, because a garbage collector that reports nothing is one nobody trusts.
 */
export async function collectGarbage(root: string): Promise<{ removed: number; freedBytes: number }> {
  const manifests = await readdir(manifestDir(root)).catch(() => [] as string[]);

  const live = new Set<string>();
  for (const name of manifests) {
    if (!name.endsWith(".json")) continue;
    const manifest = await readManifest(root, name.replace(/\.json$/, ""));
    // A manifest that cannot be read is treated as live rather than ignored: its chunks might be
    // the only copy, and an unreadable index is a reason to keep data, not to delete it.
    if (!manifest) return { removed: 0, freedBytes: 0 };
    for (const hash of manifest.chunks) live.add(hash);
  }

  let removed = 0;
  let freedBytes = 0;
  const prefixes = await readdir(chunkDir(root)).catch(() => [] as string[]);
  for (const prefix of prefixes) {
    const dir = path.join(chunkDir(root), prefix);
    const files = await readdir(dir).catch(() => [] as string[]);
    for (const file of files) {
      const hash = file.replace(/\.gz$/, "");
      if (live.has(hash)) continue;
      // Leftover temporaries from an interrupted write are swept here too, which is the only place
      // that ever looks at them.
      const full = path.join(dir, file);
      const info = await stat(full).catch(() => null);
      await rm(full, { force: true }).catch(() => {});
      removed += 1;
      freedBytes += info?.size ?? 0;
    }
  }

  return { removed, freedBytes };
}

/** What the store currently holds, for the screen that has to justify its disk usage. */
export async function storeSize(root: string): Promise<{ chunks: number; bytes: number }> {
  let chunks = 0;
  let bytes = 0;
  const prefixes = await readdir(chunkDir(root)).catch(() => [] as string[]);
  for (const prefix of prefixes) {
    const dir = path.join(chunkDir(root), prefix);
    for (const file of await readdir(dir).catch(() => [] as string[])) {
      const info = await stat(path.join(dir, file)).catch(() => null);
      if (!info) continue;
      chunks += 1;
      bytes += info.size;
    }
  }
  return { chunks, bytes };
}

import { createReadStream, openSync, readSync, closeSync, fstatSync } from "fs";
import { createInflateRaw } from "zlib";
import { createInterface } from "readline";

/**
 * The lines of one file inside a zip, read as a stream — enough of the zip format for GeoNames'
 * downloads, with nothing to install.
 *
 * Reads the central directory from the end of the file to find the entry, then streams its
 * compressed bytes through zlib's raw inflate and splits them into lines. Memory stays flat however
 * large the entry: the full UK postcode file unpacks to well over a hundred megabytes, and none of
 * it needs to be held at once.
 *
 * Handles what GeoNames publishes — deflated or stored entries in an ordinary (not ZIP64) archive —
 * and says so plainly for anything else rather than returning half a file.
 */

export class ZipError extends Error {}

type Entry = { name: string; method: number; compressedSize: number; dataOffset: number };

function readAt(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  const read = readSync(fd, buf, 0, length, position);
  return buf.subarray(0, read);
}

export function zipEntries(path: string): Entry[] {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    // The end-of-central-directory record is in the last 22 bytes, plus up to 64 KB of comment.
    const tailLength = Math.min(size, 22 + 65_535);
    const tail = readAt(fd, size - tailLength, tailLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ZipError("That isn't a zip file.");
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff || count === 0xffff) throw new ZipError("ZIP64 archives aren't supported.");

    const cd = readAt(fd, cdOffset, cdSize);
    const entries: Entry[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new ZipError("The zip's directory is damaged.");
      const method = cd.readUInt16LE(p + 10);
      const compressedSize = cd.readUInt32LE(p + 20);
      const nameLength = cd.readUInt16LE(p + 28);
      const extraLength = cd.readUInt16LE(p + 30);
      const commentLength = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLength).toString("utf8");
      // The data starts after the local header, whose own name and extra lengths can differ.
      const local = readAt(fd, localOffset, 30);
      if (local.readUInt32LE(0) !== 0x04034b50) throw new ZipError("The zip's entries are damaged.");
      const dataOffset = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      entries.push({ name, method, compressedSize, dataOffset });
      p += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    closeSync(fd);
  }
}

/** Every line of the entry whose name ends with `suffix` (e.g. "cities1000.txt"). */
export async function* zipLines(path: string, suffix: string): AsyncGenerator<string> {
  const entry = zipEntries(path).find((e) => e.name === suffix || e.name.endsWith(`/${suffix}`) || e.name.endsWith(suffix));
  if (!entry) throw new ZipError(`There's no ${suffix} in that zip.`);
  if (entry.method !== 8 && entry.method !== 0) throw new ZipError("That zip uses a compression this can't read.");
  const raw = createReadStream(path, { start: entry.dataOffset, end: entry.dataOffset + entry.compressedSize - 1 });
  const stream = entry.method === 8 ? raw.pipe(createInflateRaw()) : raw;
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) yield line;
}

/** Every line of a plain text file, streamed the same way. */
export async function* fileLines(path: string): AsyncGenerator<string> {
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) yield line;
}

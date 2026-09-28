import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, type ReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { ATTACHMENT_EXPIRED, SupportRefused, TYPE_REFUSED } from "@/lib/support/refused";
import { LIMITS, type SupportUploadKind } from "@/lib/support/types";

/**
 * Where support requests' files live: on disk, under SUPPORT_DIR (default `storage/support` in the
 * app's folder), like BACKUP_DIR — never in a database row, never in a public folder.
 *
 *   <SUPPORT_DIR>/<tenantId>/staging/<uploadId>          uploaded, not yet sent with a request
 *   <SUPPORT_DIR>/<tenantId>/staging/<uploadId>.json     who uploaded it, and what it was sniffed as
 *   <SUPPORT_DIR>/<tenantId>/<requestId>/<attachmentId>  sent: the attachment's `storageKey`
 *
 * A file is uploaded as soon as it is chosen (so pressing Send is quick) and waits in staging; sending
 * the request claims it — only the person who uploaded it, in the workspace they uploaded it in — and
 * moves it under the request. Anything left in staging is swept after a day by the platform tick.
 *
 * What a file is comes from its first bytes, never its name or the type the browser claims: images,
 * PDF, office documents and zips, plain text; recordings only WebM or MP4. SVG and HTML are refused
 * whatever they are called — a page that runs script, served from the console's own address, is the
 * one thing an attachment must never be.
 *
 * Every path is built from ids that match one pattern, then checked with `path.relative` to be inside
 * SUPPORT_DIR, so no id — however it was forged — reaches another folder.
 */

/** Ids that name folders and files: cuids, and the upload ids made here. */
const ID_PATTERN = /^[A-Za-z0-9_-]{10,64}$/;
/** Bytes read from the front of a file to tell what it is — and, for text, to check it is text. */
const HEAD_BYTES = 64 * 1024;
const STAGING = "staging";

/** The most a person's staged, unsent uploads may hold at once, and how many uploads an hour they may make. */
export const STAGING_LIMITS = { bytesPerUser: 150 * 1024 * 1024, uploadsPerHour: 30 } as const;

/** The file route's fixed headers: never sniffed into something else, never cached, never able to run anything. */
export const FILE_SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "private, no-store",
  "Content-Security-Policy": "sandbox; default-src 'none'; media-src 'self'; img-src 'self'",
} as const;

export type StagedMeta = {
  userId: string;
  tenantId: string;
  kind: SupportUploadKind;
  filename: string;
  /** What the bytes were sniffed as. */
  mime: string;
  size: number;
  sha256: string;
  /** ISO. */
  createdAt: string;
};

export type StagedUpload = StagedMeta & { uploadId: string };

/** SUPPORT_DIR, resolved when asked — so a check suite can point it at a temporary folder. */
export function supportDir(): string {
  return path.resolve(process.env.SUPPORT_DIR?.trim() || path.join(process.cwd(), "storage", "support"));
}

export function validId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/** `parts` joined under SUPPORT_DIR, or null when the result would be SUPPORT_DIR itself or anywhere outside it. */
function inside(...parts: string[]): string | null {
  const root = supportDir();
  const full = path.resolve(root, ...parts);
  const rel = path.relative(root, full);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return full;
}

function need(p: string | null): string {
  if (!p) throw new SupportRefused(ATTACHMENT_EXPIRED);
  return p;
}

const stagingDir = (tenantId: string) => need(validId(tenantId) ? inside(tenantId, STAGING) : null);
const stagedPath = (tenantId: string, uploadId: string, suffix = "") => need(validId(uploadId) ? inside(stagingDir(tenantId), `${uploadId}${suffix}`) : null);
const requestDir = (tenantId: string, requestId: string) => need(validId(tenantId) && validId(requestId) ? inside(tenantId, requestId) : null);

/** A storage key's file, or null for anything that is not three ids: `<tenantId>/<requestId>/<attachmentId>`. */
function keyPath(storageKey: unknown): string | null {
  if (typeof storageKey !== "string") return null;
  const parts = storageKey.split("/");
  if (parts.length !== 3 || !parts.every(validId)) return null;
  return inside(...parts);
}

// ─── Names ───────────────────────────────────────────────────────────────────────────────────────

/** A character nobody means in a file name: control characters, the bidi overrides, zero-width marks. */
function unwanted(code: number): boolean {
  return code < 32 || code === 127 || (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff;
}

/**
 * A name to show and to download under: the last path segment, without control characters or the
 * characters Windows refuses, spaces collapsed, no leading dots, at most 200 characters.
 */
export function cleanFilename(raw: unknown, fallback: string): string {
  const base = String(raw ?? "").split(/[\\/]/).pop() ?? "";
  let out = "";
  for (const ch of base) {
    if (unwanted(ch.codePointAt(0) ?? 0) || '"<>|*?:'.includes(ch)) continue;
    out += ch;
  }
  out = out.replace(/\s+/g, " ").trim().replace(/^\.+/, "").trim();
  out = [...out].slice(0, 200).join("").trim();
  return out || fallback;
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

// ─── What a file is ──────────────────────────────────────────────────────────────────────────────

const OFFICE: Record<string, string> = {
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const TEXT: Record<string, string> = { txt: "text/plain", log: "text/plain", csv: "text/csv" };

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0) => b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);
const ascii = (b: Uint8Array, at: number, n: number) => (b.length >= at + n ? String.fromCharCode(...b.subarray(at, at + n)) : "");

function sniffImage(b: Uint8Array): string | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a") return "image/gif";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "image/webp";
  return null;
}

/**
 * The start of an HTML or SVG document, as a browser sniffing for HTML would take it (the WHATWG
 * MIME-sniffing patterns, plus XML and SVG): a text file that is really a page is refused like one.
 */
const MARKUP_TAGS = ["!doctype html", "html", "head", "script", "iframe", "h1", "div", "font", "table", "a", "style", "title", "b", "body", "br", "p", "svg"];
function looksLikeMarkup(head: Uint8Array): boolean {
  let text = new TextDecoder("utf-8").decode(head.subarray(0, 1024));
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.trimStart().toLowerCase();
  if (text.startsWith("<!--") || text.startsWith("<?xml")) return true;
  return MARKUP_TAGS.some((tag) => {
    if (!text.startsWith(`<${tag}`)) return false;
    const next = text.charAt(tag.length + 1);
    return next === "" || next === ">" || next === "/" || /\s/.test(next);
  });
}

/** UTF-8 throughout the first 64 KB (a character cut at the end is fine), no NUL byte, and not markup. */
function isPlainText(head: Uint8Array): boolean {
  if (head.length === 0 || head.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(0, HEAD_BYTES), { stream: true });
  } catch {
    return false;
  }
  return !looksLikeMarkup(head);
}

/**
 * What an upload is, from its first bytes (64 KB is plenty) — the type to store and serve it as — or
 * null when it can't be attached:
 *
 *   file        PNG, JPEG, GIF, WebP · PDF (`%PDF-`) · a zip (`PK\x03\x04`) named .zip/.docx/.xlsx/.pptx
 *               · UTF-8 text without NUL bytes named .txt/.log/.csv, and not HTML or SVG
 *   recording   WebM (`1A 45 DF A3`) or MP4 (`ftyp` at byte 4), and nothing else
 *
 * The name only ever narrows: a zip's and a text file's extension must be one of theirs, and an image
 * is an image whatever it is called.
 */
export function sniffSupportFile(bytes: Uint8Array, filename: string, kind: SupportUploadKind): string | null {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return null;
  if (kind === "recording") {
    if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
    if (ascii(bytes, 4, 4) === "ftyp") return "video/mp4";
    return null;
  }
  if (kind !== "file") return null;
  const image = sniffImage(bytes);
  if (image) return image;
  if (ascii(bytes, 0, 5) === "%PDF-") return "application/pdf";
  const ext = extensionOf(filename);
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return OFFICE[ext] ?? null;
  if (TEXT[ext] && isPlainText(bytes)) return TEXT[ext];
  return null;
}

const tooLarge = (kind: SupportUploadKind) => (kind === "recording" ? `That recording is over ${LIMITS.recordingBytes / 1024 / 1024} MB.` : `That file is over ${LIMITS.fileBytes / 1024 / 1024} MB.`);

/** The most one upload of this kind may be. */
export function uploadCap(kind: SupportUploadKind): number {
  return kind === "recording" ? LIMITS.recordingBytes : LIMITS.fileBytes;
}

// ─── Staging ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Streams an upload into staging and says what it is. The bytes are counted as they arrive — a
 * declared length is only a claim — and past `maxBytes` (never more than the kind's cap) the upload
 * stops, its partial file is deleted and a 413 refusal is thrown. Then it is sniffed: an empty file,
 * or one of a type that can't be attached, is deleted and refused. What was stored is written beside
 * it (`<uploadId>.json`) for the claim to check.
 */
export async function stageUpload(
  body: AsyncIterable<Uint8Array>,
  meta: { tenantId: string; userId: string; kind: SupportUploadKind; filename: string; maxBytes?: number },
): Promise<StagedUpload> {
  const { tenantId, userId, kind } = meta;
  if (!validId(tenantId) || !validId(userId) || (kind !== "file" && kind !== "recording")) throw new SupportRefused("That upload can't be accepted.", 400);
  const cap = Math.max(0, Math.min(meta.maxBytes ?? uploadCap(kind), uploadCap(kind)));
  const uploadId = randomBytes(16).toString("base64url");
  await mkdir(stagingDir(tenantId), { recursive: true });
  const part = stagedPath(tenantId, uploadId, ".part");
  const file = stagedPath(tenantId, uploadId);
  const sidecar = stagedPath(tenantId, uploadId, ".json");

  const hash = createHash("sha256");
  const head: Buffer[] = [];
  let headLength = 0;
  let size = 0;
  const out = createWriteStream(part, { flags: "wx" });
  try {
    await pipeline(
      body,
      async function* (source: AsyncIterable<Uint8Array>) {
        for await (const chunk of source) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buf.length;
          if (size > cap) throw new SupportRefused(size > uploadCap(kind) ? tooLarge(kind) : "You have too many attachments waiting to be sent — send or remove some first.", 413);
          hash.update(buf);
          if (headLength < HEAD_BYTES) {
            const take = Buffer.from(buf.subarray(0, HEAD_BYTES - headLength));
            head.push(take);
            headLength += take.length;
          }
          yield buf;
        }
      },
      out,
    );
  } catch (err) {
    // A first chunk already over the cap stops the pipeline while the file is still being opened: wait
    // for it to close, or the delete runs before the file exists and an empty part is left behind.
    if (!out.closed) await new Promise<void>((resolve) => out.once("close", () => resolve()));
    await rm(part, { force: true }).catch(() => {});
    if (err instanceof SupportRefused) throw err;
    throw new SupportRefused("The upload didn't finish. Please try again.", 400);
  }

  const cleanName = cleanFilename(meta.filename, kind === "recording" ? "screen-recording" : "attachment");
  const mime = size > 0 ? sniffSupportFile(Buffer.concat(head), cleanName, kind) : null;
  if (!mime) {
    await rm(part, { force: true }).catch(() => {});
    throw size === 0 ? new SupportRefused("That file is empty.", 400) : new SupportRefused(TYPE_REFUSED, 415);
  }
  // A recording is named for what it is, whatever the browser called the blob.
  const filename = kind === "recording" ? `${cleanName.replace(/\.[^.]*$/, "") || "screen-recording"}.${mime === "video/mp4" ? "mp4" : "webm"}` : cleanName;
  const staged: StagedMeta = { userId, tenantId, kind, filename, mime, size, sha256: hash.digest("hex"), createdAt: new Date().toISOString() };
  try {
    await rename(part, file);
    await writeFile(sidecar, JSON.stringify(staged), { encoding: "utf8", flag: "wx" });
  } catch {
    await Promise.all([rm(part, { force: true }), rm(file, { force: true }), rm(sidecar, { force: true })]).catch(() => {});
    throw new SupportRefused("The upload didn't finish. Please try again.", 500);
  }
  return { uploadId, ...staged };
}

function asMeta(value: unknown): StagedMeta | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const m = value as Record<string, unknown>;
  const ok =
    validId(m.userId) &&
    validId(m.tenantId) &&
    (m.kind === "file" || m.kind === "recording") &&
    typeof m.filename === "string" &&
    typeof m.mime === "string" &&
    typeof m.size === "number" &&
    Number.isSafeInteger(m.size) &&
    m.size >= 0 &&
    typeof m.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(m.sha256) &&
    typeof m.createdAt === "string";
  return ok ? (m as unknown as StagedMeta) : null;
}

/** A staged upload's record — null when the id is not one, or there is no such upload (sent, swept, never made). */
export async function readStaged(tenantId: string, uploadId: string): Promise<StagedMeta | null> {
  if (!validId(tenantId) || !validId(uploadId)) return null;
  try {
    const meta = asMeta(JSON.parse(await readFile(stagedPath(tenantId, uploadId, ".json"), "utf8")));
    if (!meta || meta.tenantId !== tenantId) return null;
    const file = await stat(stagedPath(tenantId, uploadId));
    return file.isFile() ? meta : null;
  } catch {
    return null;
  }
}

/** How many bytes a person has waiting in staging, in this workspace — against STAGING_LIMITS.bytesPerUser. */
export async function stagedBytesFor(tenantId: string, userId: string): Promise<number> {
  if (!validId(tenantId) || !validId(userId)) return 0;
  let names: string[];
  try {
    names = await readdir(stagingDir(tenantId));
  } catch {
    return 0;
  }
  let total = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const meta = asMeta(JSON.parse(await readFile(stagedPath(tenantId, name.slice(0, -5), ".json"), "utf8")));
      if (meta && meta.userId === userId) total += meta.size;
    } catch {
      // Being written or swept this moment; the next upload counts it.
    }
  }
  return total;
}

/**
 * Moves a staged upload under its request, as `<tenantId>/<requestId>/<attachmentId>` — only when
 * `userId` uploaded it in `tenantId`. Anything else (another person's upload, another workspace's,
 * one already sent or swept, an id that is not one) is the same refusal: "That attachment has expired".
 */
export async function claimStaged(tenantId: string, userId: string, uploadId: string, requestId: string, attachmentId: string): Promise<{ storageKey: string; meta: StagedMeta }> {
  if (![tenantId, userId, uploadId, requestId, attachmentId].every(validId)) throw new SupportRefused(ATTACHMENT_EXPIRED);
  const meta = await readStaged(tenantId, uploadId);
  if (!meta || meta.userId !== userId || meta.tenantId !== tenantId) throw new SupportRefused(ATTACHMENT_EXPIRED);
  const dir = requestDir(tenantId, requestId);
  const target = need(inside(tenantId, requestId, attachmentId));
  await mkdir(dir, { recursive: true });
  try {
    await rename(stagedPath(tenantId, uploadId), target);
  } catch {
    // Claimed by another send a moment ago, or swept.
    throw new SupportRefused(ATTACHMENT_EXPIRED);
  }
  await rm(stagedPath(tenantId, uploadId, ".json"), { force: true }).catch(() => {});
  return { storageKey: `${tenantId}/${requestId}/${attachmentId}`, meta };
}

/** Removes a person's own staged upload (the dialog's remove button). False when it isn't theirs or isn't there. */
export async function discardStaged(tenantId: string, userId: string, uploadId: string): Promise<boolean> {
  const meta = await readStaged(tenantId, uploadId);
  if (!meta || meta.userId !== userId) return false;
  await Promise.all([rm(stagedPath(tenantId, uploadId), { force: true }), rm(stagedPath(tenantId, uploadId, ".json"), { force: true })]);
  return true;
}

/**
 * Deletes staged uploads (and half-finished ones) older than `olderThanMs`, in every workspace's
 * staging folder. Returns how many uploads went. The tick runs it with a day.
 */
export async function sweepStaging(olderThanMs: number, now: number = Date.now()): Promise<number> {
  let tenants: string[];
  try {
    tenants = (await readdir(supportDir(), { withFileTypes: true })).filter((d) => d.isDirectory() && validId(d.name)).map((d) => d.name);
  } catch {
    return 0; // No SUPPORT_DIR yet: nothing was ever uploaded.
  }
  const cutoff = now - Math.max(0, olderThanMs);
  let removed = 0;
  for (const tenantId of tenants) {
    const dir = stagingDir(tenantId);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const match = /^([A-Za-z0-9_-]{10,64})(\.json|\.part)?$/.exec(name);
      if (!match) continue;
      const file = need(inside(dir, name));
      try {
        const info = await stat(file);
        if (!info.isFile() || info.mtimeMs > cutoff) continue;
        await rm(file, { force: true });
        if (match[2] !== ".json") removed += 1;
      } catch {
        // Claimed or removed meanwhile.
      }
    }
  }
  return removed;
}

// ─── Sent attachments ────────────────────────────────────────────────────────────────────────────

/**
 * An attachment's bytes — all of them, or `range` (inclusive, as HTTP writes it) — and the file's whole
 * size. Null when the key is not one or the file is gone (purged, or lost with the disk).
 */
export async function openAttachment(storageKey: string, range?: { start: number; end: number }): Promise<{ stream: ReadStream; size: number } | null> {
  const file = keyPath(storageKey);
  if (!file) return null;
  let size: number;
  try {
    const info = await stat(file);
    if (!info.isFile()) return null;
    size = info.size;
  } catch {
    return null;
  }
  if (range && !(Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) && range.start >= 0 && range.start <= range.end && range.end < size)) {
    throw new RangeError("The range is outside the file.");
  }
  return { stream: createReadStream(file, range ? { start: range.start, end: range.end } : {}), size };
}

/** An attachment's size on disk, without opening it — what a HEAD request is answered with. Null as openAttachment would be. */
export async function attachmentSize(storageKey: string): Promise<number | null> {
  const file = keyPath(storageKey);
  if (!file) return null;
  try {
    const info = await stat(file);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

/**
 * A `Range` header against a file of `size` bytes: one range to send (inclusive), "unsatisfiable"
 * (answer 416), or null — no header, several ranges or one this does not read — to send the whole file.
 */
export function parseByteRange(header: string | null | undefined, size: number): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return null;
  if (size <= 0) return "unsatisfiable";
  if (match[1] === "") {
    // The last n bytes.
    const n = Number(match[2]);
    if (!Number.isSafeInteger(n) || n <= 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size) return "unsatisfiable";
  if (end < start) return null;
  return { start, end };
}

/** `inline` for images and video (so they show and play), a download for everything else — each with its name. */
export function attachmentDisposition(mime: string, filename: string): string {
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${/^(image|video)\//.test(mime) ? "inline" : "attachment"}; filename*=UTF-8''${encoded}`;
}

/** Deletes an attachment's file, for retention. True once it is gone (or already was); false for a key that is not one. */
export async function purgeAttachment(storageKey: string): Promise<boolean> {
  const file = keyPath(storageKey);
  if (!file) return false;
  await rm(file, { force: true });
  // The request's folder, once its last file has gone. Refused while anything is left in it.
  await rmdir(path.dirname(file)).catch(() => {});
  return true;
}

/** Every file of one request — when sending it failed halfway, or it is deleted. */
export async function deleteRequestFiles(tenantId: string, requestId: string): Promise<void> {
  if (!validId(tenantId) || !validId(requestId)) return;
  await rm(requestDir(tenantId, requestId), { recursive: true, force: true });
}

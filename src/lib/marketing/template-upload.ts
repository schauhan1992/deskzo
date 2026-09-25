import JSZip from "jszip";

/**
 * Reading an uploaded email template — one `.html` file, or a `.zip` of the HTML and its pictures, as
 * Stripo, BEE, Mailchimp and Canva export them. No database in here: this finds the HTML, the
 * pictures and the references between them; storing the pictures and cleaning the HTML happen after.
 *
 * Every limit is a size a real email never needs and a hostile upload always does: a 10 MB archive,
 * 60 pictures of 2 MB each, and a zip that claims to inflate past 40 MB is refused before it is read.
 */

export const UPLOAD_LIMITS = {
  fileBytes: 10 * 1024 * 1024,
  htmlBytes: 1024 * 1024,
  imageBytes: 2 * 1024 * 1024,
  images: 60,
  inflatedBytes: 40 * 1024 * 1024,
} as const;

export type UploadedImage = {
  /** Its path inside the upload, "/"-separated, from the root of the archive. */
  path: string;
  fileName: string;
  mimeType: string;
  data: Buffer;
};

export type ReadOutcome =
  | { ok: true; html: string; htmlPath: string; images: UploadedImage[]; skipped: string[] }
  | { ok: false; error: string };

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp)$/i;

/** What the bytes say the picture is — never what the file name claims. */
export function sniffImage(data: Buffer): string | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 6 && /^GIF8[79]a$/.test(data.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (data.length >= 12 && data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

function decodeText(data: Buffer): string {
  // A byte-order mark in front of <!doctype> is invisible and breaks the first tag.
  return data.toString("utf8").replace(/^﻿/, "");
}

/** "a/b/../c/./d.png" into "a/c/d.png". Null when it climbs out of the archive. */
export function normalisePath(path: string): string | null {
  const out: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export async function readTemplateUpload(fileName: string, bytes: Buffer): Promise<ReadOutcome> {
  if (bytes.length > UPLOAD_LIMITS.fileBytes) return { ok: false, error: "That file is over 10 MB. An email template never needs to be." };
  const lower = fileName.toLowerCase();

  if (lower.endsWith(".html") || lower.endsWith(".htm")) {
    if (bytes.length > UPLOAD_LIMITS.htmlBytes) return { ok: false, error: "That HTML is over 1 MB — too big for an inbox. Most clients clip anything past 100 KB." };
    return { ok: true, html: decodeText(bytes), htmlPath: fileName, images: [], skipped: [] };
  }
  if (!lower.endsWith(".zip")) return { ok: false, error: "Upload an .html file, or a .zip of the HTML and its images." };

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return { ok: false, error: "That .zip couldn't be opened." };
  }

  const entries = Object.values(zip.files).filter((f) => !f.dir && !/(^|\/)(__MACOSX|\.)/.test(f.name));
  // What the archive says it holds, before a byte of it is inflated.
  const declared = entries.reduce((t, f) => t + ((f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0), 0);
  if (declared > UPLOAD_LIMITS.inflatedBytes) return { ok: false, error: "That .zip unpacks to more than 40 MB. An email template never needs to." };

  const htmlFiles = entries.filter((f) => /\.html?$/i.test(f.name));
  if (htmlFiles.length === 0) return { ok: false, error: "There's no .html file in that .zip." };
  // index.html nearest the top, else the only one, else the biggest — the email, not a stray page.
  const depth = (p: string) => p.split("/").length;
  const chosen =
    htmlFiles.filter((f) => /(^|\/)index\.html?$/i.test(f.name)).sort((a, b) => depth(a.name) - depth(b.name))[0] ??
    (htmlFiles.length === 1 ? htmlFiles[0] : null) ??
    (await Promise.all(htmlFiles.map(async (f) => ({ f, size: (await f.async("nodebuffer")).length })))).sort((a, b) => b.size - a.size)[0]!.f;

  const htmlBytes = await chosen.async("nodebuffer");
  if (htmlBytes.length > UPLOAD_LIMITS.htmlBytes) return { ok: false, error: "The HTML in that .zip is over 1 MB — too big for an inbox." };

  const images: UploadedImage[] = [];
  const skipped: string[] = [];
  for (const entry of entries) {
    if (entry === chosen || /\.html?$/i.test(entry.name)) continue;
    const path = normalisePath(entry.name);
    if (!path) continue;
    if (!IMAGE_EXTENSIONS.test(path)) {
      // CSS, fonts and SVG don't survive the trip to an inbox; say so rather than dropping them quietly.
      if (!/\.(txt|md|json|xml)$/i.test(path)) skipped.push(`${path} — not a picture an email can show`);
      continue;
    }
    if (images.length >= UPLOAD_LIMITS.images) {
      skipped.push(`${path} — more than ${UPLOAD_LIMITS.images} pictures`);
      continue;
    }
    const data = await entry.async("nodebuffer");
    if (data.length > UPLOAD_LIMITS.imageBytes) {
      skipped.push(`${path} — over 2 MB; shrink it and upload again`);
      continue;
    }
    const mimeType = sniffImage(data);
    if (!mimeType) {
      skipped.push(`${path} — the file isn't the picture its name says`);
      continue;
    }
    images.push({ path, fileName: path.split("/").pop()!, mimeType, data });
  }

  return { ok: true, html: decodeText(htmlBytes), htmlPath: chosen.name, images, skipped };
}

// ─── References ─────────────────────────────────────────────────────────────

const ATTRIBUTE_REF = /(\s(?:src|background)\s*=\s*)(["'])([^"']*)\2/gi;
const CSS_REF = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;

function isLocal(ref: string): boolean {
  const r = ref.trim();
  return !!r && !/^([a-z][a-z0-9+.-]*:|\/\/|\/|#|\{\{)/i.test(r);
}

/**
 * Every relative picture reference — `src`, `background`, CSS `url()` — replaced by what `resolve`
 * returns for its path inside the upload; the ones it can't resolve are reported, not guessed at.
 * Web links, `{{merge}}` fields and our own root-relative paths are left alone.
 */
export function rewriteImageRefs(html: string, htmlPath: string, resolve: (path: string) => string | null): { html: string; missing: string[] } {
  const base = dirOf(normalisePath(htmlPath) ?? "");
  const missing = new Set<string>();
  const swap = (ref: string): string | null => {
    if (!isLocal(ref)) return null;
    let decoded = ref.trim().split(/[?#]/)[0]!;
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // A stray % in a file name; use it as written.
    }
    const path = normalisePath(base ? `${base}/${decoded}` : decoded);
    const url = path ? resolve(path) : null;
    if (!url) missing.add(ref.trim());
    return url;
  };
  const out = html
    .replace(ATTRIBUTE_REF, (whole, before: string, quote: string, ref: string) => {
      const url = swap(ref);
      return url ? `${before}${quote}${url}${quote}` : whole;
    })
    .replace(CSS_REF, (whole, quote: string, ref: string) => {
      const url = swap(ref);
      return url ? `url(${quote}${url}${quote})` : whole;
    });
  return { html: out, missing: [...missing] };
}

/**
 * Pictures written into the HTML as `data:` addresses — some exporters do this — lifted out into
 * uploads of their own. Most mail clients show no `data:` image at all, and they make the message
 * enormous.
 */
export function extractInlineImages(html: string): { html: string; images: UploadedImage[] } {
  const images: UploadedImage[] = [];
  const out = html.replace(/(\ssrc\s*=\s*)(["'])data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=\s]+)\2/gi, (whole, before: string, quote: string, _mime: string, b64: string) => {
    if (images.length >= UPLOAD_LIMITS.images) return whole;
    const data = Buffer.from(b64.replace(/\s+/g, ""), "base64");
    const mimeType = sniffImage(data);
    if (!mimeType || data.length > UPLOAD_LIMITS.imageBytes) return whole;
    const path = `inline-${images.length + 1}.${mimeType.split("/")[1]!.replace("jpeg", "jpg")}`;
    images.push({ path, fileName: path, mimeType, data });
    return `${before}${quote}${path}${quote}`;
  });
  return { html: out, images };
}

import { createHash } from "node:crypto";
import type { Prisma } from "@wroffy/control-client";
import { actorRef, cmsAudit, refLabels, type CmsActor } from "@/lib/cms/audit";
import { CmsRefused, MEDIA_MAX_BYTES, type MediaRow, type MediaType, type MediaUsage, type Paged } from "@/lib/cms/types";
import { controlDb } from "@/lib/platform/control-db";

/**
 * The website's media library: images kept in the control plane (site_media) and served publicly at
 * /media/<id> (src/app/platform-site/media/[id]/route.ts).
 *
 *   · PNG, JPEG, WebP and GIF only, told apart by their first bytes — never by the name or the type
 *     the browser claims. SVG (which can carry script), HTML and everything else is refused.
 *   · 5 MB at most. Width and height are read from the file's own header.
 *   · The same bytes uploaded twice are one image (by SHA-256): the second upload returns the first.
 *   · Alt text may be empty at upload; nothing using the image can be published until it has some.
 *   · An image in use — on a page, a post or the site's settings, draft or published — cannot be
 *     deleted; the refusal says where it is used.
 *
 * No list here ever selects the bytes.
 */

const MEDIA_ID = /^[a-z0-9]{20,40}$/;
const PAGE_SIZE = 48;

const ROW_SELECT = { id: true, filename: true, mime: true, size: true, width: true, height: true, alt: true, createdAt: true, createdBy: true } as const satisfies Prisma.SiteMediaSelect;
type RowData = Prisma.SiteMediaGetPayload<{ select: typeof ROW_SELECT }>;

async function toRows(rows: RowData[]): Promise<MediaRow[]> {
  const labels = await refLabels(rows.map((r) => r.createdBy));
  return rows.map((r) => ({ ...r, url: `/media/${r.id}`, needsAlt: !r.alt.trim(), createdBy: labels.get(r.createdBy) ?? r.createdBy }));
}

// ─── Reading an image's header ───────────────────────────────────────────────────────────────────

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    // Fill bytes, and markers with no length.
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const length = u16be(b, i + 2);
    if (length < 2) return null;
    // Start of frame: every SOFn except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: u16be(b, i + 5), width: u16be(b, i + 7) };
    }
    if (marker === 0xda || marker === 0xd9) return null;
    i += 2 + length;
  }
  return null;
}

/** What the bytes are — one of the four types, with the picture's size — or null for anything else. */
export function sniffImage(b: Uint8Array): { mime: MediaType; width: number; height: number } | null {
  if (b.length < 16) return null;
  // PNG: its signature, then the IHDR chunk's width and height.
  if (b[0] === 0x89 && ascii(b, 1, 3) === "PNG" && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    if (b.length < 24 || ascii(b, 12, 4) !== "IHDR") return null;
    return { mime: "image/png", width: u32be(b, 16), height: u32be(b, 20) };
  }
  // GIF87a / GIF89a: the logical screen's width and height.
  if (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a") return { mime: "image/gif", width: u16le(b, 6), height: u16le(b, 8) };
  // JPEG: the first start-of-frame segment.
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    const size = jpegSize(b);
    return size ? { mime: "image/jpeg", ...size } : null;
  }
  // WebP: RIFF….WEBP, then a lossy, lossless or extended header.
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP" && b.length >= 30) {
    const chunk = ascii(b, 12, 4);
    if (chunk === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { mime: "image/webp", width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    if (chunk === "VP8L" && b[20] === 0x2f) {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { mime: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") return { mime: "image/webp", width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
    return null;
  }
  return null;
}

const EXT: Record<MediaType, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

function cleanFilename(raw: unknown, mime: MediaType): string {
  const base = String(raw ?? "").split(/[\\/]/).pop() ?? "";
  const name = base.replace(/[\u0000-\u001f\u007f"<>|*?:]+/g, "").replace(/\s{2,}/g, " ").trim().slice(0, 200);
  return name || `image.${EXT[mime]}`;
}

function cleanAlt(raw: unknown): string {
  const alt = String(raw ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s{2,}/g, " ").trim();
  if (alt.length > 300) throw new CmsRefused("Keep the alt text to 300 characters.");
  return alt;
}

// ─── Upload, list, change, delete ────────────────────────────────────────────────────────────────

/** A file as a server action receives it from FormData. */
export type UploadedFile = { name?: string; size: number; arrayBuffer(): Promise<ArrayBuffer> };

export async function uploadMedia(file: UploadedFile | null | undefined, altInput: unknown, actor: CmsActor): Promise<MediaRow & { duplicate: boolean }> {
  if (!file || typeof file !== "object" || typeof file.arrayBuffer !== "function") throw new CmsRefused("Choose an image to upload.");
  if (file.size > MEDIA_MAX_BYTES) throw new CmsRefused("That image is over 5 MB. Make it smaller and try again.");
  if (file.size === 0) throw new CmsRefused("That file is empty.");
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length > MEDIA_MAX_BYTES) throw new CmsRefused("That image is over 5 MB. Make it smaller and try again.");
  const kind = sniffImage(bytes);
  if (!kind) throw new CmsRefused("Only PNG, JPEG, WebP and GIF images can be uploaded.");
  if (!kind.width || !kind.height || kind.width > 20_000 || kind.height > 20_000) throw new CmsRefused("That image's size could not be read.");
  const alt = cleanAlt(altInput);
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const existing = await controlDb().siteMedia.findUnique({ where: { sha256 }, select: ROW_SELECT });
  if (existing) return { ...(await toRows([existing]))[0], duplicate: true };
  const filename = cleanFilename(file.name, kind.mime);
  let row: RowData;
  try {
    row = await controlDb().siteMedia.create({
      data: { filename, mime: kind.mime, size: bytes.length, width: kind.width, height: kind.height, alt, data: bytes, sha256, createdBy: actorRef(actor) },
      select: ROW_SELECT,
    });
  } catch (err) {
    // The same image uploaded twice at once: the other upload made it.
    const again = await controlDb().siteMedia.findUnique({ where: { sha256 }, select: ROW_SELECT });
    if (again) return { ...(await toRows([again]))[0], duplicate: true };
    throw err;
  }
  await cmsAudit(actor, "media.upload", "media", row.id, { filename, mime: kind.mime, size: bytes.length });
  return { ...(await toRows([row]))[0], duplicate: false };
}

/** The library, newest first, searched by filename or alt text. Never the bytes. */
export async function listMedia(filters: { q?: string; page?: number; needsAlt?: boolean } = {}): Promise<Paged<MediaRow>> {
  const page = Math.max(1, Math.floor(Number(filters.page) || 1));
  const q = typeof filters.q === "string" ? filters.q.trim().slice(0, 100) : "";
  const where: Prisma.SiteMediaWhereInput = {
    ...(q ? { OR: [{ filename: { contains: q, mode: "insensitive" } }, { alt: { contains: q, mode: "insensitive" } }] } : {}),
    ...(filters.needsAlt ? { alt: "" } : {}),
  };
  const [rows, total] = await Promise.all([
    controlDb().siteMedia.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE, select: ROW_SELECT }),
    controlDb().siteMedia.count({ where }),
  ]);
  return { rows: await toRows(rows), total, page, pageSize: PAGE_SIZE };
}

/** Several by id, in no particular order — for an editor showing the images a document uses. */
export async function getMediaRows(ids: string[]): Promise<MediaRow[]> {
  const wanted = [...new Set(ids.filter((id) => MEDIA_ID.test(String(id))))].slice(0, 200);
  if (!wanted.length) return [];
  return toRows(await controlDb().siteMedia.findMany({ where: { id: { in: wanted } }, select: ROW_SELECT }));
}

export async function getMedia(id: string): Promise<MediaRow | null> {
  return (await getMediaRows([id]))[0] ?? null;
}

export async function updateMediaAlt(id: string, altInput: unknown, actor: CmsActor): Promise<MediaRow> {
  if (!MEDIA_ID.test(String(id))) throw new CmsRefused("That image no longer exists.");
  const alt = cleanAlt(altInput);
  const row = await controlDb().siteMedia.update({ where: { id }, data: { alt }, select: ROW_SELECT });
  await cmsAudit(actor, "media.alt", "media", id, { filename: row.filename, empty: !alt });
  return (await toRows([row]))[0];
}

/** Where an image is used: pages, posts and the site's settings, draft and published — and categories' and tags' sharing images. */
export async function mediaUsage(id: string): Promise<MediaUsage[]> {
  if (!MEDIA_ID.test(String(id))) return [];
  const like = `%"/media/${id}"%`;
  const [pages, posts, settings, categories, tags] = await Promise.all([
    controlDb().$queryRaw<{ id: string; slug: string; title: string; inDraft: boolean; inPublished: boolean }[]>`
      SELECT id, slug, title, (draft::text LIKE ${like}) AS "inDraft", (coalesce(published::text, '') LIKE ${like}) AS "inPublished"
      FROM site_pages WHERE draft::text LIKE ${like} OR coalesce(published::text, '') LIKE ${like}`,
    controlDb().$queryRaw<{ id: string; slug: string; title: string; status: string }[]>`
      SELECT id, slug, title, status::text AS status FROM site_posts
      WHERE "coverMediaId" = ${id} OR body::text LIKE ${like} OR coalesce(seo::text, '') LIKE ${like}`,
    controlDb().$queryRaw<{ inDraft: boolean; inPublished: boolean }[]>`
      SELECT (draft::text LIKE ${like}) AS "inDraft", (coalesce(published::text, '') LIKE ${like}) AS "inPublished"
      FROM site_settings WHERE key = 'site' AND (draft::text LIKE ${like} OR coalesce(published::text, '') LIKE ${like})`,
    controlDb().siteCategory.findMany({ where: { seo: { path: ["imageMediaId"], equals: id } }, select: { id: true, name: true } }),
    controlDb().siteTag.findMany({ where: { seo: { path: ["imageMediaId"], equals: id } }, select: { id: true, name: true } }),
  ]);
  const out: MediaUsage[] = [];
  for (const p of pages) {
    if (p.inPublished) out.push({ kind: "page", id: p.id, title: p.title, href: `/pages/${p.id}`, where: "published" });
    else if (p.inDraft) out.push({ kind: "page", id: p.id, title: p.title, href: `/pages/${p.id}`, where: "draft" });
  }
  for (const p of posts) out.push({ kind: "post", id: p.id, title: p.title, href: `/posts/${p.id}`, where: p.status === "DRAFT" ? "draft" : "published" });
  for (const s of settings) out.push({ kind: "settings", id: "site", title: "Site settings", href: "/settings", where: s.inPublished ? "published" : "draft" });
  for (const c of categories) out.push({ kind: "category", id: c.id, title: c.name, href: "/categories", where: "published" });
  for (const t of tags) out.push({ kind: "tag", id: t.id, title: t.name, href: "/tags", where: "published" });
  return out;
}

export async function deleteMedia(id: string, actor: CmsActor): Promise<void> {
  if (!MEDIA_ID.test(String(id))) throw new CmsRefused("That image no longer exists.");
  const row = await controlDb().siteMedia.findUnique({ where: { id }, select: { id: true, filename: true } });
  if (!row) throw new CmsRefused("That image no longer exists.");
  const usage = await mediaUsage(id);
  if (usage.length) {
    const places = usage.slice(0, 5).map((u) => `${u.kind === "settings" ? "the site settings" : `the ${u.kind} "${u.title}"`} (${u.where})`);
    throw new CmsRefused(`This image is in use — ${places.join(", ")}${usage.length > 5 ? ` and ${usage.length - 5} more` : ""}. Take it out of those first.`);
  }
  await controlDb().siteMedia.delete({ where: { id } });
  await cmsAudit(actor, "media.delete", "media", id, { filename: row.filename });
}

// ─── For the rest of the CMS, and the public route ───────────────────────────────────────────────

/** Which of these ids are not in the library. */
export async function missingMediaIds(ids: Iterable<string>): Promise<string[]> {
  const wanted = [...new Set(ids)];
  if (!wanted.length) return [];
  const found = await controlDb().siteMedia.findMany({ where: { id: { in: wanted } }, select: { id: true } });
  const have = new Set(found.map((f) => f.id));
  return wanted.filter((id) => !have.has(id));
}

/** Which of these have no alt text yet. */
export async function mediaWithoutAlt(ids: Iterable<string>): Promise<{ id: string; filename: string }[]> {
  const wanted = [...new Set(ids)];
  if (!wanted.length) return [];
  return controlDb().siteMedia.findMany({ where: { id: { in: wanted }, alt: "" }, select: { id: true, filename: true } });
}

/** The bytes for the public route. */
export async function mediaFile(id: string): Promise<{ data: Uint8Array; mime: string; size: number; sha256: string } | null> {
  if (!MEDIA_ID.test(id)) return null;
  return controlDb().siteMedia.findUnique({ where: { id }, select: { data: true, mime: true, size: true, sha256: true } });
}

import { timingSafeEqual } from "node:crypto";
import type { SiteBlock, SitePage } from "@/components/site/blocks/types";
import { DEFAULT_SITE_PAGES } from "@/components/site/defaults";
import { platformHmac, platformKeyConfigured, type SignPurpose } from "@/lib/platform/kek";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { siteOrigin, type SitePost, type SitePostSeo } from "@/lib/platform/site-content";

/**
 * A draft's preview on the public site: /preview/<token> (src/app/platform-site/preview/[token]).
 *
 * The token is minted in the CMS, for a signed-in CMS user, and is the only thing that opens a draft to
 * a browser without a CMS session — so it carries its own proof:
 *
 *   · what it is for — a page or a post, by id — and the draft's `updatedAt` when it was minted: a
 *     draft saved since then is a different draft, and the old token is refused ("stale");
 *   · a 15-minute expiry;
 *   · an HMAC under a key derived from the platform key for this purpose alone (kek.ts platformHmac),
 *     so nobody without PLATFORM_MASTER_KEY can make one, and a token for one draft opens no other.
 *
 * The page it opens is `noindex`, `no-store`, and says "Preview — not published" at the top.
 */

export const PREVIEW_TTL_MS = 15 * 60_000;
export type PreviewKind = "page" | "post";
type Claims = { k: PreviewKind; i: string; u: number; e: number };

/** kek.ts's SignPurpose union does not list this one yet; the name is what separates the keys. */
const PURPOSE: SignPurpose = "cms-preview";
const sign = (payload: string) => platformHmac("cms", PURPOSE).update(payload).digest();

/** A token for this draft as it is now — `updatedAt` is its last save (0 for a built-in page never saved). */
export function mintPreviewToken(kind: PreviewKind, id: string, updatedAt: Date | null, now = Date.now()): string {
  const claims: Claims = { k: kind, i: id, u: updatedAt ? updatedAt.getTime() : 0, e: now + PREVIEW_TTL_MS };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${sign(payload).toString("base64url")}`;
}

export function previewUrl(token: string): string {
  return `${siteOrigin()}/preview/${token}`;
}

export type PreviewRefusal = "invalid" | "expired" | "stale" | "gone";

/** The token's claims when its signature is good and it has not expired. */
export function readPreviewToken(token: string, now = Date.now()): { ok: true; claims: Claims } | { ok: false; reason: "invalid" | "expired" } {
  if (!platformKeyConfigured() || typeof token !== "string" || token.length > 600) return { ok: false, reason: "invalid" };
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return { ok: false, reason: "invalid" };
  const given = Buffer.from(signature, "base64url");
  const expected = sign(payload);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "invalid" };
  let claims: Claims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Claims;
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if ((claims.k !== "page" && claims.k !== "post") || typeof claims.i !== "string" || typeof claims.u !== "number" || typeof claims.e !== "number") return { ok: false, reason: "invalid" };
  if (claims.e <= now) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}

export type PreviewContent =
  | { ok: true; kind: "page"; page: SitePage; expiresAt: Date }
  | { ok: true; kind: "post"; post: SitePost; expiresAt: Date }
  | { ok: false; reason: PreviewRefusal };

/** What a preview token opens: the draft exactly as it was when the token was minted, or why not. */
export async function loadPreview(token: string, now = Date.now()): Promise<PreviewContent> {
  const read = readPreviewToken(token, now);
  if (!read.ok) return read;
  const { k, i, u, e } = read.claims;
  const expiresAt = new Date(e);
  if (!controlConfigured()) return { ok: false, reason: "gone" };

  if (k === "page") {
    const builtin = /^builtin-([a-z]+)$/.exec(i)?.[1];
    const row = builtin
      ? await controlDb().sitePage.findUnique({ where: { slug: builtin }, select: { slug: true, draft: true, updatedAt: true } })
      : await controlDb().sitePage.findUnique({ where: { id: i }, select: { slug: true, draft: true, updatedAt: true } });
    if (!row) {
      // A built-in page never saved: its default content, for as long as nobody saves it.
      const fallback = builtin ? DEFAULT_SITE_PAGES.find((p) => p.slug === builtin) : null;
      if (fallback && u === 0) return { ok: true, kind: "page", page: fallback, expiresAt };
      return { ok: false, reason: "gone" };
    }
    if (row.updatedAt.getTime() !== u) return { ok: false, reason: "stale" };
    const doc = row.draft as { title?: string; seo?: SitePage["seo"]; blocks?: SiteBlock[] };
    return { ok: true, kind: "page", page: { slug: row.slug, title: String(doc.title ?? ""), seo: doc.seo ?? { title: "", description: "" }, blocks: Array.isArray(doc.blocks) ? doc.blocks : [] }, expiresAt };
  }

  const post = await controlDb().sitePost.findUnique({
    where: { id: i },
    select: { slug: true, title: true, excerpt: true, coverMediaId: true, tags: true, body: true, seo: true, publishAt: true, updatedAt: true, author: { select: { name: true } } },
  });
  if (!post) return { ok: false, reason: "gone" };
  if (post.updatedAt.getTime() !== u) return { ok: false, reason: "stale" };
  const cover = post.coverMediaId ? await controlDb().siteMedia.findUnique({ where: { id: post.coverMediaId }, select: { id: true, alt: true, width: true, height: true } }) : null;
  return {
    ok: true,
    kind: "post",
    post: {
      slug: post.slug,
      path: `/blog/${post.slug}`,
      title: post.title,
      excerpt: post.excerpt,
      cover: cover ? { src: `/media/${cover.id}`, alt: cover.alt, width: cover.width, height: cover.height } : null,
      tags: post.tags,
      publishedAt: post.publishAt ?? new Date(now),
      author: post.author.name,
      body: Array.isArray(post.body) ? (post.body as unknown as SiteBlock[]) : [],
      seo: (post.seo as SitePostSeo | null) ?? null,
      updatedAt: post.updatedAt,
    },
    expiresAt,
  };
}

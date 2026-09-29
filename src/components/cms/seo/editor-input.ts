import { slugify } from "@/lib/cms/validate";
import { TERM_SLUG_MAX, type CmsTermRef, type PageDocument, type PageStatus, type PostInput, type SeoEditorContext, type SitePostStatus, type TermSeo } from "@/lib/cms/types";
import { inputFromArchive, inputFromPage, inputFromPost, seoStatusOf, type SeoImage, type SeoInput } from "@/lib/seo";

/**
 * What the editors score live: the draft being typed, turned into the engine's `SeoInput` with the
 * engine's own builders (src/lib/seo/extract.ts), around the site the editor loaded once
 * (`cmsSeoEditorContext`). The same builders the score cache uses (src/lib/cms/seo-scores.ts), fed
 * the same fields — so a draft that equals what is saved scores exactly what the dashboard shows
 * (check:cms holds the two inputs equal). No scoring here and no clock: `now` is passed in.
 *
 * Pure and client-safe.
 */

/** A library image as the engine reads one, from whichever row the editor has for it. */
export function libraryImage(id: string | null | undefined, ...sources: Record<string, { alt: string; width: number | null; height: number | null } | undefined>[]): SeoImage | null {
  if (!id) return null;
  for (const source of sources) {
    const m = source[id];
    if (m) return { src: `/media/${id}`, alt: m.alt, width: m.width, height: m.height };
  }
  return null;
}

// ─── Pages ───────────────────────────────────────────────────────────────────────────────────────

export type PageDraftSource = {
  /** The page's id — "builtin-<slug>" for a built-in page never saved. */
  id: string;
  slug: string;
  status: PageStatus;
  builtin: boolean;
  doc: PageDocument;
};

/** The page editor's draft, as the checks read it (the home page included). */
export function pageDraftInput(src: PageDraftSource, ctx: SeoEditorContext, now: Date): SeoInput {
  return inputFromPage({ id: src.id, slug: src.slug, title: src.doc.title, seo: src.doc.seo, blocks: src.doc.blocks, status: seoStatusOf(src.status), isBuiltin: src.builtin }, ctx.site, now);
}

// ─── Posts ───────────────────────────────────────────────────────────────────────────────────────

export type PostDraftSource = {
  id: string;
  doc: PostInput;
  status: SitePostStatus;
  /** When it went, or goes, live. */
  publishAt: Date | null;
  /** When it was last saved. */
  updatedAt: Date | null;
  /** The author's name, as the site shows it. */
  author: string;
  /** Its categories as saved, the main one first — for a draft that leaves `categories` out. */
  savedCategories: CmsTermRef[];
  /** Every category the editor knows, by id. */
  categories: Record<string, { slug: string; name: string }>;
  /** Tag names by address, as the editor has learnt them. */
  tagNames: Record<string, string>;
  /** Library rows the editor holds (picked since it opened), then the context's: for the cover's alt text and size. */
  media: Record<string, { alt: string; width: number | null; height: number | null }>;
};

/** A tag as the editor holds it — an address, or a new tag's name — as the site will link it. */
function tagLink(tag: string, names: Record<string, string>): { slug: string; name: string; path: string } | null {
  const t = tag.trim();
  if (!t) return null;
  if (names[t]) return { slug: t, name: names[t], path: `/blog/tag/${t}` };
  const lower = t.toLowerCase();
  const known = Object.entries(names).find(([, name]) => name.toLowerCase() === lower);
  const slug = known ? known[0] : slugify(t, TERM_SLUG_MAX);
  if (!slug) return null;
  return { slug, name: known ? known[1] : t, path: `/blog/tag/${slug}` };
}

/** The post editor's draft, as the checks read it: its header (title, excerpt, cover), its body, its categories and tags. */
export function postDraftInput(src: PostDraftSource, ctx: SeoEditorContext, now: Date): SeoInput {
  const doc = src.doc;
  const categoryIds = doc.categories ?? src.savedCategories.map((c) => c.id);
  const categories = categoryIds.flatMap((id) => {
    const c = src.categories[id];
    return c ? [{ slug: c.slug, name: c.name, path: `/blog/category/${c.slug}` }] : [];
  });
  const seen = new Set<string>();
  const tagLinks = doc.tags
    .map((t) => tagLink(t, src.tagNames))
    .filter((t): t is NonNullable<typeof t> => !!t && !seen.has(t.slug) && !!seen.add(t.slug))
    .sort((a, b) => a.name.localeCompare(b.name));
  return inputFromPost(
    {
      id: src.id,
      slug: doc.slug,
      title: doc.title,
      excerpt: doc.excerpt,
      cover: libraryImage(doc.coverMediaId, src.media, ctx.media),
      body: doc.body,
      seo: doc.seo,
      author: src.author,
      publishedAt: src.publishAt,
      updatedAt: src.updatedAt,
      categories,
      tagLinks,
      status: seoStatusOf(src.status),
    },
    ctx.site,
    now,
  );
}

// ─── Categories and tags ─────────────────────────────────────────────────────────────────────────

export type TermDraftSource = {
  kind: "category" | "tag";
  id: string;
  slug: string;
  name: string;
  /** Its own description, as it would be saved (trimmed; null when blank). */
  description: string | null;
  /** Its search and sharing details, as they would be saved. */
  seo: TermSeo | null;
  /** Library rows the dialog holds (an image picked since it opened), then the context's: for the sharing image's alt text and size. */
  media: Record<string, { alt: string; width: number | null; height: number | null }>;
  /** Its parent category for the breadcrumb — "as-saved" while the dialog hasn't changed it. */
  parent: { name: string; path: string } | null | "as-saved";
};

/** A category's or tag's archive (its first page, as the site shows it now), with the dialog's draft. */
export function termDraftInput(src: TermDraftSource, ctx: SeoEditorContext, now: Date): SeoInput {
  const archive = ctx.archive;
  const image = libraryImage(src.seo?.imageMediaId, src.media, ctx.media);
  return inputFromArchive(
    {
      kind: src.kind,
      id: src.id,
      slug: src.slug,
      name: src.name,
      description: src.description,
      seo: src.seo,
      image: image ? { src: image.src, alt: image.alt, width: image.width ?? null, height: image.height ?? null } : null,
      posts: archive?.posts ?? [],
      total: archive?.total ?? 0,
      page: 1,
      pages: archive?.pages ?? 1,
      parent: src.kind !== "category" ? null : src.parent === "as-saved" ? (archive?.parent ?? null) : src.parent,
    },
    ctx.site,
    now,
  );
}

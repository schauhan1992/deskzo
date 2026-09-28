import type { BlockType, SiteBlock } from "@/components/site/blocks/types";
import { BLOCK_INFO } from "@/components/cms/editor/catalog";
import { POST_BLOCK_TYPES, type CmsIssue, type MediaRow, type PageDocument, type PostInput } from "@/lib/cms/types";
import { checkPageDocument, checkPostBody, checkPostSeo, mediaIdsIn, mediaIssues, POST_SLUG, stableJson } from "@/lib/cms/validate";

/**
 * The browser's half of the checks the server makes (src/lib/cms/content.ts), run on the document as
 * it is typed, so problems show next to their fields before anyone presses Save or Publish. The same
 * validator the server uses (src/lib/cms/validate.ts), plus what it checks against the database —
 * images without alt text — from the library rows the editor already has.
 */

/** Every image in `value` whose library row has no alt text yet, as an issue where it is used. */
export function altIssues(value: unknown, media: Record<string, MediaRow>): CmsIssue[] {
  const ids = [...mediaIdsIn(value)].filter((id) => media[id]?.needsAlt);
  if (!ids.length) return [];
  return mediaIssues(value, new Set(ids), (id) => `“${media[id]?.filename ?? "This image"}” has no alt text yet — add it in the media library.`);
}

/** What would stop this page from being published. */
export function pagePublishIssues(doc: PageDocument, media: Record<string, MediaRow>, requiredBlock: BlockType | null): CmsIssue[] {
  const checked = checkPageDocument(doc, "publish");
  const out: CmsIssue[] = checked.ok ? [] : [...checked.issues];
  if (requiredBlock && !doc.blocks.some((b) => b.type === requiredBlock)) {
    out.push({ path: "blocks", message: `Keep the ${BLOCK_INFO[requiredBlock].label} block — this page exists for it. Add it back, or reset the page to its default.` });
  }
  out.push(...altIssues(doc, media));
  return out;
}

/** The page as the site would store it once published — for "changed since publish". */
export function publishedPrint(doc: PageDocument): string {
  const checked = checkPageDocument(doc, "publish");
  return checked.ok ? stableJson(checked.value) : `unpublishable:${stableJson(doc)}`;
}

export function publishNormalised(doc: PageDocument): PageDocument | null {
  const checked = checkPageDocument(doc, "publish");
  return checked.ok ? checked.value : null;
}

const TAG = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** A post's own fields, checked as the server does (title, address, excerpt, tags, body, SEO). */
export function postIssues(post: PostInput, mode: "draft" | "publish", media: Record<string, MediaRow>): CmsIssue[] {
  const out: CmsIssue[] = [];
  const title = post.title.trim();
  if (!title) out.push({ path: "title", message: "Give the post a title." });
  else if (title.length > 200) out.push({ path: "title", message: "Keep the title to 200 characters." });
  const slug = post.slug.trim().toLowerCase();
  if (!POST_SLUG.test(slug) || slug.length > 120) out.push({ path: "slug", message: "Use lower-case words and hyphens, like spring-update." });
  if ((post.excerpt ?? "").trim().length > 500) out.push({ path: "excerpt", message: "Keep the excerpt to 500 characters." });
  post.tags.forEach((tag, i) => {
    if (!TAG.test(tag)) out.push({ path: `tags[${i}]`, message: "A tag is lower-case letters, digits and hyphens (at most 32)." });
  });
  if (post.tags.length > 10) out.push({ path: "tags", message: "At most ten tags." });
  const body = checkPostBody(post.body, mode, POST_BLOCK_TYPES);
  if (!body.ok) out.push(...body.issues);
  if (mode === "publish" && body.ok && body.value.length === 0) out.push({ path: "body", message: "Write something first." });
  const seo = checkPostSeo(post.seo);
  if (!seo.ok) out.push(...seo.issues);
  if (mode === "publish") {
    if (post.coverMediaId && media[post.coverMediaId]?.needsAlt) out.push({ path: "coverMediaId", message: "The cover has no alt text yet — add it in the media library." });
    out.push(...altIssues({ body: post.body, seo: post.seo }, media));
  }
  return out;
}

/** Blocks that a page's main title comes from — a page should have one. */
export function pageTopCount(blocks: SiteBlock[]): number {
  return blocks.filter((b) => BLOCK_INFO[b.type]?.pageTop).length;
}

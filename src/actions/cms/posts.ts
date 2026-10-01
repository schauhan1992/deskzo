"use server";

import type { SitePostStatus } from "@deskzo/control-client";
import { archivePost, createPost, deletePost, getPost, listPostTags, listPosts, postPreviewLink, publishPost, savePost, unarchivePost, unpublishPost } from "@/lib/cms/content";
import { cmsAction, revalidateCms } from "@/lib/cms/guard";
import { CMS_EVERYONE, CMS_PUBLISHERS, CMS_WRITERS, type CmsResult, type Paged, type PostDetail, type PostInput, type PostListRow, type PostSaved, type RedirectRow } from "@/lib/cms/types";

/**
 * Blog and news posts. A post has one body: saving a live one changes the site at once (and is
 * checked as fully as publishing). Authors create posts and change only their own drafts; editors and
 * admins publish, schedule, unpublish and change anybody's. src/lib/cms/content.ts does the work.
 *
 *   cmsListPosts        everybody    filtered (status, tag and category slugs, author, q, archived), 30 a page
 *   cmsPostTags         everybody    every tag's slug (names and counts: cmsListTags / cmsSearchTags)
 *   cmsCreatePost       writers      a new draft (title, optional slug), authored by the caller
 *   cmsGetPost          everybody
 *   cmsSavePost         writers      every field; `conflict` over a newer save unless `force`; tags by slug or name
 *                                    (new ones added), categories by id; a live post's new slug leaves a 301 (`redirect`)
 *   cmsPublishPost      publishers   now, or scheduled: `publishAt` ("yyyy-mm-ddThh:mm" India time, or ISO)
 *   cmsUnpublishPost    publishers
 *   cmsArchivePost / cmsUnarchivePost / cmsDeletePost   writers (authors: their own drafts); delete needs archive first,
 *                                    and may send the old address on: { redirectTo } ("" for /blog; editors and admins)
 *   cmsPostPreviewLink  everybody    a 15-minute link to the post as it is now, on the public site
 */

const pid = (value: unknown) => String(value ?? "").slice(0, 40);

export async function cmsListPosts(
  filters: { status?: SitePostStatus; tag?: string; category?: string; authorId?: string; q?: string; archived?: boolean; page?: number } = {},
): Promise<CmsResult<Paged<PostListRow>>> {
  return cmsAction(CMS_EVERYONE, async () => listPosts(filters ?? {}));
}

export async function cmsPostTags(): Promise<CmsResult<string[]>> {
  return cmsAction(CMS_EVERYONE, async () => listPostTags());
}

export async function cmsCreatePost(input: { title: string; slug?: string }): Promise<CmsResult<PostDetail>> {
  return cmsAction(CMS_WRITERS, async ({ user }) => {
    const post = await createPost({ title: String(input?.title ?? ""), slug: input?.slug ? String(input.slug) : undefined }, user);
    revalidateCms();
    return post;
  });
}

export async function cmsGetPost(postId: string): Promise<CmsResult<PostDetail>> {
  return cmsAction(CMS_EVERYONE, async () => getPost(pid(postId)));
}

export async function cmsSavePost(postId: string, input: { post: PostInput; version: string; force?: boolean }): Promise<CmsResult<PostSaved>> {
  return cmsAction(CMS_WRITERS, async ({ user }) => {
    const saved = await savePost(pid(postId), { post: input?.post, version: String(input?.version ?? ""), force: input?.force === true }, user);
    revalidateCms();
    return saved;
  });
}

export async function cmsPublishPost(postId: string, input: { publishAt?: string | null; version?: string; force?: boolean } = {}): Promise<CmsResult<PostSaved>> {
  return cmsAction(CMS_PUBLISHERS, async ({ user }) => {
    const saved = await publishPost(pid(postId), { publishAt: input?.publishAt ? String(input.publishAt) : null, version: input?.version ? String(input.version) : undefined, force: input?.force === true }, user);
    revalidateCms();
    return saved;
  });
}

export async function cmsUnpublishPost(postId: string): Promise<CmsResult<PostSaved>> {
  return cmsAction(CMS_PUBLISHERS, async ({ user }) => {
    const saved = await unpublishPost(pid(postId), user);
    revalidateCms();
    return saved;
  });
}

export async function cmsArchivePost(postId: string): Promise<CmsResult<null>> {
  return cmsAction(CMS_WRITERS, async ({ user }) => {
    await archivePost(pid(postId), user);
    revalidateCms();
    return null;
  });
}

export async function cmsUnarchivePost(postId: string): Promise<CmsResult<null>> {
  return cmsAction(CMS_WRITERS, async ({ user }) => {
    await unarchivePost(pid(postId), user);
    revalidateCms();
    return null;
  });
}

export async function cmsDeletePost(postId: string, options: { redirectTo?: string | null } = {}): Promise<CmsResult<{ redirect: RedirectRow | null }>> {
  return cmsAction(CMS_WRITERS, async ({ user }) => {
    const redirectTo = options?.redirectTo === undefined || options?.redirectTo === null ? null : String(options.redirectTo).slice(0, 2000);
    const deleted = await deletePost(pid(postId), user, { redirectTo });
    revalidateCms();
    return deleted;
  });
}

export async function cmsPostPreviewLink(postId: string): Promise<CmsResult<{ url: string; expiresAt: Date }>> {
  return cmsAction(CMS_EVERYONE, async ({ user }) => postPreviewLink(pid(postId), user));
}

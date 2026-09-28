"use server";

import { cmsAction, revalidateCms } from "@/lib/cms/guard";
import { createTag, deleteTag, getTag, listTags, mergeTags, searchTags, updateTag } from "@/lib/cms/taxonomy";
import { CMS_EVERYONE, CMS_PUBLISHERS, CMS_WRITERS, type AutoRedirect, type CmsResult, type CmsTermRef, type Paged, type TagInput, type TagRow } from "@/lib/cms/types";

/**
 * Blog tags. Any writer adds one (here, or by naming it in a post's tags); only editors and admins
 * rename, merge or delete them. src/lib/cms/taxonomy.ts does the work and writes the activity log
 * (tag.create / update / merge / delete).
 *
 *   cmsListTags     everybody    { q?, page? } — by name, 50 a page, with post counts
 *   cmsSearchTags   everybody    the post editor's token input: up to `limit` (20) tags matching `q`
 *   cmsGetTag       everybody
 *   cmsCreateTag    writers      { name, slug?, description?, seo? } — a blank slug is made from the name
 *   cmsUpdateTag    publishers   only the fields given; a new slug of an archive with live posts leaves a 301 (`redirect`)
 *   cmsMergeTags    publishers   the source's posts get the target; the source goes; a 301 from its archive to the target's
 *   cmsDeleteTag    publishers   its posts lose it
 */

const tid = (value: unknown) => String(value ?? "").slice(0, 40);

export async function cmsListTags(filters: { q?: string; page?: number } = {}): Promise<CmsResult<Paged<TagRow>>> {
  return cmsAction(CMS_EVERYONE, async () => listTags({ q: typeof filters?.q === "string" ? filters.q : undefined, page: Number(filters?.page) || 1 }));
}

export async function cmsSearchTags(q: string, limit = 20): Promise<CmsResult<CmsTermRef[]>> {
  return cmsAction(CMS_EVERYONE, async () => searchTags(String(q ?? ""), Number(limit) || 20));
}

export async function cmsGetTag(tagId: string): Promise<CmsResult<TagRow>> {
  return cmsAction(CMS_EVERYONE, async () => getTag(tid(tagId)));
}

export async function cmsCreateTag(input: TagInput): Promise<CmsResult<TagRow>> {
  return cmsAction(CMS_WRITERS, async ({ user }) => {
    const row = await createTag(input ?? { name: "" }, user);
    revalidateCms();
    return row;
  });
}

export async function cmsUpdateTag(tagId: string, input: Partial<TagInput>): Promise<CmsResult<TagRow & { redirect: AutoRedirect | null }>> {
  return cmsAction(CMS_PUBLISHERS, async ({ user }) => {
    const row = await updateTag(tid(tagId), input ?? {}, user);
    revalidateCms();
    return row;
  });
}

export async function cmsMergeTags(sourceId: string, targetId: string): Promise<CmsResult<{ tag: TagRow; moved: number; redirect: AutoRedirect | null }>> {
  return cmsAction(CMS_PUBLISHERS, async ({ user }) => {
    const merged = await mergeTags(tid(sourceId), tid(targetId), user);
    revalidateCms();
    return merged;
  });
}

export async function cmsDeleteTag(tagId: string): Promise<CmsResult<null>> {
  return cmsAction(CMS_PUBLISHERS, async ({ user }) => {
    await deleteTag(tid(tagId), user);
    revalidateCms();
    return null;
  });
}

"use server";

import { cmsAction, revalidateCms } from "@/lib/cms/guard";
import { createCategory, deleteCategory, getCategory, listCategories, reorderCategories, updateCategory } from "@/lib/cms/taxonomy";
import { CMS_EVERYONE, CMS_PUBLISHERS, type AutoRedirect, type CategoryInput, type CategoryNode, type CategoryRow, type CmsResult } from "@/lib/cms/types";

/**
 * Blog categories: a curated list, nested one level (a parent, then its children). Everybody reads
 * them (the post editor's picker); editors and admins change them. src/lib/cms/taxonomy.ts does the
 * work and writes the activity log (category.create / update / delete).
 *
 *   cmsListCategories     everybody    the tree: top-level by position, each with its children; post counts
 *   cmsGetCategory        everybody
 *   cmsCreateCategory     publishers   { name, slug?, description?, parentId?, seo? } — a blank slug is made from the name
 *   cmsUpdateCategory     publishers   only the fields given; a new slug of an archive with live posts leaves a 301 (`redirect`)
 *   cmsDeleteCategory     publishers   refused while it has subcategories; its posts lose it
 *   cmsReorderCategories  publishers   one parent's children (null: the top level), every one, in their new order
 */

const cid = (value: unknown) => String(value ?? "").slice(0, 40);

export async function cmsListCategories(): Promise<CmsResult<CategoryNode[]>> {
  return cmsAction(CMS_EVERYONE, async () => listCategories());
}

export async function cmsGetCategory(categoryId: string): Promise<CmsResult<CategoryRow>> {
  return cmsAction(CMS_EVERYONE, async () => getCategory(cid(categoryId)));
}

export async function cmsCreateCategory(input: CategoryInput): Promise<CmsResult<CategoryRow>> {
  return cmsAction(CMS_PUBLISHERS, async ({ user }) => {
    const row = await createCategory(input ?? { name: "" }, user);
    revalidateCms();
    return row;
  });
}

export async function cmsUpdateCategory(categoryId: string, input: Partial<CategoryInput>): Promise<CmsResult<CategoryRow & { redirect: AutoRedirect | null }>> {
  return cmsAction(CMS_PUBLISHERS, async ({ user }) => {
    const row = await updateCategory(cid(categoryId), input ?? {}, user);
    revalidateCms();
    return row;
  });
}

export async function cmsDeleteCategory(categoryId: string): Promise<CmsResult<null>> {
  return cmsAction(CMS_PUBLISHERS, async ({ user }) => {
    await deleteCategory(cid(categoryId), user);
    revalidateCms();
    return null;
  });
}

export async function cmsReorderCategories(parentId: string | null, orderedIds: string[]): Promise<CmsResult<CategoryNode[]>> {
  return cmsAction(CMS_PUBLISHERS, async ({ user }) => {
    const tree = await reorderCategories(parentId ? cid(parentId) : null, Array.isArray(orderedIds) ? orderedIds.slice(0, 500).map(cid) : [], user);
    revalidateCms();
    return tree;
  });
}

import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/custom-fields/server";
import { cleanName } from "@/lib/items/catalogue-import";

/**
 * The workspace's item categories (Items › Categories): what the item form offers, and what an item's
 * category has to be one of.
 *
 * An item holds its category by name, as the list spells it (`Item.category`). Names compare without
 * case or runs of spaces — "laptops" and " Laptops " are one category — so every match here is
 * case-blind and every stored name is the list's own spelling.
 *
 * A workspace whose database doesn't have the list yet (not migrated) reads as having no categories,
 * and keeps its free-text ones until it is.
 */

export type CategoryOption = { id: string; name: string };

/** Every category, by name. */
export async function itemCategories(): Promise<CategoryOption[]> {
  try {
    return await db.itemCategory.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } });
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

/** The category the list calls this name, ignoring case and spacing — or null when it isn't on the list. */
export async function listedCategory(name: string, exceptId?: string): Promise<CategoryOption | null> {
  const clean = cleanName(name);
  if (!clean) return null;
  try {
    return await db.itemCategory.findFirst({
      where: { name: { equals: clean, mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true, name: true },
    });
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

/** Whether this workspace keeps the list yet — a database from before it holds free text instead. */
export async function categoryListReady(): Promise<boolean> {
  try {
    await db.itemCategory.findFirst({ select: { id: true } });
    return true;
  } catch (err) {
    if (notMigratedYet(err)) return false;
    throw err;
  }
}

export const categoryNotListed = (name: string) =>
  `"${cleanName(name)}" isn't one of your item categories — pick one from the list, or add it under Items › Categories.`;

/**
 * The category an item may be saved with: blank for none, else the list's spelling of it. Before the
 * list exists in this workspace, the name as typed — as it always was.
 */
export async function categoryForItem(name: string | null | undefined): Promise<{ ok: true; name: string | null } | { ok: false; error: string }> {
  const clean = cleanName(name ?? "");
  if (!clean) return { ok: true, name: null };
  if (!(await categoryListReady())) return { ok: true, name: clean };
  const listed = await listedCategory(clean);
  return listed ? { ok: true, name: listed.name } : { ok: false, error: categoryNotListed(clean) };
}

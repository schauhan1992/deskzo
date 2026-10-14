"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { cleanName } from "@/lib/items/catalogue-import";
import { itemCategories, listedCategory } from "@/lib/items/categories";
import type { ActionResult } from "@/actions/company";

/**
 * Items › Categories: the list an item's category is picked from.
 *
 * Everybody who uses items can read it; changing it is `catalog.manage`, as for brands. An item holds
 * its category by name (src/lib/items/categories.ts), so a rename rewrites it on every item in the same
 * transaction, and a category still in use can't be deleted — the items would be left naming nothing.
 */

const NOT_A_MANAGER = "You can't manage the product catalog.";

async function manager(): Promise<{ id: string } | null> {
  const user = await requireModuleUser("items");
  return (await hasEffectivePermission(user.id, "catalog.manage")) ? user : null;
}

/** A name worth keeping: trimmed, spaces collapsed, and something left. */
function nameFrom(input: unknown): { ok: true; name: string } | { ok: false; error: string } {
  const name = cleanName(typeof input === "string" ? input : "");
  if (!name) return { ok: false, error: "Give the category a name." };
  if (name.length > 80) return { ok: false, error: "Keep a category's name to 80 characters." };
  return { ok: true, name };
}

/** Every category, for the item form's picker, the items list's filter and its bulk edit. */
export async function listItemCategories() {
  await requireModuleUser("items");
  return itemCategories();
}

/** Every category with how many items are in it, for the Categories page. */
export async function listItemCategoriesWithCounts() {
  await requireModuleUser("items");
  const categories = await itemCategories();
  if (categories.length === 0) return [];
  const counts = await db.item.groupBy({ by: ["category"], where: { category: { in: categories.map((c) => c.name) } }, _count: { _all: true } });
  return categories.map((c) => ({ ...c, items: counts.find((n) => n.category === c.name)?._count._all ?? 0 }));
}

export async function createItemCategory(input: unknown): Promise<ActionResult<{ id: string; name: string }>> {
  const user = await manager();
  if (!user) return { ok: false, error: NOT_A_MANAGER };
  const named = nameFrom(input);
  if (!named.ok) return named;
  const clash = await listedCategory(named.name);
  if (clash) return { ok: false, error: `"${clash.name}" is already a category.` };
  try {
    const category = await db.itemCategory.create({ data: { name: named.name }, select: { id: true, name: true } });
    await recordAudit({ userId: user.id, action: "CREATE", entityType: "ItemCategory", entityId: category.id, entityLabel: category.name });
    revalidatePath("/items", "layout");
    return { ok: true, data: category };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { ok: false, error: `"${named.name}" is already a category.` };
    throw err;
  }
}

/** A new name for a category — and for every item in it, in one go. */
export async function renameItemCategory(id: string, input: unknown): Promise<ActionResult<{ id: string; name: string; items: number }>> {
  const user = await manager();
  if (!user) return { ok: false, error: NOT_A_MANAGER };
  const named = nameFrom(input);
  if (!named.ok) return named;
  const current = await db.itemCategory.findUnique({ where: { id: String(id ?? "") }, select: { id: true, name: true } });
  if (!current) return { ok: false, error: "That category no longer exists." };
  const clash = await listedCategory(named.name, current.id);
  if (clash) return { ok: false, error: `"${clash.name}" is already a category.` };
  try {
    const moved = await db.$transaction(async (tx) => {
      await tx.itemCategory.update({ where: { id: current.id }, data: { name: named.name } });
      return tx.item.updateMany({ where: { category: { equals: current.name, mode: "insensitive" } }, data: { category: named.name } });
    });
    await recordAudit({
      userId: user.id,
      action: "UPDATE",
      entityType: "ItemCategory",
      entityId: current.id,
      entityLabel: `${current.name} → ${named.name}${moved.count ? ` (${moved.count} item${moved.count === 1 ? "" : "s"})` : ""}`,
    });
    revalidatePath("/items", "layout");
    return { ok: true, data: { id: current.id, name: named.name, items: moved.count } };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { ok: false, error: `"${named.name}" is already a category.` };
    throw err;
  }
}

/** Only an empty category goes: items still in it are moved first, or they'd name nothing. */
export async function deleteItemCategory(id: string): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: NOT_A_MANAGER };
  const current = await db.itemCategory.findUnique({ where: { id: String(id ?? "") }, select: { id: true, name: true } });
  if (!current) return { ok: false, error: "That category no longer exists." };
  const inUse = await db.item.count({ where: { category: { equals: current.name, mode: "insensitive" } } });
  if (inUse > 0) {
    return { ok: false, error: `${inUse} item${inUse === 1 ? " is" : "s are"} still in ${current.name} — move ${inUse === 1 ? "it" : "them"} to another category first.` };
  }
  await db.itemCategory.delete({ where: { id: current.id } });
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "ItemCategory", entityId: current.id, entityLabel: current.name });
  revalidatePath("/items", "layout");
  return { ok: true, data: null };
}

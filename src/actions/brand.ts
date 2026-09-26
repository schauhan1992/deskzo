"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { createBrandSchema, updateBrandSchema, createProductFamilySchema, updateProductFamilySchema } from "@/lib/validation/brand";
import type { ActionResult } from "@/actions/company";
import { pageSlice } from "@/lib/pagination";
import { cleanName } from "@/lib/items/catalogue-import";

/**
 * The brand already called this, ignoring case — or null.
 *
 * The unique index is case-sensitive, so it let "microsoft" in beside "Microsoft", and the item
 * import (which matches names case-blind) would then have had two brands to choose between. The
 * rule is the import's rule: case and spacing do not make a different brand.
 */
async function brandNamed(name: string, exceptId?: string) {
  return db.brand.findFirst({
    where: { name: { equals: cleanName(name), mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { name: true },
  });
}

/** The same for a family, inside its brand. */
async function familyNamed(brandId: string, name: string, exceptId?: string) {
  return db.productFamily.findFirst({
    where: { brandId, name: { equals: cleanName(name), mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { name: true },
  });
}

/**
 * Every brand with its product families — names and ids only — for the item form's two linked
 * pickers, the items list's brand filter and its bulk edit.
 *
 * No item counts: with a thousand brands those are a thousand grouped counts nobody on those screens
 * reads. The Brands page, which does show them, pages through `listBrandsPaged` instead.
 */
export async function listBrands() {
  await requireModuleUser("items");
  return db.brand.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true, families: { orderBy: { name: "asc" }, select: { id: true, name: true } } },
  });
}

/**
 * One page of the catalogue's brands, for the Brands page.
 *
 * The search matches a family's name as well as a brand's — somebody looking for "AutoCAD" wants
 * Autodesk, and a thousand brands is too many to open one by one to find which one owns a line.
 */
export async function listBrandsPaged(params: { q?: string; page: number; pageSize: number }) {
  await requireModuleUser("items");
  const q = params.q?.trim();
  const where: Prisma.BrandWhereInput = q
    ? {
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { families: { some: { name: { contains: q, mode: "insensitive" } } } },
        ],
      }
    : {};
  const [rows, total, families] = await Promise.all([
    db.brand.findMany({
      where,
      orderBy: { name: "asc" },
      include: {
        families: { orderBy: { name: "asc" }, include: { _count: { select: { items: true } } } },
        _count: { select: { items: true } },
      },
      ...pageSlice(params.page, params.pageSize),
    }),
    db.brand.count({ where }),
    db.productFamily.count({ where: q ? { brand: where } : {} }),
  ]);
  return { rows, total, families };
}

export async function createBrand(input: unknown): Promise<ActionResult<{ id: string; name: string }>> {
  const user = await requireModuleUser("items");
  if (!(await hasEffectivePermission(user.id, "catalog.manage"))) {
    return { ok: false, error: "You can't manage the product catalog." };
  }
  const parsed = createBrandSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const clash = await brandNamed(parsed.data.name);
  if (clash) return { ok: false, error: `"${clash.name}" is already in the catalogue.` };

  try {
    const brand = await db.brand.create({ data: { name: cleanName(parsed.data.name) } });
    revalidatePath("/settings/lists");
    revalidatePath("/items", "layout");
    return { ok: true, data: { id: brand.id, name: brand.name } };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, error: "A brand with this name already exists." };
    }
    throw err;
  }
}

export async function updateBrand(input: unknown): Promise<ActionResult<{ id: string; name: string }>> {
  const user = await requireModuleUser("items");
  if (!(await hasEffectivePermission(user.id, "catalog.manage"))) {
    return { ok: false, error: "You can't manage the product catalog." };
  }
  const parsed = updateBrandSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const clash = await brandNamed(parsed.data.name, parsed.data.id);
  if (clash) return { ok: false, error: `"${clash.name}" is already in the catalogue.` };

  try {
    const brand = await db.brand.update({ where: { id: parsed.data.id }, data: { name: cleanName(parsed.data.name) } });
    revalidatePath("/settings/lists");
    revalidatePath("/items", "layout");
    return { ok: true, data: { id: brand.id, name: brand.name } };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, error: "A brand with this name already exists." };
    }
    throw err;
  }
}

export async function deleteBrand(id: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("items");
  if (!(await hasEffectivePermission(user.id, "catalog.manage"))) {
    return { ok: false, error: "You can't manage the product catalog." };
  }
  const itemCount = await db.item.count({ where: { brandId: id } });
  if (itemCount > 0) {
    return { ok: false, error: `${itemCount} item(s) still belong to this brand — reassign them first.` };
  }

  // Families cascade with the brand; items never do, which is what the guard above protects.
  await db.brand.delete({ where: { id } });
  revalidatePath("/settings/lists");
  revalidatePath("/items", "layout");
  return { ok: true, data: null };
}

export async function createProductFamily(input: unknown): Promise<ActionResult<{ id: string; name: string }>> {
  const user = await requireModuleUser("items");
  if (!(await hasEffectivePermission(user.id, "catalog.manage"))) {
    return { ok: false, error: "You can't manage the product catalog." };
  }
  const parsed = createProductFamilySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const clash = await familyNamed(parsed.data.brandId, parsed.data.name);
  if (clash) return { ok: false, error: `This brand already has "${clash.name}".` };

  try {
    const family = await db.productFamily.create({
      data: { brandId: parsed.data.brandId, name: cleanName(parsed.data.name) },
    });
    revalidatePath("/settings/lists");
    revalidatePath("/items", "layout");
    return { ok: true, data: { id: family.id, name: family.name } };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, error: "This brand already has a family with that name." };
    }
    throw err;
  }
}

export async function updateProductFamily(input: unknown): Promise<ActionResult<{ id: string; name: string }>> {
  const user = await requireModuleUser("items");
  if (!(await hasEffectivePermission(user.id, "catalog.manage"))) {
    return { ok: false, error: "You can't manage the product catalog." };
  }
  const parsed = updateProductFamilySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const current = await db.productFamily.findUnique({ where: { id: parsed.data.id }, select: { brandId: true } });
  if (!current) return { ok: false, error: "That product family no longer exists." };
  const clash = await familyNamed(current.brandId, parsed.data.name, parsed.data.id);
  if (clash) return { ok: false, error: `This brand already has "${clash.name}".` };

  try {
    const family = await db.productFamily.update({
      where: { id: parsed.data.id },
      data: { name: cleanName(parsed.data.name) },
    });
    revalidatePath("/settings/lists");
    revalidatePath("/items", "layout");
    return { ok: true, data: { id: family.id, name: family.name } };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, error: "This brand already has a family with that name." };
    }
    throw err;
  }
}

export async function deleteProductFamily(id: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("items");
  if (!(await hasEffectivePermission(user.id, "catalog.manage"))) {
    return { ok: false, error: "You can't manage the product catalog." };
  }
  const itemCount = await db.item.count({ where: { productFamilyId: id } });
  if (itemCount > 0) {
    return { ok: false, error: `${itemCount} item(s) still belong to this family — reassign them first.` };
  }

  await db.productFamily.delete({ where: { id } });
  revalidatePath("/settings/lists");
  revalidatePath("/items", "layout");
  return { ok: true, data: null };
}

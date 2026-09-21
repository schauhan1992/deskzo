"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { createBrandSchema, updateBrandSchema, createProductFamilySchema, updateProductFamilySchema } from "@/lib/validation/brand";
import type { ActionResult } from "@/actions/company";

/** Brands with their product families, for the item form's two linked pickers and the settings screen. */
export async function listBrands() {
  await requireUser();
  return db.brand.findMany({
    orderBy: { name: "asc" },
    include: {
      families: { orderBy: { name: "asc" }, include: { _count: { select: { items: true } } } },
      _count: { select: { items: true } },
    },
  });
}

export async function createBrand(input: unknown): Promise<ActionResult<{ id: string; name: string }>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "catalog.manage"))) {
    return { ok: false, error: "You can't manage the product catalog." };
  }
  const parsed = createBrandSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    const brand = await db.brand.create({ data: { name: parsed.data.name.trim() } });
    revalidatePath("/settings");
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
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "catalog.manage"))) {
    return { ok: false, error: "You can't manage the product catalog." };
  }
  const parsed = updateBrandSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    const brand = await db.brand.update({ where: { id: parsed.data.id }, data: { name: parsed.data.name.trim() } });
    revalidatePath("/settings");
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
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "catalog.manage"))) {
    return { ok: false, error: "You can't manage the product catalog." };
  }
  const itemCount = await db.item.count({ where: { brandId: id } });
  if (itemCount > 0) {
    return { ok: false, error: `${itemCount} item(s) still belong to this brand — reassign them first.` };
  }

  // Families cascade with the brand; items never do, which is what the guard above protects.
  await db.brand.delete({ where: { id } });
  revalidatePath("/settings");
  revalidatePath("/items", "layout");
  return { ok: true, data: null };
}

export async function createProductFamily(input: unknown): Promise<ActionResult<{ id: string; name: string }>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "catalog.manage"))) {
    return { ok: false, error: "You can't manage the product catalog." };
  }
  const parsed = createProductFamilySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    const family = await db.productFamily.create({
      data: { brandId: parsed.data.brandId, name: parsed.data.name.trim() },
    });
    revalidatePath("/settings");
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
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "catalog.manage"))) {
    return { ok: false, error: "You can't manage the product catalog." };
  }
  const parsed = updateProductFamilySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    const family = await db.productFamily.update({
      where: { id: parsed.data.id },
      data: { name: parsed.data.name.trim() },
    });
    revalidatePath("/settings");
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
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "catalog.manage"))) {
    return { ok: false, error: "You can't manage the product catalog." };
  }
  const itemCount = await db.item.count({ where: { productFamilyId: id } });
  if (itemCount > 0) {
    return { ok: false, error: `${itemCount} item(s) still belong to this family — reassign them first.` };
  }

  await db.productFamily.delete({ where: { id } });
  revalidatePath("/settings");
  revalidatePath("/items", "layout");
  return { ok: true, data: null };
}

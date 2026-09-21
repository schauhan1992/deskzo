"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { createIndustrySchema, updateIndustrySchema } from "@/lib/validation/industry";
import type { ActionResult } from "@/actions/company";

export async function listIndustries() {
  await requireUser();
  return db.industry.findMany({ orderBy: { name: "asc" } });
}

export async function createIndustry(input: unknown): Promise<ActionResult<{ id: string; name: string }>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "catalog.manage"))) {
    return { ok: false, error: "You can't manage the industry list." };
  }
  const parsed = createIndustrySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    const industry = await db.industry.create({ data: { name: parsed.data.name.trim() } });
    revalidatePath("/settings");
    return { ok: true, data: { id: industry.id, name: industry.name } };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, error: "An industry with this name already exists." };
    }
    throw err;
  }
}

export async function updateIndustry(input: unknown): Promise<ActionResult<{ id: string; name: string }>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "catalog.manage"))) {
    return { ok: false, error: "You can't manage the industry list." };
  }
  const parsed = updateIndustrySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    const industry = await db.industry.update({
      where: { id: parsed.data.id },
      data: { name: parsed.data.name.trim() },
    });
    revalidatePath("/settings");
    revalidatePath("/companies");
    return { ok: true, data: { id: industry.id, name: industry.name } };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, error: "An industry with this name already exists." };
    }
    throw err;
  }
}

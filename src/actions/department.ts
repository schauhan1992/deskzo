"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { createDepartmentSchema, updateDepartmentSchema } from "@/lib/validation/department";
import { DASHBOARD_WIDGET_REGISTRY } from "@/lib/dashboard-widgets";
import type { ActionResult } from "@/actions/company";

/**
 * Departments, for a filter or a form — the directory's, the employee form's, the fixed asset
 * register's. Here rather than with HR: every workspace has departments, whatever its plan.
 */
export async function listDepartmentOptions() {
  await requireUser();
  return db.department.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } });
}

/** Active people who can be named as somebody's manager, or as an asset's custodian. */
export async function listManagerOptions() {
  await requireUser();
  return db.user.findMany({
    where: { active: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
}

export async function listDepartments() {
  await requireUser();
  return db.department.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { members: true } } },
  });
}

export async function createDepartment(input: unknown): Promise<ActionResult<{ id: string; name: string }>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "users.manage"))) {
    return { ok: false, error: "You can't manage departments." };
  }
  const parsed = createDepartmentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    const department = await db.department.create({ data: { name: parsed.data.name.trim() } });
    revalidatePath("/settings/access");
    return { ok: true, data: { id: department.id, name: department.name } };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, error: "A department with this name already exists." };
    }
    throw err;
  }
}

export async function updateDepartment(input: unknown): Promise<ActionResult<{ id: string; name: string }>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "users.manage"))) {
    return { ok: false, error: "You can't manage departments." };
  }
  const parsed = updateDepartmentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    const department = await db.department.update({
      where: { id: parsed.data.id },
      data: { name: parsed.data.name.trim() },
    });
    revalidatePath("/settings/access");
    return { ok: true, data: { id: department.id, name: department.name } };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, error: "A department with this name already exists." };
    }
    throw err;
  }
}

export async function setDepartmentSupportTeam(id: string, isSupportTeam: boolean): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "users.manage"))) {
    return { ok: false, error: "You can't manage departments." };
  }

  await db.department.update({ where: { id }, data: { isSupportTeam } });
  revalidatePath("/settings/access");
  return { ok: true, data: null };
}

export async function setDepartmentDashboardWidgets(id: string, widgetKeys: string[]): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "users.manage"))) {
    return { ok: false, error: "You can't manage departments." };
  }
  const validKeys = new Set(DASHBOARD_WIDGET_REGISTRY.map((w) => w.key));
  const filtered = widgetKeys.filter((k) => validKeys.has(k));

  await db.department.update({ where: { id }, data: { defaultDashboardWidgets: filtered } });
  revalidatePath("/settings/access");
  return { ok: true, data: null };
}

export async function deleteDepartment(id: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "users.manage"))) {
    return { ok: false, error: "You can't manage departments." };
  }

  await db.department.delete({ where: { id } });
  revalidatePath("/settings/access");
  return { ok: true, data: null };
}

"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { recordAudit } from "@/lib/audit";
import { categoryTree, checkCategory, type CategoryTree, type FlatCategory } from "@/lib/customers/categories";
import type { ActionResult } from "@/actions/company";
import { isCustomerRelationshipType } from "@/lib/validation/company";

/**
 * Customer categories: the list everybody picks from, the settings screen that shapes it, and
 * putting a customer in one.
 *
 * Shaping the list is "companies.manageCategories" — it decides how every account is described to
 * everybody. Putting a customer in a category is part of editing that customer, so it follows the
 * same rule as editing them: whoever can see the account.
 */

export type CategoryOption = FlatCategory & { customers: number };

async function allCategories(): Promise<CategoryOption[]> {
  const rows = await db.customerCategory.findMany({
    select: { id: true, name: true, parentId: true, icon: true, color: true, guidance: true, sortOrder: true, _count: { select: { companies: true } } },
  });
  return rows.map(({ _count, ...r }) => ({ ...r, customers: _count.companies }));
}

/** The whole list, as a tree — for pickers and for the settings screen. */
export async function listCustomerCategories(): Promise<CategoryTree<CategoryOption>[]> {
  await requireUser();
  return categoryTree(await allCategories());
}

export async function saveCustomerCategory(input: {
  id?: string;
  parentId: string | null;
  name: string;
  icon: string | null;
  color: string | null;
  guidance: string | null;
}): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  if (!(await can(user.id, "companies.manageCategories"))) return { ok: false, error: "You can't change the customer categories." };
  const rows = await allCategories();
  if (input.id && !rows.some((r) => r.id === input.id)) return { ok: false, error: "That category isn't there any more." };
  const check = checkCategory(input, { rows });
  if (!check.ok) return check;
  const v = check.value;

  let id = input.id;
  if (id) {
    await db.customerCategory.update({ where: { id }, data: v });
  } else {
    // New ones go to the end of their list.
    const last = Math.max(-1, ...rows.filter((r) => (r.parentId ?? null) === v.parentId).map((r) => r.sortOrder));
    id = (await db.customerCategory.create({ data: { ...v, sortOrder: last + 1 } })).id;
  }
  await recordAudit({
    userId: user.id,
    action: input.id ? "UPDATE" : "CREATE",
    entityType: "CustomerCategory",
    entityId: id,
    entityLabel: v.parentId ? `${rows.find((r) => r.id === v.parentId)?.name} › ${v.name}` : v.name,
  });
  revalidatePath("/settings/customer-categories");
  return { ok: true, data: { id } };
}

/**
 * Removes a category. A sub-category's customers move up to its category — they were in it all
 * along. A category's customers, and its sub-categories', are left uncategorised.
 */
export async function deleteCustomerCategory(id: string): Promise<ActionResult<{ moved: number; cleared: number }>> {
  const user = await requireUser();
  if (!(await can(user.id, "companies.manageCategories"))) return { ok: false, error: "You can't change the customer categories." };
  const node = await db.customerCategory.findUnique({ where: { id }, select: { id: true, name: true, parentId: true, parent: { select: { name: true } } } });
  if (!node) return { ok: false, error: "That category isn't there any more." };

  let moved = 0;
  let cleared = 0;
  await db.$transaction(async (tx) => {
    if (node.parentId) {
      moved = (await tx.company.updateMany({ where: { customerCategoryId: id }, data: { customerCategoryId: node.parentId } })).count;
    } else {
      cleared = (await tx.company.updateMany({ where: { OR: [{ customerCategoryId: id }, { customerCategory: { parentId: id } }] }, data: { customerCategoryId: null } })).count;
    }
    // Its sub-categories go with it (the relation cascades).
    await tx.customerCategory.delete({ where: { id } });
  });
  await recordAudit({
    userId: user.id,
    action: "DELETE",
    entityType: "CustomerCategory",
    entityId: id,
    entityLabel: node.parent ? `${node.parent.name} › ${node.name}` : node.name,
  });
  revalidatePath("/settings/customer-categories");
  return { ok: true, data: { moved, cleared } };
}

/** One place up or down among its siblings. */
export async function moveCustomerCategory(id: string, direction: "up" | "down"): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await can(user.id, "companies.manageCategories"))) return { ok: false, error: "You can't change the customer categories." };
  const node = await db.customerCategory.findUnique({ where: { id }, select: { parentId: true } });
  if (!node) return { ok: false, error: "That category isn't there any more." };
  const siblings = await db.customerCategory.findMany({
    where: { parentId: node.parentId },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: { id: true },
  });
  const at = siblings.findIndex((s) => s.id === id);
  const to = direction === "up" ? at - 1 : at + 1;
  if (at < 0 || to < 0 || to >= siblings.length) return { ok: true, data: null };
  const order = siblings.map((s) => s.id);
  [order[at], order[to]] = [order[to]!, order[at]!];
  // Renumbered outright, so orders that had drifted into ties come out clean.
  await db.$transaction(async (tx) => {
    for (const op of order.map((sid, i) => tx.customerCategory.update({ where: { id: sid }, data: { sortOrder: i } }))) await op;
  });
  revalidatePath("/settings/customer-categories");
  return { ok: true, data: null };
}

/** Puts a customer in a category, or takes them out of every one (null). */
export async function setCompanyCategory(companyId: string, categoryId: string | null): Promise<ActionResult<null>> {
  const user = await requireUser();
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { id: true, name: true, ownerUserId: true, customerCategoryId: true, relationshipType: true },
  });
  // Out of scope and missing read the same, as everywhere else.
  if (!company || !(await canSeeCompany(user.id, company.ownerUserId))) return { ok: false, error: "Company not found." };
  // A vendor is no customer. Clearing one left from before is still allowed.
  if (categoryId && !isCustomerRelationshipType(company.relationshipType)) {
    return { ok: false, error: "Customer categories are for customers and resellers, not vendors or partners." };
  }
  let label = "none";
  if (categoryId) {
    const c = await db.customerCategory.findUnique({ where: { id: categoryId }, select: { name: true, parent: { select: { name: true } } } });
    if (!c) return { ok: false, error: "That category isn't there any more." };
    label = c.parent ? `${c.parent.name} › ${c.name}` : c.name;
  }
  if (company.customerCategoryId === categoryId) return { ok: true, data: null };
  await db.company.update({ where: { id: companyId }, data: { customerCategoryId: categoryId } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Company", entityId: companyId, entityLabel: `${company.name} — category: ${label}` });
  revalidatePath(`/companies/${companyId}`);
  return { ok: true, data: null };
}

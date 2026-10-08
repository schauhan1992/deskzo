"use server";

import { revalidatePath } from "next/cache";
import type { ContactDesignation } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { contactDesignationLabels, contactDesignationValues } from "@/lib/validation/company";
import { cleanDesignationName, designationNames, findDesignation } from "@/lib/contacts/designations";

/**
 * The workspace's list of contact designations (owner, 8 Oct 2026) — src/lib/contacts/designations.ts.
 * Anybody signed in reads the names, for the pickers; a new one is added by saving a contact with it.
 * Renaming, retyping, merging and deleting are Settings › Lists, with `catalog.manage` as industries are.
 */

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

export type DesignationRow = { id: string; name: string; kind: ContactDesignation; contacts: number };

const NO_RIGHT = "You can't manage the designation list.";

async function manager() {
  const user = await requireUser();
  return (await hasEffectivePermission(user.id, "catalog.manage")) ? user : null;
}

function refresh() {
  revalidatePath("/settings/lists");
  revalidatePath("/contacts");
}

export async function listDesignationNames(): Promise<string[]> {
  await requireUser();
  return designationNames();
}

export async function listDesignationsForSettings(): Promise<DesignationRow[]> {
  await requireUser();
  const rows = await db.designation.findMany({
    select: { id: true, name: true, kind: true, _count: { select: { contacts: true } } },
    orderBy: { name: "asc" },
  });
  return rows.map(({ _count, ...r }) => ({ ...r, contacts: _count.contacts }));
}

export async function renameDesignation(id: string, name: string): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: NO_RIGHT };
  const clean = cleanDesignationName(name);
  if (!clean) return { ok: false, error: "Give it a name." };
  const [row, clash] = await Promise.all([db.designation.findUnique({ where: { id }, select: { name: true } }), findDesignation(db, clean)]);
  if (!row) return { ok: false, error: "That designation isn't there any more." };
  if (clash && clash.id !== id) return { ok: false, error: `"${clash.name}" is already on the list — merge the two instead.` };
  await db.designation.update({ where: { id }, data: { name: clean } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Designation", entityId: id, entityLabel: `${row.name} → ${clean}` });
  refresh();
  return { ok: true, data: null };
}

/** Its type, and every contact that has it — the type is what scoring and rules read off the contact. */
export async function setDesignationKind(id: string, kind: string): Promise<ActionResult<{ contacts: number }>> {
  const user = await manager();
  if (!user) return { ok: false, error: NO_RIGHT };
  const parsed = z.enum(contactDesignationValues).safeParse(kind);
  if (!parsed.success) return { ok: false, error: "That isn't one of the types." };
  const row = await db.designation.findUnique({ where: { id }, select: { name: true } });
  if (!row) return { ok: false, error: "That designation isn't there any more." };
  const moved = await db.$transaction(async (tx) => {
    await tx.designation.update({ where: { id }, data: { kind: parsed.data } });
    return (await tx.contact.updateMany({ where: { designationId: id }, data: { designation: parsed.data } })).count;
  });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Designation", entityId: id, entityLabel: `${row.name}: type ${contactDesignationLabels[parsed.data]}` });
  refresh();
  return { ok: true, data: { contacts: moved } };
}

/**
 * A duplicate folded into the one that stays: its contacts take the staying designation, and its type,
 * and the duplicate is removed.
 */
export async function mergeDesignations(dropId: string, keepId: string): Promise<ActionResult<{ contacts: number }>> {
  const user = await manager();
  if (!user) return { ok: false, error: NO_RIGHT };
  if (dropId === keepId) return { ok: false, error: "Pick a different designation to merge into." };
  const [drop, keep] = await Promise.all([
    db.designation.findUnique({ where: { id: dropId }, select: { name: true } }),
    db.designation.findUnique({ where: { id: keepId }, select: { name: true, kind: true } }),
  ]);
  if (!drop || !keep) return { ok: false, error: "One of those designations isn't there any more." };
  const moved = await db.$transaction(async (tx) => {
    const n = (await tx.contact.updateMany({ where: { designationId: dropId }, data: { designationId: keepId, designation: keep.kind } })).count;
    await tx.designation.delete({ where: { id: dropId } });
    return n;
  });
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "Designation", entityId: dropId, entityLabel: `${drop.name} merged into ${keep.name} (${moved} contact${moved === 1 ? "" : "s"})` });
  refresh();
  return { ok: true, data: { contacts: moved } };
}

/** Only one no contact has — one in use is merged into another instead. */
export async function deleteDesignation(id: string): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: NO_RIGHT };
  const row = await db.designation.findUnique({ where: { id }, select: { name: true, _count: { select: { contacts: true } } } });
  if (!row) return { ok: false, error: "That designation isn't there any more." };
  if (row._count.contacts > 0) return { ok: false, error: `${row._count.contacts} contact${row._count.contacts === 1 ? " has" : "s have"} it — merge it into another instead.` };
  await db.designation.delete({ where: { id } });
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "Designation", entityId: id, entityLabel: row.name });
  refresh();
  return { ok: true, data: null };
}

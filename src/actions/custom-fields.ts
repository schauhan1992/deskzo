"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { customFieldDefinitionSchema } from "@/lib/validation/custom-fields";
import {
  CUSTOM_FIELD_ENTITIES,
  CUSTOM_FIELD_ENTITY_LABELS,
  CUSTOM_FIELD_ENTITY_MODULES,
  CUSTOM_FIELD_LIMITS,
  CUSTOM_FIELD_TYPE_LABELS,
  hasOptions,
  keyFromLabel,
  type CustomFieldEntityKey,
  type CustomFieldOption,
} from "@/lib/custom-fields/rules";
import { definitionsFor, notMigratedYet, type StoredDefinition } from "@/lib/custom-fields/server";
import type { ActionResult } from "@/actions/company";

/**
 * Custom fields (owner, 2 Oct 2026): the settings screen where a workspace adds its own fields to
 * companies, contacts, leads, orders and products. The values themselves are saved with each record,
 * by that record's own actions (src/lib/custom-fields/server.ts `prepareCustomFields`).
 *
 * Shaping the fields is `fields.manage` — a required field changes every form those records are
 * entered through. A field's type is fixed once it exists: a number read as a dropdown would misread
 * every record that holds one. Nothing here deletes a value: a retired field keeps them, a removed
 * option is retired rather than dropped, and a field can be deleted only while no record holds it.
 */

async function manager() {
  const user = await requireUser();
  return (await can(user.id, "fields.manage")) ? user : null;
}

/** The record types this workspace has: orders and products only where their modules are. */
async function entitiesHere(): Promise<CustomFieldEntityKey[]> {
  const out: CustomFieldEntityKey[] = [];
  for (const entity of CUSTOM_FIELD_ENTITIES) {
    const needs = CUSTOM_FIELD_ENTITY_MODULES[entity];
    if (needs ? await moduleAvailableForTenant(needs) : true) {
      out.push(entity);
    }
  }
  return out;
}

const TABLES: Record<CustomFieldEntityKey, string> = {
  COMPANY: "companies",
  VENDOR: "companies",
  CONTACT: "contacts",
  LEAD: "leads",
  ORDER: "company_products",
  ITEM: "items",
};

/** How many records hold a value for each of a record type's keys — what retiring or deleting affects. */
async function usage(entity: CustomFieldEntityKey): Promise<Map<string, number>> {
  try {
    const rows = await db.$queryRawUnsafe<{ key: string; n: number }[]>(
      `SELECT k::text AS key, count(*)::int AS n FROM "${TABLES[entity]}", jsonb_object_keys("customFields") AS k GROUP BY k`,
    );
    return new Map(rows.map((r) => [r.key, Number(r.n)]));
  } catch (err) {
    if (notMigratedYet(err)) return new Map();
    throw err;
  }
}

export type ManagedField = StoredDefinition & { inUse: number };

/** The other record type's keys, where two share one table's `customFields` (companies and vendors). */
async function sharedColumnKeys(entity: CustomFieldEntityKey): Promise<string[]> {
  const other = entity === "COMPANY" ? "VENDOR" : entity === "VENDOR" ? "COMPANY" : null;
  if (!other) return [];
  return (await db.customFieldDefinition.findMany({ where: { entity: other }, select: { key: true } })).map((d) => d.key);
}

/** Everything the settings screen shows: each record type's fields, retired ones too, with how much they're used. */
export async function listCustomFieldsForManage(): Promise<{
  entities: { entity: CustomFieldEntityKey; label: string; fields: ManagedField[] }[];
} | null> {
  if (!(await manager())) return null;
  const entities = await entitiesHere();
  const out = await Promise.all(
    entities.map(async (entity) => {
      const [defs, used] = await Promise.all([definitionsFor(entity), usage(entity)]);
      return { entity, label: CUSTOM_FIELD_ENTITY_LABELS[entity], fields: defs.map((d) => ({ ...d, inUse: used.get(d.key) ?? 0 })) };
    }),
  );
  return { entities: out };
}

/**
 * The options as stored: existing ones keep their value (so records keep their answer), new ones get
 * a value made from their label, and any the dialog no longer lists stay on as retired — a record that
 * holds one still shows what it says.
 */
function mergeOptions(previous: CustomFieldOption[], input: { value?: string; label: string; archived?: boolean }[]): CustomFieldOption[] {
  const taken = new Set(previous.map((o) => o.value));
  const out: CustomFieldOption[] = [];
  const kept = new Set<string>();
  for (const o of input) {
    const existing = o.value ? previous.find((p) => p.value === o.value) : undefined;
    const value = existing ? existing.value : keyFromLabel(o.label, taken);
    taken.add(value);
    kept.add(value);
    out.push({ value, label: o.label.trim(), ...(o.archived ? { archived: true } : {}) });
  }
  for (const p of previous) if (!kept.has(p.value)) out.push({ ...p, archived: true });
  return out;
}

export async function saveCustomFieldDefinition(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await manager();
  if (!user) return { ok: false, error: "You can't change custom fields." };
  const parsed = customFieldDefinitionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;
  if (!(await entitiesHere()).includes(data.entity)) return { ok: false, error: "That kind of record isn't in this workspace's plan." };

  const all = await definitionsFor(data.entity);
  const optionsIn = hasOptions(data.type) ? data.options : [];
  const common = {
    label: data.label,
    required: data.required,
    helpText: data.helpText || null,
    group: data.group || null,
    restricted: data.restricted,
    showInList: data.showInList,
    updatedById: user.id,
  };

  let id: string;
  if (data.id) {
    const current = all.find((d) => d.id === data.id);
    if (!current) return { ok: false, error: "That field no longer exists." };
    if (current.type !== data.type) {
      return { ok: false, error: `A field's type can't change once it exists — add a new ${CUSTOM_FIELD_TYPE_LABELS[data.type].toLowerCase()} field and retire this one.` };
    }
    if (all.some((d) => d.id !== current.id && !d.archived && d.label.toLowerCase() === data.label.toLowerCase())) {
      return { ok: false, error: `${CUSTOM_FIELD_ENTITY_LABELS[data.entity]} already have a field called “${data.label}”.` };
    }
    const options = mergeOptions(current.options, optionsIn);
    await db.customFieldDefinition.update({
      where: { id: current.id },
      data: { ...common, options: options as unknown as Prisma.InputJsonValue },
    });
    id = current.id;
  } else {
    if (all.filter((d) => !d.archived).length >= CUSTOM_FIELD_LIMITS.fieldsPerEntity) {
      return { ok: false, error: `${CUSTOM_FIELD_ENTITY_LABELS[data.entity]} have ${CUSTOM_FIELD_LIMITS.fieldsPerEntity} fields already — retire one first.` };
    }
    if (all.some((d) => !d.archived && d.label.toLowerCase() === data.label.toLowerCase())) {
      return { ok: false, error: `${CUSTOM_FIELD_ENTITY_LABELS[data.entity]} already have a field called “${data.label}”.` };
    }
    const options = mergeOptions([], optionsIn);
    const created = await db.customFieldDefinition.create({
      data: {
        ...common,
        entity: data.entity,
        // Companies' and vendors' fields share the companies table's one column: a key is never both.
        key: keyFromLabel(data.label, [...all.map((d) => d.key), ...(await sharedColumnKeys(data.entity))]),
        type: data.type,
        options: options as unknown as Prisma.InputJsonValue,
        sortOrder: all.reduce((m, d) => Math.max(m, d.sortOrder), -1) + 1,
        createdById: user.id,
      },
      select: { id: true },
    });
    id = created.id;
  }

  await recordAudit({
    userId: user.id,
    action: data.id ? "UPDATE" : "CREATE",
    entityType: "CustomField",
    entityId: id,
    entityLabel: `${CUSTOM_FIELD_ENTITY_LABELS[data.entity]} — custom field “${data.label}” (${CUSTOM_FIELD_TYPE_LABELS[data.type].toLowerCase()}${data.required ? ", required" : ""}${data.restricted ? ", restricted" : ""})`,
  });
  revalidatePath("/settings/custom-fields");
  return { ok: true, data: { id } };
}

async function findDefinition(id: string) {
  return db.customFieldDefinition.findUnique({ where: { id }, select: { id: true, entity: true, key: true, label: true, archivedAt: true, sortOrder: true } });
}

/** One place up or down among the record type's active fields. */
export async function moveCustomFieldDefinition(id: string, direction: "up" | "down"): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: "You can't change custom fields." };
  const field = await findDefinition(id);
  if (!field) return { ok: false, error: "That field no longer exists." };
  const active = (await definitionsFor(field.entity as CustomFieldEntityKey)).filter((d) => !d.archived);
  const at = active.findIndex((d) => d.id === id);
  const swap = direction === "up" ? at - 1 : at + 1;
  if (at < 0 || swap < 0 || swap >= active.length) return { ok: true, data: null };
  // Renumbered in order, so equal sort orders left by older rows can't make a move do nothing.
  const order = active.map((d) => d.id);
  [order[at], order[swap]] = [order[swap]!, order[at]!];
  await db.$transaction(async (tx) => {
    for (const [i, fieldId] of order.entries()) await tx.customFieldDefinition.update({ where: { id: fieldId }, data: { sortOrder: i } });
  });
  revalidatePath("/settings/custom-fields");
  return { ok: true, data: null };
}

/** Retire: off every form, page and list. The records keep their values; restoring brings them back. */
export async function archiveCustomFieldDefinition(id: string): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: "You can't change custom fields." };
  return setArchived(user.id, id, true);
}

export async function restoreCustomFieldDefinition(id: string): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: "You can't change custom fields." };
  return setArchived(user.id, id, false);
}

async function setArchived(userId: string, id: string, archived: boolean): Promise<ActionResult<null>> {
  const field = await findDefinition(id);
  if (!field) return { ok: false, error: "That field no longer exists." };
  if (archived === (field.archivedAt !== null)) return { ok: true, data: null };
  const entity = field.entity as CustomFieldEntityKey;
  if (!archived) {
    const all = await definitionsFor(entity);
    if (all.filter((d) => !d.archived).length >= CUSTOM_FIELD_LIMITS.fieldsPerEntity) {
      return { ok: false, error: `${CUSTOM_FIELD_ENTITY_LABELS[entity]} have ${CUSTOM_FIELD_LIMITS.fieldsPerEntity} fields already — retire one first.` };
    }
    if (all.some((d) => d.id !== id && !d.archived && d.label.toLowerCase() === field.label.toLowerCase())) {
      return { ok: false, error: `Another field is called “${field.label}” now — rename one of them first.` };
    }
  }
  await db.customFieldDefinition.update({ where: { id }, data: { archivedAt: archived ? new Date() : null, updatedById: userId } });
  await recordAudit({
    userId,
    action: "UPDATE",
    entityType: "CustomField",
    entityId: id,
    entityLabel: `${CUSTOM_FIELD_ENTITY_LABELS[entity]} — custom field “${field.label}” ${archived ? "retired" : "restored"}`,
  });
  revalidatePath("/settings/custom-fields");
  return { ok: true, data: null };
}

/** Deleting is for a field nobody has used — one that holds values is retired instead, so nothing is lost. */
export async function deleteCustomFieldDefinition(id: string): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: "You can't change custom fields." };
  const field = await findDefinition(id);
  if (!field) return { ok: false, error: "That field no longer exists." };
  const entity = field.entity as CustomFieldEntityKey;
  const used = (await usage(entity)).get(field.key) ?? 0;
  if (used > 0) {
    return { ok: false, error: `${used} ${used === 1 ? "record has" : "records have"} a value in “${field.label}” — retire it instead, and the values are kept.` };
  }
  await db.customFieldDefinition.delete({ where: { id } });
  await recordAudit({
    userId: user.id,
    action: "DELETE",
    entityType: "CustomField",
    entityId: id,
    entityLabel: `${CUSTOM_FIELD_ENTITY_LABELS[entity]} — custom field “${field.label}” deleted (unused)`,
  });
  revalidatePath("/settings/custom-fields");
  return { ok: true, data: null };
}

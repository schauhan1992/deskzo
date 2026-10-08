import { cache } from "react";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { PEOPLE_ONLY } from "@/lib/people";
import {
  applyInput,
  formValues,
  formatValue,
  groupDefs,
  readValues,
  visibleDefs,
  type CustomFieldDef,
  type CustomFieldEntityKey,
  type CustomFieldError,
  type CustomFieldOption,
  type CustomFieldTypeKey,
  type CustomFieldValues,
} from "@/lib/custom-fields/rules";

/**
 * The server side of custom fields: a workspace's definitions, who may see the restricted ones, and
 * reading and preparing a record's values. src/lib/custom-fields/rules.ts holds the rules themselves.
 *
 * Values are read with a query of their own rather than by widening each record's query: the
 * `customFields` column is left out of select-less reads until every workspace has it
 * (NOT_YET_EVERYWHERE in src/lib/tenancy/clients.ts), and a workspace still waiting for the
 * migration simply has no values — never a page that fails.
 */

export type StoredDefinition = CustomFieldDef & {
  id: string;
  entity: CustomFieldEntityKey;
  showInList: boolean;
  sortOrder: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** A table or column this workspace doesn't have yet — the migration hasn't reached it. */
export function notMigratedYet(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && (err.code === "P2021" || err.code === "P2022")) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /relation "custom_field_definitions" does not exist|column "?customFields"? does not exist|42P01|42703/.test(message);
}

function readOptions(raw: unknown): CustomFieldOption[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomFieldOption[] = [];
  for (const o of raw) {
    if (!o || typeof o !== "object") continue;
    const { value, label, archived } = o as Record<string, unknown>;
    if (typeof value !== "string" || typeof label !== "string") continue;
    out.push({ value, label, ...(archived === true ? { archived: true } : {}) });
  }
  return out;
}

/** Every definition for one record type, retired ones included, in their order. Once per request. */
export const definitionsFor = cache(async (entity: CustomFieldEntityKey): Promise<StoredDefinition[]> => {
  try {
    const rows = await db.customFieldDefinition.findMany({
      where: { entity },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    return rows.map((r) => ({
      id: r.id,
      entity: r.entity as CustomFieldEntityKey,
      key: r.key,
      label: r.label,
      type: r.type as CustomFieldTypeKey,
      options: readOptions(r.options),
      required: r.required,
      helpText: r.helpText,
      group: r.group,
      restricted: r.restricted,
      archived: r.archivedAt !== null,
      showInList: r.showInList,
      sortOrder: r.sortOrder,
      archivedAt: r.archivedAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
});

/** Whether this person sees the restricted fields. */
export function canSeeRestricted(userId: string): Promise<boolean> {
  return can(userId, "fields.seeRestricted");
}

/** The fields one person works with on one record type: visible, active, in order. */
export async function fieldsFor(entity: CustomFieldEntityKey, userId: string) {
  const [all, restricted] = await Promise.all([definitionsFor(entity), canSeeRestricted(userId)]);
  return { all, visible: visibleDefs(all, restricted), canSeeRestricted: restricted };
}

/** The model a record type's values live on. */
function table(entity: CustomFieldEntityKey) {
  type Rows = { findMany(args: unknown): Promise<{ id: string; customFields: unknown }[]> };
  switch (entity) {
    case "COMPANY":
    case "VENDOR":
      return db.company as unknown as Rows;
    case "CONTACT":
      return db.contact as unknown as Rows;
    case "LEAD":
      return db.lead as unknown as Rows;
    case "ORDER":
      return db.companyProduct as unknown as Rows;
    case "ITEM":
      return db.item as unknown as Rows;
  }
}

/** Stored values for these records, every field included — callers trim to what the person may see. */
export async function valuesOf(entity: CustomFieldEntityKey, ids: string[]): Promise<Map<string, CustomFieldValues>> {
  const out = new Map<string, CustomFieldValues>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return out;
  try {
    const rows = await table(entity).findMany({ where: { id: { in: unique } }, select: { id: true, customFields: true } });
    for (const row of rows) out.set(row.id, readValues(row.customFields));
  } catch (err) {
    if (notMigratedYet(err)) return out;
    throw err;
  }
  return out;
}

/** One record's stored values. */
export async function valuesFor(entity: CustomFieldEntityKey, id: string): Promise<CustomFieldValues> {
  return (await valuesOf(entity, [id])).get(id) ?? {};
}

/** The workspace's people who can be named in a "person" field: active members, by name. */
export const peopleForFields = cache(async () =>
  db.user.findMany({ where: { active: true, ...PEOPLE_ONLY }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
);

/** Names for the people a set of values names — removed people included, so old values still read. */
async function namesOf(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r.name]));
}

function personIds(defs: CustomFieldDef[], values: CustomFieldValues[]): string[] {
  const keys = defs.filter((d) => d.type === "USER").map((d) => d.key);
  const ids: string[] = [];
  for (const v of values) for (const k of keys) if (typeof v[k] === "string") ids.push(v[k] as string);
  return ids;
}

export type PreparedFields =
  | { ok: true; values: CustomFieldValues; changed: string[] }
  | { ok: false; error: string; errors: CustomFieldError[] };

/**
 * What a record is to be saved with, from what was entered: checked against this workspace's
 * definitions and this person's access (src/lib/custom-fields/rules.ts `applyInput`), with every
 * newly named person confirmed to be an active member. `changed` names the fields that moved, for
 * the audit line. On refusal, `error` is one sentence a form can show as it is.
 */
export async function prepareCustomFields(params: {
  entity: CustomFieldEntityKey;
  userId: string;
  input: unknown;
  existing?: CustomFieldValues;
  checkRequired?: boolean;
  only?: Iterable<string>;
  /** Keys hidden from this person where the record is — see `applyInput`. */
  skip?: Iterable<string>;
}): Promise<PreparedFields> {
  const { all, canSeeRestricted: restricted } = await fieldsFor(params.entity, params.userId);
  const existing = params.existing ?? {};
  const applied = applyInput({
    defs: all,
    input: params.input,
    existing,
    canSeeRestricted: restricted,
    checkRequired: params.checkRequired,
    only: params.only,
    skip: params.skip,
  });
  if (!applied.ok) return { ok: false, errors: applied.errors, error: applied.errors.map((e) => e.message).join(" ") };

  const errors: CustomFieldError[] = [];
  const named = all.filter((d) => d.type === "USER" && applied.values[d.key] !== existing[d.key] && typeof applied.values[d.key] === "string");
  if (named.length) {
    const ids = named.map((d) => applied.values[d.key] as string);
    const people = await db.user.findMany({ where: { id: { in: ids }, active: true, ...PEOPLE_ONLY }, select: { id: true } });
    const known = new Set(people.map((p) => p.id));
    for (const d of named) {
      if (!known.has(applied.values[d.key] as string)) errors.push({ key: d.key, label: d.label, message: `Choose a person for ${d.label} from the workspace.` });
    }
  }
  if (errors.length) return { ok: false, errors, error: errors.map((e) => e.message).join(" ") };

  const changed = all
    .filter((d) => JSON.stringify(applied.values[d.key] ?? null) !== JSON.stringify(existing[d.key] ?? null))
    .map((d) => d.label);
  return { ok: true, values: applied.values, changed };
}

/** A record's fields as one person sees them on its page: headings, labels, and the values in words. */
export type DisplayedFields = { group: string; fields: { key: string; label: string; type: CustomFieldTypeKey; text: string; restricted: boolean }[] }[];

export async function displayFields(entity: CustomFieldEntityKey, userId: string, values: CustomFieldValues): Promise<DisplayedFields> {
  const { visible } = await fieldsFor(entity, userId);
  if (visible.length === 0) return [];
  const names = await namesOf(personIds(visible, [values]));
  return groupDefs(visible).map((g) => ({
    group: g.group,
    fields: g.fields.map((d) => ({
      key: d.key,
      label: d.label,
      type: d.type,
      text: formatValue(d, values[d.key], (id) => names.get(id)),
      restricted: d.restricted,
    })),
  }));
}

/**
 * The same values, in words, for many records at once — a list's columns or an export's. Only the
 * fields given (already trimmed to what the person may see).
 */
export async function formatMany(defs: CustomFieldDef[], rows: Map<string, CustomFieldValues>): Promise<Map<string, Record<string, string>>> {
  const names = await namesOf(personIds(defs, [...rows.values()]));
  const out = new Map<string, Record<string, string>>();
  for (const [id, values] of rows) {
    const texts: Record<string, string> = {};
    for (const d of defs) texts[d.key] = formatValue(d, values[d.key], (pid) => names.get(pid));
    out.set(id, texts);
  }
  return out;
}

/** The audit line's addition for changed custom fields: " — Tower, Floor changed", or "". */
export function changedLabel(changed: string[]): string {
  if (changed.length === 0) return "";
  const shown = changed.slice(0, 5).join(", ");
  return ` — ${shown}${changed.length > 5 ? ` and ${changed.length - 5} more` : ""} changed`;
}

/** A definition as a client component receives it — the shape the rules need, nothing else. */
export function clientDef(d: StoredDefinition): CustomFieldDef {
  return {
    key: d.key,
    label: d.label,
    type: d.type,
    options: d.options,
    required: d.required,
    helpText: d.helpText,
    group: d.group,
    restricted: d.restricted,
    archived: d.archived,
  };
}

/**
 * What a form needs for one record type: the fields this person fills in, the values they start
 * with (a new record's are empty) and, when a field names a person, the workspace's people.
 */
export async function formSetup(entity: CustomFieldEntityKey, userId: string, existing?: CustomFieldValues) {
  const { visible } = await fieldsFor(entity, userId);
  const people = visible.some((d) => d.type === "USER") ? await peopleForFields() : [];
  return { fields: visible.map(clientDef), values: formValues(visible, existing ?? {}), people };
}

/**
 * A list's custom-field columns: every field this person may see, each saying whether it is a column
 * by default — the ones marked "a column in the list" — and each row's values in words. Every field
 * rather than the marked ones because each person may show or hide any of them for themselves, in the
 * column picker (src/lib/tables/registry.ts); a choice made there shows at once, with nothing to fetch.
 *
 * `listedOnly` for a table without a picker: only the marked fields, which it always shows. No
 * columns, or no rows, no query.
 */
export async function listColumns(entity: CustomFieldEntityKey, userId: string, ids: string[], options: { listedOnly?: boolean } = {}) {
  const { visible } = await fieldsFor(entity, userId);
  const defs = options.listedOnly ? visible.filter((d) => d.showInList) : visible;
  const columns = defs.map((d) => ({ key: d.key, label: d.label, numeric: d.type === "NUMBER" || d.type === "MONEY", default: d.showInList }));
  // A page with no rows still shows the columns' headings, so the table keeps its shape.
  if (defs.length === 0 || ids.length === 0) return { columns, texts: {} as Record<string, Record<string, string>> };
  const texts = await formatMany(defs, await valuesOf(entity, ids));
  return { columns, texts: Object.fromEntries(ids.map((id) => [id, texts.get(id) ?? {}])) };
}

/**
 * Saves one record's fields from what was entered — after the record type's own action has decided
 * this person may change the record. Returns the labels of the fields that changed (none: nothing
 * was written), or the refusal in words.
 */
export async function saveCustomFields(
  entity: CustomFieldEntityKey,
  id: string,
  userId: string,
  input: unknown,
  options: { skip?: Iterable<string> } = {},
): Promise<{ ok: true; changed: string[] } | { ok: false; error: string }> {
  const existing = await valuesFor(entity, id);
  const prepared = await prepareCustomFields({ entity, userId, input, existing, checkRequired: true, skip: options.skip });
  if (!prepared.ok) return { ok: false, error: prepared.error };
  if (prepared.changed.length === 0) return { ok: true, changed: [] };
  const data = { customFields: prepared.values as Prisma.InputJsonValue };
  switch (entity) {
    case "COMPANY":
    case "VENDOR":
      await db.company.update({ where: { id }, data, select: { id: true } });
      break;
    case "CONTACT":
      await db.contact.update({ where: { id }, data, select: { id: true } });
      break;
    case "LEAD":
      await db.lead.update({ where: { id }, data, select: { id: true } });
      break;
    case "ORDER":
      await db.companyProduct.update({ where: { id }, data, select: { id: true } });
      break;
    case "ITEM":
      await db.item.update({ where: { id }, data, select: { id: true } });
      break;
  }
  return { ok: true, changed: prepared.changed };
}

/**
 * The `customFields` to create a record with, from what its form sent — or nothing to write when the
 * workspace has no fields (so a workspace still waiting for the column is never asked to fill it).
 */
export async function customFieldsForCreate(
  entity: CustomFieldEntityKey,
  userId: string,
  input: unknown,
  options: { checkRequired?: boolean } = {},
): Promise<{ ok: true; data: { customFields?: Prisma.InputJsonValue } } | { ok: false; error: string }> {
  const prepared = await prepareCustomFields({ entity, userId, input, checkRequired: options.checkRequired ?? true });
  if (!prepared.ok) return { ok: false, error: prepared.error };
  return { ok: true, data: Object.keys(prepared.values).length > 0 ? { customFields: prepared.values as Prisma.InputJsonValue } : {} };
}

/**
 * What a list's search box adds for the workspace's own fields: one `OR` branch per field this person
 * may see that the words could be in — text that contains them, a dropdown option or person whose
 * name does, the number they are. Restricted fields are left out for anybody who can't see them, so
 * a search can't be used to find out what one holds. Nothing for a workspace without fields.
 */
export async function customSearchWhere(entity: CustomFieldEntityKey, userId: string, query: string | undefined): Promise<Record<string, unknown>[]> {
  const q = query?.trim() ?? "";
  if (q.length < 2) return [];
  const { visible } = await fieldsFor(entity, userId);
  if (visible.length === 0) return [];
  const lower = q.toLowerCase();
  const number = /^-?[\d,]*\.?\d+$/.test(q.replace(/[\s₹]/g, "")) ? Number(q.replace(/[\s,₹]/g, "")) : null;
  const people = visible.some((d) => d.type === "USER")
    ? (await peopleForFields()).filter((p) => p.name.toLowerCase().includes(lower)).map((p) => p.id)
    : [];
  const branches: Record<string, unknown>[] = [];
  for (const d of visible) {
    const path = [d.key];
    switch (d.type) {
      case "TEXT":
      case "LONG_TEXT":
      case "EMAIL":
      case "PHONE":
      case "URL":
      case "DATE":
        branches.push({ customFields: { path, string_contains: q, mode: "insensitive" } });
        break;
      case "NUMBER":
      case "MONEY":
        if (number !== null && Number.isFinite(number)) branches.push({ customFields: { path, equals: number } });
        break;
      case "SELECT":
        for (const o of d.options) if (o.label.toLowerCase().includes(lower)) branches.push({ customFields: { path, equals: o.value } });
        break;
      case "MULTI_SELECT":
        for (const o of d.options) if (o.label.toLowerCase().includes(lower)) branches.push({ customFields: { path, array_contains: [o.value] } });
        break;
      case "USER":
        for (const id of people) branches.push({ customFields: { path, equals: id } });
        break;
      case "CHECKBOX":
        break;
    }
  }
  return branches;
}

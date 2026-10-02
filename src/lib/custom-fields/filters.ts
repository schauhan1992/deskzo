import { Prisma } from "@prisma/client";
import { fieldsFor, peopleForFields } from "@/lib/custom-fields/server";
import {
  CUSTOM_FIELD_LIMITS,
  FIELD_KEY_PATTERN,
  type CustomFieldDef,
  type CustomFieldEntityKey,
  type CustomFieldTypeKey,
} from "@/lib/custom-fields/rules";

/**
 * Narrowing a list by the workspace's own fields (owner, 2 Oct 2026): "Region is North or South",
 * "Licence expiry in March", "VIP: no".
 *
 * The URL holds them, so a filtered list survives a reload or a shared link — one parameter per field,
 * under `cf.`, which no page's own parameters use and which can't collide with a field (a key has no
 * dot in it):
 *
 *   cf.<key>=north,south            a dropdown or multi-select: any of these options (stored values)
 *   cf.<key>=yes | no               yes or no — "no" includes a record nobody ever answered
 *   cf.<key>=<person id>            a person field
 *   cf.<key>=<words>                text, email, phone or web address: contains them, in any case
 *   cf.<key>.from / cf.<key>.to     a date, yyyy-mm-dd, both days included
 *   cf.<key>.min / cf.<key>.max     a number or amount, both ends included
 *
 * Reading the URL (`parseCustomFilters`) is pure and knows nothing about fields. What a filter means
 * is decided only against the fields this person sees (`customFilterWhere`): one naming a field that
 * doesn't exist, has been retired, or is restricted from them is ignored — the list as if it weren't
 * there. Never an error, and never a way to find out what a field somebody can't see holds.
 */

export const CUSTOM_FILTER_PREFIX = "cf.";

/** A list page's field filters as its `searchParams` type has them — beside the page's own. */
export type CustomFilterParams = { [param: `cf.${string}`]: string | undefined };

/** One field's filter as the URL has it, nothing checked yet. */
export type CustomFilterInput = { value?: string; from?: string; to?: string; min?: string; max?: string };

/** Every field filter in a URL, by field key — what the pages hand the list actions. */
export type CustomFilterInputs = Record<string, CustomFilterInput>;

const PARTS = ["value", "from", "to", "min", "max"] as const;
type Part = (typeof PARTS)[number];
const RANGE_PARTS: readonly string[] = ["from", "to", "min", "max"];

const own = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);

/** A parameter's text: the first, when it was given twice; trimmed; no longer than a long text can be. */
function paramText(raw: unknown): string | null {
  const first = Array.isArray(raw) ? raw.find((v) => typeof v === "string") : raw;
  if (typeof first !== "string") return null;
  const text = first.trim().slice(0, CUSTOM_FIELD_LIMITS.longText);
  return text === "" ? null : text;
}

/**
 * The field filters a URL holds, by field key. Read, not judged: anything that isn't one of the
 * shapes above is left out, and nothing here knows which fields exist. Takes a page's `searchParams`
 * or a `URLSearchParams`.
 */
export function parseCustomFilters(params: Record<string, unknown> | URLSearchParams | null | undefined): CustomFilterInputs {
  const out: CustomFilterInputs = {};
  if (!params) return out;
  const entries: [string, unknown][] = params instanceof URLSearchParams ? [...params.entries()] : Object.entries(params);
  for (const [name, raw] of entries) {
    if (!name.startsWith(CUSTOM_FILTER_PREFIX)) continue;
    const segments = name.slice(CUSTOM_FILTER_PREFIX.length).split(".");
    const key = segments[0] ?? "";
    const part: Part | null = segments.length === 1 ? "value" : segments.length === 2 && RANGE_PARTS.includes(segments[1]!) ? (segments[1] as Part) : null;
    // The pattern keeps out "__proto__" and the like; `own` below keeps "constructor" an ordinary key.
    if (part === null || !FIELD_KEY_PATTERN.test(key)) continue;
    const text = paramText(raw);
    if (text === null) continue;
    let entry = own(out, key) ? out[key] : undefined;
    if (!entry) {
      entry = {};
      out[key] = entry;
    }
    if (entry[part] === undefined) entry[part] = text;
  }
  return out;
}

/**
 * The field filters in a page's parameters, as they stand, for a link that rebuilds its query from a
 * list of the page's own parameters — which would otherwise drop them without a word.
 */
export function customFilterParams(params: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(params)) {
    if (!name.startsWith(CUSTOM_FILTER_PREFIX)) continue;
    const text = Array.isArray(raw) ? raw.find((v) => typeof v === "string") : raw;
    if (typeof text === "string" && text !== "") out[name] = text;
  }
  return out;
}

/**
 * What a list action was sent as filters, made safe to read: own keys shaped like a field's, text
 * values, nothing else. A server action is a public endpoint, so this is read like a stranger's input.
 */
function readInputs(filters: unknown): Map<string, CustomFilterInput> {
  const out = new Map<string, CustomFilterInput>();
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) return out;
  for (const [key, raw] of Object.entries(filters)) {
    if (!FIELD_KEY_PATTERN.test(key) || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const input: CustomFilterInput = {};
    for (const part of PARTS) {
      const text = own(raw, part) ? paramText((raw as Record<string, unknown>)[part]) : null;
      if (text !== null) input[part] = text;
    }
    out.set(key, input);
  }
  return out;
}

// ─── What a filter means ──────────────────────────────────────────────────────────────────────────

/** A field filter once checked against its field: what the list is narrowed by. */
export type FieldFilter =
  | { kind: "options"; values: string[] }
  | { kind: "yes" }
  | { kind: "no" }
  | { kind: "person"; id: string }
  | { kind: "text"; text: string }
  | { kind: "days"; from: string | null; to: string | null }
  | { kind: "numbers"; min: number | null; max: number | null };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** The shape src/lib/custom-fields/rules.ts accepts for a person field's value. */
const PERSON = /^[a-z0-9]{8,40}$/i;

function calendarDay(s: string | undefined): string | null {
  if (!s || !DAY.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
}

/** A number as somebody types one — "1,25,000", "₹ 4,500.50" — or null. */
function amount(s: string | undefined): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[,\s₹]/g, "");
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && Math.abs(n) < CUSTOM_FIELD_LIMITS.numberMagnitude ? n : null;
}

/**
 * What one field's filter asks for, or null when it asks for nothing this field can answer — an
 * option the field doesn't have, "maybe" for a yes-or-no, a date that isn't one. Retired options are
 * options still: records keep them, so a list can still be narrowed to the records that do.
 */
export function understandFilter(def: CustomFieldDef, input: CustomFilterInput): FieldFilter | null {
  switch (def.type) {
    case "SELECT":
    case "MULTI_SELECT": {
      const known = new Set(def.options.map((o) => o.value));
      const values = [...new Set((input.value ?? "").split(",").map((v) => v.trim()))].filter((v) => known.has(v));
      return values.length > 0 ? { kind: "options", values } : null;
    }
    case "CHECKBOX": {
      const answer = input.value?.toLowerCase();
      return answer === "yes" ? { kind: "yes" } : answer === "no" ? { kind: "no" } : null;
    }
    case "USER":
      return input.value && PERSON.test(input.value) ? { kind: "person", id: input.value } : null;
    case "DATE": {
      const from = calendarDay(input.from);
      const to = calendarDay(input.to);
      return from || to ? { kind: "days", from, to } : null;
    }
    case "NUMBER":
    case "MONEY": {
      const min = amount(input.min);
      const max = amount(input.max);
      return min !== null || max !== null ? { kind: "numbers", min, max } : null;
    }
    case "TEXT":
    case "LONG_TEXT":
    case "EMAIL":
    case "PHONE":
    case "URL":
      return input.value ? { kind: "text", text: input.value } : null;
  }
}

/** Typed words as a LIKE pattern means them: `string_contains` is LIKE underneath, and % or _ are words here. */
function likeLiteral(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * The `where` clauses one field filter adds — each to be ANDed with the list's own, never spread into
 * it (several are an `OR`, and a list's `where` often has one of those already).
 *
 * Two of them are not what they first look like, and check:custom-field-filters proves both on this
 * engine:
 *  · "no" says "or never answered" out loud. A record without the key reads as SQL NULL, and
 *    NOT (NULL = true) is NULL rather than true — so `NOT equals true` alone silently drops every
 *    record nobody ever ticked or unticked, which is most of them.
 *  · A date is stored as yyyy-mm-dd text, which sorts the way the calendar does, and Prisma compares
 *    a JSON string only with strings — so `gte`/`lte` on the day are a day range, both days included,
 *    with no clock and no time zone in it.
 */
export function filterClauses(def: CustomFieldDef, filter: FieldFilter): Record<string, unknown>[] {
  const path = [def.key];
  switch (filter.kind) {
    case "options": {
      const one = (value: string) =>
        def.type === "MULTI_SELECT" ? { customFields: { path, array_contains: [value] } } : { customFields: { path, equals: value } };
      return [filter.values.length === 1 ? one(filter.values[0]!) : { OR: filter.values.map(one) }];
    }
    case "yes":
      return [{ customFields: { path, equals: true } }];
    case "no":
      return [{ OR: [{ NOT: { customFields: { path, equals: true } } }, { customFields: { path, equals: Prisma.AnyNull } }] }];
    case "person":
      return [{ customFields: { path, equals: filter.id } }];
    case "text":
      return [{ customFields: { path, string_contains: likeLiteral(filter.text), mode: "insensitive" } }];
    case "days":
      return [
        ...(filter.from ? [{ customFields: { path, gte: filter.from } }] : []),
        ...(filter.to ? [{ customFields: { path, lte: filter.to } }] : []),
      ];
    case "numbers":
      return [
        ...(filter.min !== null ? [{ customFields: { path, gte: filter.min } }] : []),
        ...(filter.max !== null ? [{ customFields: { path, lte: filter.max } }] : []),
      ];
  }
}

/**
 * The clauses a list adds for the field filters it was sent, built only from the fields this person
 * sees — each to go into the list's `AND`. Nothing for a workspace without fields, or a list with no
 * field filtered.
 *
 * `guard` adds a clause beside a field's filter: the contacts list keeps a filter on a contact-detail
 * field off a reseller's end customer, whose details are hidden from somebody who can't see them.
 */
export async function customFilterWhere(
  entity: CustomFieldEntityKey,
  userId: string,
  filters: unknown,
  options: { guard?: (def: CustomFieldDef) => Record<string, unknown> | null } = {},
): Promise<Record<string, unknown>[]> {
  const inputs = readInputs(filters);
  if (inputs.size === 0) return [];
  const { visible } = await fieldsFor(entity, userId);
  const clauses: Record<string, unknown>[] = [];
  for (const def of visible) {
    const input = inputs.get(def.key);
    const filter = input ? understandFilter(def, input) : null;
    if (!filter) continue;
    clauses.push(...filterClauses(def, filter));
    const guard = options.guard?.(def);
    if (guard) clauses.push(guard);
  }
  return clauses;
}

// ─── What the filter panel needs ──────────────────────────────────────────────────────────────────

/** One field as the filter panel shows it (src/components/custom-fields/custom-field-filters.tsx). */
export type FilterField = {
  key: string;
  label: string;
  type: CustomFieldTypeKey;
  /** A dropdown's or multi-select's options, the current ones first. */
  options: { value: string; label: string; archived: boolean }[];
  /** The URL parameters its filter is written to — the panel never makes up a name of its own. */
  params: { value?: string; from?: string; to?: string; min?: string; max?: string };
  /** What the URL asks of it now, as the controls hold it — only what was understood. */
  current: { values?: string[]; value?: string; from?: string; to?: string; min?: string; max?: string };
};

export type FilterSetup = {
  fields: FilterField[];
  /** The workspace's people, for a person field. */
  people: { id: string; name: string }[];
  /** How many fields are filtered on now. */
  active: number;
  /** Every field filter's parameters start with this — what Clear sweeps. */
  prefix: string;
};

function paramsFor(def: CustomFieldDef): FilterField["params"] {
  const base = `${CUSTOM_FILTER_PREFIX}${def.key}`;
  if (def.type === "DATE") return { from: `${base}.from`, to: `${base}.to` };
  if (def.type === "NUMBER" || def.type === "MONEY") return { min: `${base}.min`, max: `${base}.max` };
  return { value: base };
}

function currentOf(filter: FieldFilter | null): FilterField["current"] {
  if (!filter) return {};
  switch (filter.kind) {
    case "options":
      return { values: filter.values };
    case "yes":
    case "no":
      return { value: filter.kind };
    case "person":
      return { value: filter.id };
    case "text":
      return { value: filter.text };
    case "days":
      return { ...(filter.from ? { from: filter.from } : {}), ...(filter.to ? { to: filter.to } : {}) };
    case "numbers":
      return { ...(filter.min !== null ? { min: String(filter.min) } : {}), ...(filter.max !== null ? { max: String(filter.max) } : {}) };
  }
}

/**
 * The filter panel's fields for one list: the ones this person sees, in their order, each with what
 * the URL asks of it now. No fields, no panel — the page shows nothing.
 */
export async function customFilterSetup(entity: CustomFieldEntityKey, userId: string, filters: unknown): Promise<FilterSetup> {
  const { visible } = await fieldsFor(entity, userId);
  const inputs = readInputs(filters);
  const people = visible.some((d) => d.type === "USER") ? await peopleForFields() : [];
  let active = 0;
  const fields = visible.map((def): FilterField => {
    const input = inputs.get(def.key);
    const filter = input ? understandFilter(def, input) : null;
    if (filter) active += 1;
    return {
      key: def.key,
      label: def.label,
      type: def.type,
      options: [...def.options.filter((o) => !o.archived), ...def.options.filter((o) => o.archived)].map((o) => ({
        value: o.value,
        label: o.label,
        archived: o.archived === true,
      })),
      params: paramsFor(def),
      current: currentOf(filter),
    };
  });
  return { fields, people: people.map((p) => ({ id: p.id, name: p.name })), active, prefix: CUSTOM_FILTER_PREFIX };
}

import { formatCalendarDay } from "@/lib/time/zone";

/**
 * Custom fields (owner, 2 Oct 2026): fields a workspace adds to its own companies, contacts, leads,
 * orders and products — "Bed no." on a patient, "Tower / floor" on a booking, "Batch no." on an item.
 *
 * Pure: no database, no session. Every surface that reads or writes a value — the forms, the record
 * pages, the lists, the imports and exports — goes through these rules, so a value means the same
 * thing everywhere it appears.
 *
 * A definition lives in the workspace's own `custom_field_definitions`; the values live on the record
 * itself, in its `customFields` JSON, keyed by the definition's `key`. The key is made once from the
 * first label and never changes, so a field can be renamed without touching a single record; a field
 * that is retired keeps its values, unseen, until it is restored.
 */

export const CUSTOM_FIELD_ENTITIES = ["COMPANY", "CONTACT", "LEAD", "ORDER", "ITEM"] as const;
export type CustomFieldEntityKey = (typeof CUSTOM_FIELD_ENTITIES)[number];

/** What each record type is called where the fields are managed. */
export const CUSTOM_FIELD_ENTITY_LABELS: Record<CustomFieldEntityKey, string> = {
  COMPANY: "Companies",
  CONTACT: "Contacts",
  LEAD: "Leads",
  ORDER: "Orders",
  ITEM: "Products",
};

/**
 * The module a record type belongs to — its fields are offered only where the module is. Companies,
 * contacts and leads are the core of every plan (src/lib/module-actions.ts "core"): null.
 */
export const CUSTOM_FIELD_ENTITY_MODULES: Record<CustomFieldEntityKey, "orders" | "items" | null> = {
  COMPANY: null,
  CONTACT: null,
  LEAD: null,
  ORDER: "orders",
  ITEM: "items",
};

export const CUSTOM_FIELD_TYPES = [
  "TEXT",
  "LONG_TEXT",
  "NUMBER",
  "MONEY",
  "DATE",
  "SELECT",
  "MULTI_SELECT",
  "CHECKBOX",
  "EMAIL",
  "PHONE",
  "URL",
  "USER",
] as const;
export type CustomFieldTypeKey = (typeof CUSTOM_FIELD_TYPES)[number];

export const CUSTOM_FIELD_TYPE_LABELS: Record<CustomFieldTypeKey, string> = {
  TEXT: "Short text",
  LONG_TEXT: "Long text",
  NUMBER: "Number",
  MONEY: "Amount (₹)",
  DATE: "Date",
  SELECT: "Dropdown",
  MULTI_SELECT: "Multi-select",
  CHECKBOX: "Yes or no",
  EMAIL: "Email",
  PHONE: "Phone",
  URL: "Web address",
  USER: "Person in the workspace",
};

/** The two types whose answers come from a list the admin keeps. */
export const hasOptions = (type: CustomFieldTypeKey) => type === "SELECT" || type === "MULTI_SELECT";

export const CUSTOM_FIELD_LIMITS = {
  /** Active fields on one record type — a form past this stops being a form. */
  fieldsPerEntity: 100,
  label: 60,
  helpText: 200,
  group: 40,
  options: 100,
  optionLabel: 60,
  text: 255,
  longText: 5000,
  url: 2000,
  /** A number or amount beyond this is a typo, not a quantity. */
  numberMagnitude: 1e15,
} as const;

export type CustomFieldOption = {
  /** Stored on the record. Made once from the first label; renaming the option keeps it. */
  value: string;
  label: string;
  /** Not offered any more; records that have it still show it. */
  archived?: boolean;
};

/** A definition as the rules need it — the stored row, trimmed to what matters here. */
export type CustomFieldDef = {
  key: string;
  label: string;
  type: CustomFieldTypeKey;
  options: CustomFieldOption[];
  required: boolean;
  helpText: string | null;
  /** A heading the field sits under in forms and on the record, e.g. "Compliance". */
  group: string | null;
  /** Seen and changed only by holders of `fields.seeRestricted`. */
  restricted: boolean;
  /** Retired: hidden everywhere, its values kept. */
  archived: boolean;
};

/** A value as stored: text, a number, yes/no, or a multi-select's chosen options. */
export type CustomFieldValue = string | number | boolean | string[];
export type CustomFieldValues = Record<string, CustomFieldValue>;

// ─── Keys ─────────────────────────────────────────────────────────────────────────────────────────

export const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * A stable key from a label: lower case, words joined by underscores, starting with a letter, no
 * longer than 40 — and not one already taken ("tower", "tower_2", …). Never shown to anybody; it is
 * what the record's JSON is keyed by.
 */
export function keyFromLabel(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let base = label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!base) base = "field";
  if (!/^[a-z]/.test(base)) base = `f_${base}`;
  base = base.slice(0, 36).replace(/_+$/, "");
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}_${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

// ─── Reading what is stored ───────────────────────────────────────────────────────────────────────

/**
 * A record's stored values, read defensively: anything that isn't a plain object of text, numbers,
 * yes/no or lists of text is ignored rather than trusted — the column is JSON, and JSON can hold
 * anything a script once wrote into it.
 */
export function readValues(raw: unknown): CustomFieldValues {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: CustomFieldValues = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!FIELD_KEY_PATTERN.test(key)) continue;
    if (typeof value === "string" || typeof value === "boolean") out[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (Array.isArray(value) && value.every((v) => typeof v === "string")) out[key] = value as string[];
  }
  return out;
}

export function isEmptyValue(value: CustomFieldValue | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

// ─── Checking what is entered ─────────────────────────────────────────────────────────────────────

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9][0-9 ()\-.]{4,24}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function validDay(s: string): boolean {
  if (!DAY.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function webAddress(s: string): string | null {
  if (s.length > CUSTOM_FIELD_LIMITS.url || /\s/.test(s)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  // Only the two schemes a person means by "web address" — never javascript:, data: or a file.
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!url.hostname.includes(".") || url.username || url.password) return null;
  return url.toString();
}

function parseNumber(input: unknown): number | null {
  if (typeof input === "number") return Number.isFinite(input) ? input : null;
  if (typeof input !== "string") return null;
  const cleaned = input.replace(/[,\s₹]/g, "");
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** A sentence that ends with a label: no second full stop after "Batch no.". */
export function sentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

type Coerced = { ok: true; value: CustomFieldValue | null } | { ok: false; error: string };

/**
 * One entered value made into what is stored, or the reason it can't be — `null` when it was left
 * empty. Accepts what a form sends (text from inputs, true/false from a checkbox, a list from a
 * multi-select) and what an import sends (text for everything).
 */
export function coerceValue(def: CustomFieldDef, input: unknown, existing?: CustomFieldValue): Coerced {
  if (input === undefined || input === null) return { ok: true, value: null };
  const text = typeof input === "string" ? input.trim() : input;
  if (text === "") return { ok: true, value: null };

  switch (def.type) {
    case "TEXT":
    case "LONG_TEXT": {
      if (typeof text !== "string" && typeof text !== "number") return { ok: false, error: `${def.label} should be text.` };
      const s = String(text);
      const max = def.type === "TEXT" ? CUSTOM_FIELD_LIMITS.text : CUSTOM_FIELD_LIMITS.longText;
      if (s.length > max) return { ok: false, error: `${def.label} can be ${max} characters at most.` };
      if (def.type === "TEXT" && /[\r\n]/.test(s)) return { ok: true, value: s.replace(/\s*[\r\n]+\s*/g, " ") };
      return { ok: true, value: s };
    }
    case "NUMBER":
    case "MONEY": {
      const n = parseNumber(text);
      if (n === null) return { ok: false, error: `${def.label} should be a number.` };
      if (Math.abs(n) >= CUSTOM_FIELD_LIMITS.numberMagnitude) return { ok: false, error: `${def.label} is too large.` };
      return { ok: true, value: def.type === "MONEY" ? Math.round(n * 100) / 100 : n };
    }
    case "DATE": {
      if (typeof text !== "string" || !validDay(text)) return { ok: false, error: `${def.label} should be a date.` };
      return { ok: true, value: text };
    }
    case "CHECKBOX": {
      if (typeof text === "boolean") return { ok: true, value: text };
      if (typeof text === "string") {
        const s = text.toLowerCase();
        if (["yes", "y", "true", "1", "on"].includes(s)) return { ok: true, value: true };
        if (["no", "n", "false", "0", "off"].includes(s)) return { ok: true, value: false };
      }
      return { ok: false, error: `${def.label} should be yes or no.` };
    }
    case "SELECT": {
      if (typeof text !== "string") return { ok: false, error: sentence(`Choose one of the options for ${def.label}`) };
      const option = matchOption(def, text, existing);
      if (!option) return { ok: false, error: sentence(`“${text}” isn't one of the options for ${def.label}`) };
      return { ok: true, value: option };
    }
    case "MULTI_SELECT": {
      const list = Array.isArray(text) ? text : typeof text === "string" ? text.split(/[;,|]/) : null;
      if (!list) return { ok: false, error: sentence(`Choose from the options for ${def.label}`) };
      const chosen: string[] = [];
      for (const raw of list) {
        if (typeof raw !== "string" || raw.trim() === "") continue;
        const option = matchOption(def, raw.trim(), existing);
        if (!option) return { ok: false, error: sentence(`“${raw.trim()}” isn't one of the options for ${def.label}`) };
        if (!chosen.includes(option)) chosen.push(option);
      }
      return { ok: true, value: chosen.length ? chosen : null };
    }
    case "EMAIL": {
      if (typeof text !== "string" || text.length > 254 || !EMAIL.test(text)) return { ok: false, error: `${def.label} should be an email address.` };
      return { ok: true, value: text.toLowerCase() };
    }
    case "PHONE": {
      if (typeof text !== "string" || !PHONE.test(text)) return { ok: false, error: `${def.label} should be a phone number.` };
      return { ok: true, value: text };
    }
    case "URL": {
      const url = typeof text === "string" ? webAddress(text) : null;
      if (!url) return { ok: false, error: `${def.label} should be a web address.` };
      return { ok: true, value: url };
    }
    case "USER": {
      // Which people exist is the server's to check (src/lib/custom-fields/server.ts); here, only the shape.
      if (typeof text !== "string" || !/^[a-z0-9]{8,40}$/i.test(text)) return { ok: false, error: sentence(`Choose a person for ${def.label}`) };
      return { ok: true, value: text };
    }
  }
}

/**
 * The stored value an entered answer means: an option's value, or its label typed in any case (an
 * import has labels). A retired option is accepted only when the record already holds it — it can
 * be kept, never newly chosen.
 */
function matchOption(def: CustomFieldDef, input: string, existing?: CustomFieldValue): string | null {
  const held = new Set(Array.isArray(existing) ? existing : typeof existing === "string" ? [existing] : []);
  const lower = input.toLowerCase();
  for (const o of def.options) {
    if (o.value !== input && o.label.toLowerCase() !== lower) continue;
    if (o.archived && !held.has(o.value)) return null;
    return o.value;
  }
  return null;
}

// ─── Saving what is entered ───────────────────────────────────────────────────────────────────────

export type CustomFieldError = { key: string; label: string; message: string };

export type ApplyResult = { ok: true; values: CustomFieldValues } | { ok: false; errors: CustomFieldError[] };

/**
 * The values a record is saved with, from what was entered and what it holds already.
 *
 * Only fields the person may change are taken from the input: a retired field, or a restricted one
 * for somebody without `fields.seeRestricted`, keeps exactly what the record holds — nobody can
 * clear or set a value they can't see. Keys no definition knows are kept as they were (a field
 * deleted by a script still owns its data until somebody decides otherwise). A required field must
 * be answered whenever a form shows it — `checkRequired` false for an import that didn't map it.
 */
export function applyInput(params: {
  defs: CustomFieldDef[];
  input: unknown;
  existing?: CustomFieldValues;
  canSeeRestricted: boolean;
  checkRequired?: boolean;
  /** Only these keys are being set (an import's mapped columns, an inline edit); the rest are kept. */
  only?: Iterable<string>;
  /**
   * Keys hidden from this person where the record is — a reseller's end customer's contact details —
   * kept exactly as they are and never asked for, as a restricted field is for somebody without access.
   */
  skip?: Iterable<string>;
}): ApplyResult {
  const existing = params.existing ?? {};
  const input = params.input && typeof params.input === "object" && !Array.isArray(params.input) ? (params.input as Record<string, unknown>) : {};
  const only = params.only ? new Set(params.only) : null;
  const skip = new Set(params.skip ?? []);
  const values: CustomFieldValues = { ...existing };
  const errors: CustomFieldError[] = [];

  for (const def of params.defs) {
    if (def.archived) continue;
    if (def.restricted && !params.canSeeRestricted) continue;
    if (skip.has(def.key)) continue;
    if (only && !only.has(def.key)) continue;
    // Not sent at all — a form from before the field existed, or a caller setting only some — leaves
    // the value as it is; only a value sent empty clears it. A required field still has to have one.
    if (!Object.prototype.hasOwnProperty.call(input, def.key)) {
      if (def.required && params.checkRequired !== false && isEmptyValue(existing[def.key])) {
        errors.push({ key: def.key, label: def.label, message: sentence(`Enter ${def.label}`) });
      }
      continue;
    }
    const coerced = coerceValue(def, input[def.key], existing[def.key]);
    if (!coerced.ok) {
      errors.push({ key: def.key, label: def.label, message: coerced.error });
      continue;
    }
    if (coerced.value === null || isEmptyValue(coerced.value)) {
      if (def.required && params.checkRequired !== false) errors.push({ key: def.key, label: def.label, message: sentence(`Enter ${def.label}`) });
      delete values[def.key];
    } else {
      values[def.key] = coerced.value;
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, values };
}

/** The fields a person sees, in order: retired ones never, restricted ones only with the permission. */
export function visibleDefs<D extends CustomFieldDef>(defs: D[], canSeeRestricted: boolean): D[] {
  return defs.filter((d) => !d.archived && (!d.restricted || canSeeRestricted));
}

/** Fields by heading, headings in the order their first field comes; ungrouped fields under "". */
export function groupDefs<D extends CustomFieldDef>(defs: D[]): { group: string; fields: D[] }[] {
  const groups: { group: string; fields: D[] }[] = [];
  for (const def of defs) {
    const name = def.group?.trim() ?? "";
    const found = groups.find((g) => g.group === name);
    if (found) found.fields.push(def);
    else groups.push({ group: name, fields: [def] });
  }
  return groups;
}

/** The values one person may see — what a page or an export sends; the rest never leaves the server. */
export function visibleValues(defs: CustomFieldDef[], values: CustomFieldValues, canSeeRestricted: boolean): CustomFieldValues {
  const out: CustomFieldValues = {};
  for (const def of visibleDefs(defs, canSeeRestricted)) {
    if (values[def.key] !== undefined) out[def.key] = values[def.key]!;
  }
  return out;
}

/** What a form starts with for each field it shows: the stored value, as the inputs hold it. */
export function formValues(defs: CustomFieldDef[], values: CustomFieldValues): Record<string, string | boolean | string[]> {
  const out: Record<string, string | boolean | string[]> = {};
  for (const def of defs) {
    const v = values[def.key];
    if (def.type === "CHECKBOX") out[def.key] = v === true;
    else if (def.type === "MULTI_SELECT") out[def.key] = Array.isArray(v) ? v : [];
    else out[def.key] = v === undefined || Array.isArray(v) || typeof v === "boolean" ? "" : String(v);
  }
  return out;
}

// ─── Showing what is stored ───────────────────────────────────────────────────────────────────────

const NUMBER_LABEL = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 6 });
const MONEY_LABEL = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });

/** An option's label by its stored value — a retired option's too; a value no option has reads as itself. */
export function optionLabel(def: CustomFieldDef, value: string): string {
  return def.options.find((o) => o.value === value)?.label ?? value;
}

/**
 * A stored value as words: "12 Mar 2026", "₹4,500.00", "Gold, Silver", "Yes". Empty is "". A person
 * is named through `personName` (the page knows the workspace's people); without it, or for somebody
 * since removed, "Someone no longer here".
 */
export function formatValue(def: CustomFieldDef, value: CustomFieldValue | undefined, personName?: (id: string) => string | null | undefined): string {
  if (value === undefined || isEmptyValue(value)) return "";
  switch (def.type) {
    case "CHECKBOX":
      return value === true ? "Yes" : "No";
    case "NUMBER":
      return typeof value === "number" ? NUMBER_LABEL.format(value) : String(value);
    case "MONEY":
      return typeof value === "number" ? MONEY_LABEL.format(value) : String(value);
    case "DATE":
      // The day itself, in the clock's words: Intl's en-IN September is "Sept" in Node and "Sep" in
      // some browsers, and a form renders on both.
      return typeof value === "string" && validDay(value) ? formatCalendarDay(value) : String(value);
    case "SELECT":
      return typeof value === "string" ? optionLabel(def, value) : String(value);
    case "MULTI_SELECT":
      return Array.isArray(value) ? value.map((v) => optionLabel(def, v)).join(", ") : String(value);
    case "USER":
      return typeof value === "string" ? (personName?.(value) ?? "Someone no longer here") : String(value);
    default:
      return Array.isArray(value) ? value.join(", ") : String(value);
  }
}

/** The plain text an export writes for a value — options by label, dates as yyyy-mm-dd, yes/no. */
export function exportValue(def: CustomFieldDef, value: CustomFieldValue | undefined, personName?: (id: string) => string | null | undefined): string {
  if (value === undefined || isEmptyValue(value)) return "";
  if (def.type === "DATE" && typeof value === "string") return value;
  if (def.type === "NUMBER" || def.type === "MONEY") return typeof value === "number" ? String(value) : String(value);
  if (def.type === "MULTI_SELECT" && Array.isArray(value)) return value.map((v) => optionLabel(def, v)).join("; ");
  return formatValue(def, value, personName);
}
